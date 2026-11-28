import ConclaveKit
import SwiftUI

/// Settings > People (web settings/people.tsx), owner only: everyone on the hub; add a member with a
/// password or an invite link; per member a new invite, a new password, a workspace code, the hub's
/// web search, which hub keys they may use with a monthly cap, turn off or on, and remove.
struct PeopleView: View {
    let hub: HubModel
    let back: () -> Void
    @State private var people: [Person]?
    @State private var adding = false
    @State private var open: Person?
    @State private var shown: Shown?
    @State private var line: String?
    @State private var error: String?

    var body: some View {
        Page(title: "People", sub: people.map { "\($0.count) on this hub" }) {
            HStack(spacing: 8) {
                Button("Add") { adding = true }.buttonStyle(CVButton(look: .solid, height: 32)).accessibilityIdentifier("add-person")
                SettingsBack(back: back)
            }
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
            if let people {
                let now = Int64(Date().timeIntervalSince1970 * 1000)
                CardSection(title: "Everyone", note: "Members get their own chats, memory, computers and keys. They use the hub's keys only where you allow it.") {
                    ForEach(people) { p in
                        Button { if !p.isOwner { open = p } } label: {
                            CardRow(label: p.shownName + (p.isOwner ? "  owner" : ""), detail: ([p.name == p.shownName ? nil : p.name, PeopleWords.signIn(p, now: now), "\(p.apps) apps, \(p.devices) computers"] + PeopleWords.spend(p)).compactMap { $0 }.joined(separator: ". ")) {
                                if !p.isOwner { Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Tone.fg3) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(QuietPress(radius: 0)).disabled(p.isOwner)
                    }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .task { await load() }
        .sheet(isPresented: $adding) { AddPersonSheet(hub: hub) { created in Task { await load() }; if let i = created.invite { shown = Shown(title: "Invite link for \(created.person.shownName)", lines: [i.url], note: "Shown once, good once, for 7 days. Send it to them; they set a password with it.") } } }
        .sheet(item: $open) { p in PersonSheet(hub: hub, person: p, changed: { Task { await load() } }, show: { shown = $0 }) }
        .sheet(item: $shown) { s in ShownSheet(shown: s) }
    }

    private func load() async {
        do {
            people = try await hub.client.people()
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

/// Something the hub shows once (an invite link, a workspace code): copy it now.
struct Shown: Identifiable {
    let id = UUID()
    let title: String
    let lines: [String]
    let note: String
}

private struct ShownSheet: View {
    let shown: Shown
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(shown.note).font(.sans(13)).foregroundStyle(Tone.fg3)
                    CodeBlockView(language: "", text: shown.lines.joined(separator: "\n"))
                    Button("Copy") { UIPasteboard.general.string = shown.lines.joined(separator: "\n") }.buttonStyle(CVButton(look: .outline, height: 36))
                }
                .padding(20)
            }
            .background(Tone.bg)
            .navigationTitle(shown.title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct AddPersonSheet: View {
    let hub: HubModel
    let done: (PersonCreated) -> Void
    @State private var name = ""
    @State private var shownName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let n = name.trimmingCharacters(in: .whitespaces)
        let pwOK = password.isEmpty || PeopleWords.passwordOK(password)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    field("Sign-in name", "sam", $name, help: n.isEmpty || PeopleWords.nameOK(n) ? "One word they sign in with." : "Lowercase letters, digits, dots, dashes and underscores.", bad: !n.isEmpty && !PeopleWords.nameOK(n))
                    field("Name to show", "Sam Lee", $shownName, help: "What the apps call them. Empty: the sign-in name.")
                    field("Email", "sam@example.com", $email, help: "Optional.")
                    Text("Password").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).padding(.top, 6)
                    SecureField("", text: $password).font(.sans(14)).padding(.horizontal, 12).frame(height: 40)
                        .panel(Tone.sunk, radius: Radius.r2, border: pwOK ? Tone.rule2 : Tone.fault).accessibilityLabel("Password")
                    Text(pwOK ? "Empty: an invite link they set it with. Or 12 characters or more now." : "12 characters or more.").font(.sans(12)).foregroundStyle(pwOK ? Tone.fg3 : Tone.fault)
                    if let error { Text(error).font(.sans(12.5)).foregroundStyle(Tone.fault) }
                }
                .padding(20)
            }
            .background(Tone.bg)
            .navigationTitle("Add a person").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Adding" : "Add") { Task { await add(n) } }.disabled(busy || !PeopleWords.nameOK(n) || !pwOK)
                }
            }
        }
    }

    private func field(_ label: String, _ hint: String, _ text: Binding<String>, help: String, bad: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).padding(.top, 6)
            TextField(hint, text: text).font(.sans(14)).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(.horizontal, 12).frame(height: 40).panel(Tone.sunk, radius: Radius.r2, border: bad ? Tone.fault : Tone.rule2)
            Text(help).font(.sans(12)).foregroundStyle(bad ? Tone.fault : Tone.fg3)
        }
    }

    private func add(_ n: String) async {
        busy = true
        defer { busy = false }
        do {
            let r = try await hub.client.addPerson(name: n, displayName: shownName, email: email, password: password.isEmpty ? nil : password)
            dismiss()
            done(r)
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

/// One member: sign-in, keys and caps, web search, and the actions that change who they are.
private struct PersonSheet: View {
    let hub: HubModel
    @State var person: Person
    let changed: () -> Void
    let show: (Shown) -> Void
    @State private var resetting = false
    @State private var newPassword = ""
    @State private var confirmOff = false
    @State private var confirmRemove = false
    @State private var line: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
                    CardSection(title: "Sign in") {
                        CardRow(person.name, PeopleWords.signIn(person, now: now))
                        CardRow(label: "Invite link", detail: "A new link, shown once, good for 7 days. An older one stops working.") {
                            Button("New link") { Task { await act { let i = try await hub.client.newInvite(person.id); show(Shown(title: "Invite link for \(person.shownName)", lines: [i.url], note: "Shown once, good once, for 7 days.")) } } }
                                .buttonStyle(CVButton(look: .outline, height: 32))
                        }
                        CardRow(label: "Password", detail: "Set a new one. Their apps sign out.") {
                            Button("Set") { resetting = true }.buttonStyle(CVButton(look: .outline, height: 32))
                        }
                        CardRow(label: "Workspace", detail: "A computer of their own on the hub machine: run the commands there.") {
                            Button("Code") { Task { await act { let w = try await hub.client.workspaceCode(person.id); show(Shown(title: "Workspace for \(person.shownName)", lines: w.commands.linux.isEmpty ? [w.code] : w.commands.linux, note: "Run on the hub machine. The code works once, for 10 minutes.")) } } }
                                .buttonStyle(CVButton(look: .outline, height: 32))
                        }
                    }
                    CardSection(title: "The hub's keys", note: "Which of the hub's keys \(person.shownName) may use, and a monthly cap in dollars. Their own keys and plans are theirs.") {
                        ForEach(Providers.keyed.filter { person.providers.keys.contains($0.id) || person.spend.contains(where: { s in s.provider == $0.id }) }) { k in
                            CardRow(label: k.name, detail: person.spend.first { $0.provider == k.id }.map { String(format: "$%.2f this month", $0.spentUsd) }) {
                                Toggle(k.name, isOn: Binding(get: { person.providers.keys.contains(k.id) }, set: { on in Task { await grant(k.id, on) } })).labelsHidden().tint(Tone.signal)
                            }
                        }
                        Menu {
                            ForEach(Providers.keyed.filter { !person.providers.keys.contains($0.id) }) { k in Button(k.name) { Task { await grant(k.id, true) } } }
                        } label: { CardRow(label: "Allow another key") { Image(systemName: "plus").foregroundStyle(Tone.fg3) }.contentShape(Rectangle()) }
                        CardRow(label: "Web search", detail: "Use the hub's web search when they have no key of their own.") {
                            Toggle("Web search", isOn: Binding(get: { person.webSearch }, set: { v in Task { await patch(["webSearch": .bool(v)]) } })).labelsHidden().tint(Tone.signal)
                        }
                    }
                    CardSection(title: "Access") {
                        CardRow(label: person.disabled ? "Turn on" : "Turn off", detail: person.disabled ? "They can sign in and work again." : "Their work stops and their apps and computers are cut off at once. Nothing is deleted.") {
                            Button(person.disabled ? "Turn on" : "Turn off") { if person.disabled { Task { await setOff(false) } } else { confirmOff = true } }
                                .buttonStyle(CVButton(look: person.disabled ? .outline : .quietFault, height: 32))
                        }
                        CardRow(label: "Remove", detail: "Removes \(person.shownName) and everything that is theirs. This cannot be undone.") {
                            Button("Remove") { confirmRemove = true }.buttonStyle(CVButton(look: .quietFault, height: 32))
                        }
                    }
                }
                .padding(20)
            }
            .background(Tone.bg)
            .navigationTitle(person.shownName).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .alert("New password for \(person.shownName)", isPresented: $resetting) {
            SecureField("12 characters or more", text: $newPassword)
            Button("Set") { Task { await act { person = try await hub.client.resetPersonPassword(person.id, newPassword); line = "Password set. Their apps signed out."; changed() }; newPassword = "" } }
                .disabled(!PeopleWords.passwordOK(newPassword))
            Button("Cancel", role: .cancel) { newPassword = "" }
        }
        .alert("Turn off \(person.shownName)?", isPresented: $confirmOff) {
            Button("Turn off", role: .destructive) { Task { await setOff(true) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Their work stops and their apps and computers are cut off at once. Nothing is deleted.") }
        .alert("Remove \(person.shownName)?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { Task { await act { try await hub.client.removePerson(person.id); changed(); dismiss() } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Their chats, memory, computers and keys are deleted. This cannot be undone.") }
    }

    private func act(_ op: () async throws -> Void) async {
        do { try await op() } catch { line = "Failed. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }

    private func patch(_ p: JSONObject) async {
        await act { person = try await hub.client.updatePerson(person.id, p); changed() }
    }

    /// Allow a hub key with no cap, or take it away; the others keep their caps.
    private func grant(_ id: String, _ on: Bool) async {
        var g: JSONObject = [:]
        for (k, cap) in person.providers where k != id { g[k] = .object(cap.map { ["monthlyUsd": .number($0)] } ?? [:]) }
        if on { g[id] = .object([:]) }
        await patch(["providers": .object(g)])
    }

    private func setOff(_ off: Bool) async {
        await act { person = try await hub.client.setPersonDisabled(person.id, off); changed() }
    }
}
