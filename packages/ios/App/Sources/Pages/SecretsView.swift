import ConclaveKit
import SwiftUI

/// Settings > Secrets (web settings/secrets.tsx): named secrets for MCP servers, used as
/// ${secret:name}. Add, Replace and Delete; the value is never shown again. The ones other pages
/// manage are listed read-only. A member's are their own.
struct SecretsView: View {
    let hub: HubModel
    let member: Bool
    let back: () -> Void
    @State private var list: [SecretInfo]?
    @State private var editing: SecretEdit?
    @State private var deleting: String?
    @State private var line: String?
    @State private var error: String?

    var body: some View {
        Page(title: "Secrets", sub: "Tokens MCP servers use by name") {
            SettingsBack(back: back)
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
            if let list {
                let now = Int64(Date().timeIntervalSince1970 * 1000)
                let own = list.filter { $0.managedBy == nil }
                let managed = list.filter { $0.managedBy != nil }
                CardSection(title: "Your secrets", note: "Use one in an MCP server's env, headers, args or URL as ${secret:name}. The value stays on the hub and is never shown again.") {
                    if own.isEmpty { EmptyLine(text: "No secrets yet. Save a token here once, then point a server at it by name.") }
                    ForEach(own) { s in
                        CardRow(label: s.name, detail: SecretWords.meta(s, now: now)) {
                            HStack(spacing: 4) {
                                Button("Replace") { editing = SecretEdit(name: s.name) }.buttonStyle(CVButton(look: .quiet, height: 32))
                                Button("Delete") { deleting = s.name }.buttonStyle(CVButton(look: .quietFault, height: 32))
                            }
                        }
                    }
                    Button { editing = SecretEdit(name: nil) } label: {
                        CardRow(label: "Add a secret") { Image(systemName: "plus").foregroundStyle(Tone.fg3) }.contentShape(Rectangle())
                    }
                    .buttonStyle(QuietPress(radius: 0)).accessibilityIdentifier("add-secret")
                }
                if !managed.isEmpty {
                    CardSection(title: "Set by other pages", note: member ? "Other pages save these in your account. Change them where they are set." : "The hub saves these for itself. Change them where they are set.") {
                        ForEach(managed) { s in CardRow(label: s.name, detail: SecretWords.meta(s, now: now)) { RowValue(text: s.managedBy ?? "") } }
                    }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .task { await load() }
        .sheet(item: $editing) { e in
            SecretSheet(edit: e, taken: (list ?? []).map(\.name)) { name, value in Task { await save(name, value) } }
        }
        .alert("Delete \(deleting ?? "")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { name in
            Button("Delete", role: .destructive) { Task { await save(name, nil) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Servers that use it stop getting it.")
        }
    }

    private func load() async {
        do {
            list = try await hub.client.secrets(member: member)
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func save(_ name: String, _ value: String?) async {
        do {
            try await hub.client.setSecret(name, value, member: member)
            line = value == nil ? "\(name) deleted." : "\(name) saved."
            await load()
        } catch {
            line = "Could not save. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription)
        }
    }
}

struct SecretEdit: Identifiable {
    let id = UUID()
    /// nil: Add a secret; a name: Replace it.
    let name: String?
}

private struct SecretSheet: View {
    let edit: SecretEdit
    let taken: [String]
    let save: (String, String) -> Void
    @State private var name = ""
    @State private var value = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let slug = (edit.name ?? name).trimmingCharacters(in: .whitespaces)
        let nameError = edit.name == nil ? SecretWords.nameError(slug, taken: taken) : nil
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                if edit.name == nil {
                    Text("Name").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3)
                    TextField("github-token", text: $name).font(.mono(13)).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(.horizontal, 12).frame(height: 40).panel(Tone.sunk, radius: Radius.r2, border: nameError == nil ? Tone.rule2 : Tone.fault)
                    Text(nameError ?? (slug.isEmpty ? "Lowercase letters, digits, dots, dashes and underscores." : "Use it as ${secret:\(slug)}."))
                        .font(.sans(12)).foregroundStyle(nameError == nil ? Tone.fg3 : Tone.fault)
                }
                Text("Value").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).padding(.top, 6)
                SecureField("", text: $value).font(.mono(13))
                    .padding(.horizontal, 12).frame(height: 40).panel(Tone.sunk, radius: Radius.r2, border: Tone.rule2)
                    .accessibilityLabel("Value")
                Text("Saved on the hub only. It is never shown again.").font(.sans(12)).foregroundStyle(Tone.fg3)
                Spacer()
            }
            .padding(20)
            .background(Tone.bg)
            .navigationTitle(edit.name.map { "Replace \($0)" } ?? "Add a secret")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(slug, value); dismiss() }.disabled(slug.isEmpty || nameError != nil || value.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
