import ConclaveKit
import SwiftUI
import UIKit

/// The session actions the web's menus have (Sidebar.tsx row menu, ChatView.tsx session menu): Stop, Rename,
/// Pin, Fork, Model, Archive and Delete. Menu content only, for `Menu {}` and `.contextMenu {}`; Rename and
/// Delete ask through `sheets`, which `.sessionActionSheets(hub:sheets:)` shows once outside the menu.
///
/// `opened(id)` after Fork, with the new session to open; `opened(nil)` after Archive or Delete, so the caller
/// closes the chat when it was the open one (it is not in the list any more).
///
/// A sidebar row:
///
///     @State private var sheets = SessionSheets()        // once, in SidebarView
///     SideRow(...) { ... }
///         .contextMenu {
///             if let s = hub.session(item.id) {
///                 SessionMenu(hub: hub, session: s, sheets: sheets) { id in
///                     if let id { selection = id } else if selection == item.id { selection = nil }
///                 }
///             }
///         }
///     // on the ScrollView (outside every row):
///     .sessionActionSheets(hub: hub, sheets: sheets)
struct SessionMenu: View {
    let hub: HubModel
    let session: Session
    let sheets: SessionSheets
    let opened: (String?) -> Void

    var body: some View {
        if [.running, .waitingApproval, .waitingInput].contains(session.status) {
            Button("Stop", systemImage: "stop.circle") { Task { await sheets.stop(session.id, hub: hub) } }
        }
        Button("Rename", systemImage: "pencil") { sheets.rename(session) }
        Button(session.pinned ? "Unpin" : "Pin", systemImage: session.pinned ? "pin.slash" : "pin") {
            Task { await hub.update(session.id, SessionPatch(pinned: !session.pinned)) }
        }
        Button("Fork", systemImage: "arrow.triangle.branch") {
            Task { if let id = await sheets.fork(session.id, hub: hub) { opened(id) } }
        }
        let groups = ModelPicks.groups(hub.models)
        if !groups.isEmpty {
            // the composer's ModelMenu reads the list; a pick is the chat's default from now on, as there
            Menu {
                ForEach(groups, id: \.key) { g in
                    Section(g.name) {
                        ForEach(g.rows, id: \.ref) { r in
                            Button { Task { await hub.update(session.id, SessionPatch(model: r.ref)) } } label: {
                                if r.ref == session.model { Label(r.label, systemImage: "checkmark") } else { Text(r.label) }
                            }
                            .disabled(r.model.unavailable != nil)
                        }
                    }
                }
            } label: { Label("Model", systemImage: "cpu") }
        }
        Section {
            Button(session.archived ? "Unarchive" : "Archive", systemImage: session.archived ? "tray.and.arrow.up" : "archivebox") {
                Task { if await sheets.archive(session, hub: hub) { opened(nil) } }
            }
            Button("Delete", systemImage: "trash", role: .destructive) { sheets.askDelete(session, then: opened) }
        }
    }
}

/// What the session menu asks before it acts (a new title, Delete's confirmation) and why an action failed.
/// One per screen, shared by its menus, shown by `.sessionActionSheets(hub:sheets:)`.
@MainActor @Observable
final class SessionSheets {
    var renaming: Session?
    var title = ""
    var deleting: Session?
    var error: String?
    @ObservationIgnored private var afterDelete: ((String?) -> Void)?

    var renameShown: Bool {
        get { renaming != nil }
        set { if !newValue { renaming = nil } }
    }

    var deleteShown: Bool {
        get { deleting != nil }
        set { if !newValue { deleting = nil } }
    }

    var errorShown: Bool {
        get { error != nil }
        set { if !newValue { error = nil } }
    }

    func rename(_ s: Session) {
        title = s.title
        renaming = s
    }

    func saveRename(hub: HubModel) {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let s = renaming, !t.isEmpty, t != s.title else { renaming = nil; return }
        renaming = nil
        Task { await hub.update(s.id, SessionPatch(title: t)) }
    }

    func askDelete(_ s: Session, then: @escaping (String?) -> Void) {
        afterDelete = then
        deleting = s
    }

    func delete(_ s: Session, hub: HubModel) async {
        do {
            try await hub.client.deleteSession(s.id)
            hub.apply(.sessionDeleted(sessionId: s.id))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            afterDelete?(nil)
        } catch {
            self.error = Self.words(error)
        }
        afterDelete = nil
    }

    /// The new session's id; it joins the list at once. `fromSeq`: only the messages up to it.
    func fork(_ id: String, hub: HubModel, fromSeq: Int64? = nil) async -> String? {
        do {
            let s = try await hub.client.forkSession(id, fromSeq: fromSeq)
            hub.apply(.sessionCreated(s))
            return s.id
        } catch {
            self.error = Self.words(error)
            return nil
        }
    }

    /// True once archived: it leaves the list (which holds only unarchived sessions). Unarchive brings it back.
    func archive(_ s: Session, hub: HubModel) async -> Bool {
        do {
            let next = try await hub.client.updateSession(s.id, SessionPatch(archived: !s.archived))
            hub.apply(next.archived ? .sessionDeleted(sessionId: s.id) : .sessionUpdated(next))
            return next.archived
        } catch {
            self.error = Self.words(error)
            return false
        }
    }

    func stop(_ id: String, hub: HubModel) async {
        do { try await hub.client.abort(id) } catch { self.error = Self.words(error) }
    }

    private static func words(_ e: Error) -> String { (e as? ConclaveAPIError)?.message ?? e.localizedDescription }
}

extension View {
    /// The rename alert, Delete's confirmation and the error line of the session menus that share `sheets`.
    /// Attach once, outside any row or menu.
    func sessionActionSheets(hub: HubModel, sheets: SessionSheets) -> some View {
        modifier(SessionActionSheets(hub: hub, sheets: sheets))
    }
}

private struct SessionActionSheets: ViewModifier {
    let hub: HubModel
    @Bindable var sheets: SessionSheets

    func body(content: Content) -> some View {
        content
            .alert("Rename", isPresented: $sheets.renameShown) {
                TextField("Title", text: $sheets.title)
                Button("Cancel", role: .cancel) {}
                Button("Save") { sheets.saveRename(hub: hub) }
            }
            .alert("Delete this chat?", isPresented: $sheets.deleteShown, presenting: sheets.deleting) { s in
                Button("Delete", role: .destructive) { Task { await sheets.delete(s, hub: hub) } }
                Button("Cancel", role: .cancel) {}
            } message: { s in
                Text("\(s.title.isEmpty ? "This chat" : "\u{201C}\(s.title)\u{201D}") and its messages are deleted. This cannot be undone.")
            }
            .alert("That did not work", isPresented: $sheets.errorShown) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(sheets.error ?? "")
            }
    }
}
