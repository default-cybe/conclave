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
        // v0.4.112: Compact, Checkpoints and Share as Markdown, as the web menu and Android's session sheet
        if session.status == .idle || session.status == .error {
            Button("Compact", systemImage: "arrow.down.right.and.arrow.up.left") { Task { await sheets.compact(session.id, hub: hub) } }
        }
        if !session.isChat {
            Button("Checkpoints", systemImage: "clock.arrow.circlepath") { sheets.checkpointsFor = session.id }
        } else {
            Button("Move to Code", systemImage: "chevron.left.forwardslash.chevron.right") { sheets.moveToCode(session, then: opened) }
        }
        Button("Share as Markdown", systemImage: "square.and.arrow.up") { Task { await sheets.export(session.id, hub: hub) } }
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
        // a chat runs the chat agent on the hub; agent sessions can change both (web session menu, Android ContinueSheet)
        if !session.isChat {
            let agents = AgentPicks.switchable(hub.agents)
            if !agents.isEmpty {
                Menu {
                    ForEach(agents) { a in
                        Button { Task { await sheets.place(session.id, SessionPlacePatch(agent: a.name), hub: hub) } } label: {
                            if a.name == session.agent { Label(AgentPicks.label(a.name), systemImage: "checkmark") } else { Text(AgentPicks.label(a.name)) }
                        }
                    }
                } label: { Label("Agent", systemImage: "person.crop.square") }
            }
            let computers = FolderWords.computers(hub.devices)
            if computers.count > 1 {
                Menu {
                    ForEach(computers) { d in
                        Button { Task { await sheets.move(session.id, to: d.id, hub: hub) } } label: {
                            if d.id == session.device { Label(FolderWords.placeName(d), systemImage: "checkmark") } else { Text(FolderWords.placeName(d)) }
                        }
                        .disabled(!d.online && d.id != "local")
                    }
                } label: { Label("Run on", systemImage: "desktopcomputer") }
            }
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
    /// What the hub said after an action that worked (Compact, a restore, a command).
    var notice: String?
    /// The session whose checkpoints are open.
    var checkpointsFor: String?
    /// The Markdown of an export, for the share sheet.
    var exported: ExportedText?
    /// The chat Move to Code is open for.
    var moving: Session?
    @ObservationIgnored private var afterDelete: ((String?) -> Void)?
    @ObservationIgnored var afterMove: ((String?) -> Void)?

    func moveToCode(_ s: Session, then: @escaping (String?) -> Void) {
        afterMove = then
        moving = s
    }

    var noticeShown: Bool {
        get { notice != nil }
        set { if !newValue { notice = nil } }
    }

    func compact(_ id: String, hub: HubModel) async {
        do {
            let r = try await hub.client.runCommand(id, line: "/compact")
            notice = r.output?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Compacted."
        } catch {
            self.error = Self.words(error)
        }
    }

    func export(_ id: String, hub: HubModel) async {
        do {
            let r = try await hub.client.exportSession(id)
            exported = ExportedText(text: r.content)
        } catch {
            self.error = Self.words(error)
        }
    }

    func restore(_ id: String, _ cp: Checkpoint, hub: HubModel) async {
        do {
            try await hub.client.restoreCheckpoint(id, checkpointId: cp.id)
            checkpointsFor = nil
            notice = "Files restored. The chat is unchanged."
        } catch {
            self.error = Self.words(error)
        }
    }

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

    /// A new agent for the session; the hub's words when it refuses.
    func place(_ id: String, _ patch: SessionPlacePatch, hub: HubModel) async {
        if let why = await hub.place(id, patch) { error = why }
    }

    /// Run the session on another computer: the hub finds the same folder there (POST move); when it
    /// finds none, its line says why and the session stays where it was.
    func move(_ id: String, to device: String, hub: HubModel) async {
        do {
            let r = try await hub.client.moveSession(id, device: device)
            if let s = r.session { hub.apply(.sessionUpdated(s)) }
            if !r.resolved { error = r.line.isEmpty ? "It did not move." : r.line }
        } catch {
            self.error = Self.words(error)
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

struct ExportedText: Identifiable {
    var text: String
    var id: String { text }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// Checkpoints (Android session sheet, web ContextPanel): each with "Restore files only", which
/// keeps every message, behind a confirmation.
private struct CheckpointsSheet: View {
    let hub: HubModel
    let sessionId: String
    let sheets: SessionSheets
    @State private var list: [Checkpoint]?
    @State private var confirm: Checkpoint?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let list {
                        if list.isEmpty {
                            Text("No checkpoints yet. The hub takes one before each file change.").font(.sans(14)).foregroundStyle(Tone.fg3).padding(20)
                        }
                        let now = Int64(Date().timeIntervalSince1970 * 1000)
                        ForEach(list) { cp in
                            HStack {
                                Text([Ago.short(cp.createdAt, now: now), cp.files == 1 ? "1 file" : "\(cp.files) files", String(cp.commit.prefix(7))].joined(separator: " \u{00B7} "))
                                    .font(.sans(14)).monospacedDigit().foregroundStyle(Tone.fg)
                                Spacer()
                                Button("Restore files only") { confirm = cp }.buttonStyle(CVButton(look: .outline, height: 36))
                            }
                            .padding(.horizontal, 20).padding(.vertical, 8)
                            Rectangle().fill(Tone.rule).frame(height: 1).padding(.leading, 20)
                        }
                    } else {
                        LoadingLine().padding(20)
                    }
                }
            }
            .background(Tone.bg)
            .navigationTitle("Checkpoints")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .task { list = ((try? await hub.client.checkpoints(sessionId)) ?? []).sorted { $0.createdAt > $1.createdAt } }
        .alert("Restore files only?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), presenting: confirm) { cp in
            Button("Restore files", role: .destructive) { Task { await sheets.restore(sessionId, cp, hub: hub) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Files go back to how they were at this checkpoint. Every message stays.")
        }
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
            .alert("Done", isPresented: $sheets.noticeShown) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(sheets.notice ?? "")
            }
            .sheet(item: Binding(get: { sheets.checkpointsFor.map(ExportedText.init(text:)) }, set: { sheets.checkpointsFor = $0?.text })) { s in
                CheckpointsSheet(hub: hub, sessionId: s.text, sheets: sheets)
            }
            .sheet(item: $sheets.exported) { e in ShareSheet(items: [e.text]).presentationDetents([.medium, .large]) }
            .sheet(item: $sheets.moving) { s in
                MoveToCodeSheet(hub: hub, chat: s) { id in sheets.afterMove?(id) }
            }
            .alert("That did not work", isPresented: $sheets.errorShown) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(sheets.error ?? "")
            }
    }
}
