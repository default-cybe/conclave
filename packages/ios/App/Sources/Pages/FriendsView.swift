import ConclaveKit
import SwiftUI

/// Friends (Android FriendsScreen and FriendScreen, web features/friends): other people's Conclave
/// hubs this one trades signed, sealed notes with. Requests to answer first, then friends with their
/// state. A friend opens their notes, a note box, the safety code to compare, and Remove. Add makes a
/// one-time link to send, or uses a link a friend sent.
struct FriendsView: View {
    let hub: HubModel
    @State private var list: [Friend]?
    @State private var error: String?
    @State private var shown: Friend?
    @State private var adding = false
    @State private var line: String?

    var body: some View {
        Page(title: "Friends", sub: "Other people's hubs you trade notes and shares with") {
            Button("Add") { adding = true }.buttonStyle(CVButton(look: .solid, height: 32)).accessibilityIdentifier("add-friend")
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
            if let list {
                let ordered = FriendWords.ordered(list)
                CardSection(title: "Friends", note: "Notes are signed by each hub and sealed for the other. Compare the safety code once, by voice or in person.") {
                    if ordered.isEmpty { EmptyLine(text: "No friends yet. Add makes a link to send to a friend.") }
                    ForEach(ordered) { f in row(f) }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $shown) { f in FriendSheet(hub: hub, friend: f) { Task { await load() } } }
        .sheet(isPresented: $adding) { AddFriendSheet(hub: hub) { Task { await load() } } }
    }

    private func row(_ f: Friend) -> some View {
        let st = FriendWords.state(f)
        return HStack(spacing: 10) {
            Button { if f.status == "active" { shown = f } } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(f.name.isEmpty ? "A hub" : f.name).font(.sans(14, .medium)).foregroundStyle(Tone.fg)
                    Text([st.0, f.unread.flatMap { $0 > 0 ? "\($0) new" : nil }, f.lastError].compactMap { $0 }.joined(separator: ". "))
                        .font(.sans(12)).foregroundStyle(meetingTone(st.1)).lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if f.asked {
                Button("Accept") { Task { await act("\(f.name) is a friend now.") { _ = try await hub.client.acceptFriend(f.id) } } }.buttonStyle(CVButton(look: .solid, height: 32))
                Button("Decline") { Task { await act("Declined.") { try await hub.client.declineFriend(f.id) } } }.buttonStyle(CVButton(look: .quiet, height: 32))
            } else if f.status == "active" {
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Tone.fg3)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func act(_ ok: String, _ op: () async throws -> Void) async {
        do { try await op(); line = ok; await load() } catch { line = "That did not work. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }

    private func load() async {
        do {
            list = try await hub.client.friends()
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

/// One friend: notes both ways, newest last, a box to send one, the safety code and Remove.
private struct FriendSheet: View {
    let hub: HubModel
    @State var friend: Friend
    let changed: () -> Void
    @State private var notes: [(Int64, String, Bool)] = []
    @State private var draft = ""
    @State private var line: String?
    @State private var removing = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    CardSection(title: "Safety code", note: "Read it to them. When theirs matches, mark it verified.") {
                        CardRow(label: friend.safetyCode.isEmpty ? "No code yet" : friend.safetyCode, detail: friend.verified ? "Verified" : "Not verified") {
                            Toggle("Verified", isOn: Binding(get: { friend.verified }, set: { v in Task { await verify(v) } })).labelsHidden().tint(Tone.signal)
                        }
                    }
                    if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
                    if notes.isEmpty { EmptyLine(text: "No notes yet.") }
                    ForEach(Array(notes.enumerated()), id: \.offset) { _, n in
                        Text(n.1).font(.sans(14)).foregroundStyle(Tone.fg)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .panel(n.2 ? Tone.surface2 : Tone.raise, radius: Radius.r3, border: Tone.rule)
                            .frame(maxWidth: .infinity, alignment: n.2 ? .trailing : .leading)
                    }
                    HStack(spacing: 8) {
                        TextField("A note to \(friend.name)", text: $draft, axis: .vertical).font(.sans(14)).lineLimit(1...4)
                            .padding(.horizontal, 12).padding(.vertical, 8).panel(Tone.sunk, radius: Radius.r2, border: Tone.rule2)
                        Button("Send") { Task { await send() } }.buttonStyle(CVButton(look: .solid, height: 36))
                            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(20)
            }
            .background(Tone.bg)
            .navigationTitle(friend.name.isEmpty ? "Friend" : friend.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) { Button("Remove", role: .destructive) { removing = true } }
            }
            .alert("Remove \(friend.name)?", isPresented: $removing) {
                Button("Remove", role: .destructive) { Task { await remove() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Their hub can no longer send you notes or shares. You can ask again later.") }
        }
        .task { await loadNotes() }
    }

    private func loadNotes() async {
        let inbox = (try? await hub.client.friendInbox(friend.id)) ?? []
        let outbox = (try? await hub.client.friendOutbox(friend.id)) ?? []
        notes = (inbox.compactMap { i in i.text.map { (i.receivedAt, $0, false) } } + outbox.compactMap { o in o.text.map { (o.createdAt, $0, true) } })
            .sorted { $0.0 < $1.0 }
    }

    private func send() async {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await hub.client.sendFriendNote(friend.id, text: t)
            draft = ""
            await loadNotes()
        } catch { line = "Not sent. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }

    private func verify(_ v: Bool) async {
        do { friend = try await hub.client.verifyFriend(friend.id, v); changed() } catch { line = error.localizedDescription }
    }

    private func remove() async {
        do { try await hub.client.removeFriend(friend.id); changed(); dismiss() } catch { line = "Could not remove. " + error.localizedDescription }
    }
}

/// Add a friend: make a one-time link to send them, or paste the link they sent.
private struct AddFriendSheet: View {
    let hub: HubModel
    let added: () -> Void
    @State private var invite: FriendInvite?
    @State private var link = ""
    @State private var line: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let invite {
                        Text(invite.link).font(.mono(12)).textSelection(.enabled)
                        ShareLink(item: invite.link) { Label("Send the link", systemImage: "square.and.arrow.up") }
                        if let w = invite.warning { Text(w).foregroundStyle(Tone.warn) }
                    } else {
                        Button("Make a link") { Task { await make() } }
                    }
                } header: { Text("Your link") } footer: { Text("Good for 24 hours and for one friend.") }
                Section {
                    TextField("conclave://friend?...", text: $link).font(.mono(13)).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Ask to be friends") { Task { await accept() } }.disabled(!FriendWords.linkOK(link))
                } header: { Text("A link a friend sent") }
                if let line { Text(line).foregroundStyle(Tone.fg2) }
            }
            .navigationTitle("Add a friend").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func make() async {
        do { invite = try await hub.client.createFriendInvite() } catch { line = "No link. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }

    private func accept() async {
        do {
            let f = try await hub.client.acceptFriendInvite(link)
            line = "Asked \(f.name.isEmpty ? "their hub" : f.name). They see it on their hub."
            link = ""
            added()
        } catch { line = "That did not work. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }
}
