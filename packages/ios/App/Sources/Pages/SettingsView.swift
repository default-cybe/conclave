import ConclaveKit
import SwiftUI

/// Settings essentials (Android SettingsScreen, web Settings): Account, Defaults (your own, from
/// /api/me, as members have since 0.4.106), Appearance and About. Cards, not an iOS grouped Form.
struct SettingsView: View {
    let hub: HubModel
    @Environment(AppModel.self) private var model
    @AppStorage("theme") private var theme = "system"
    @AppStorage("reduceMotion") private var reduceMotion = false
    @State private var error: String?
    @State private var confirmForget = false

    static let sourceURL = "https://github.com/default-cybe/conclave/releases/download/ios-preview/sidestore-source.json"
    static let releaseURL = URL(string: "https://github.com/default-cybe/conclave/releases/tag/ios-preview")!

    var body: some View {
        Page(title: "Settings") {
            CardSection(title: "Account") {
                CardRow("Signed in as", me.map { "\(account.name), \($0.isMember ? "member" : "owner")" } ?? "…")
                if let email = me?.email, !email.isEmpty { CardRow("Email", email) }
                CardRow("Hub", info?.name.isEmpty == false ? info!.name : model.pairing?.hubName ?? "Conclave")
                CardRow("Address", model.pairing?.addresses.first ?? "", mono: true)
                CardRow(label: "Sign out", detail: "Signs this device out on the hub and forgets it here. Pair again to come back.") {
                    Button("Sign out") { confirmForget = true }.buttonStyle(CVButton(look: .quietFault))
                        .accessibilityIdentifier("sign-out")
                }
            }
            CardSection(title: "Defaults", note: "Your own default, used for new chats. Empty uses the hub's default.") {
                CardRow(label: "Default model", detail: me?.preferences.defaultModel == nil ? info.map { "Hub default: \(ModelRefs.displayName($0.defaultModel))" } : nil) {
                    modelMenu
                }
            }
            // the hub's own settings: a member sees none of them (v0.4.112)
            if me?.isMember == false { HubSettingsSections(hub: hub) }
            CardSection(title: "Appearance") {
                CardRow(label: "Theme") {
                    Segmented(options: [("system", "System"), ("light", "Light"), ("dark", "Dark")], selection: $theme)
                }
                CardRow(label: "Reduce motion", detail: "Cards and messages appear without moving. The system setting also turns it on.") {
                    Toggle("", isOn: $reduceMotion).labelsHidden().tint(Tone.signal)
                }
            }
            CardSection(title: "About") {
                CardRow("App version", AppLogs.version)
                CardRow("Hub version", info?.version.isEmpty == false ? info!.version : "…")
                CardRow(label: "Updates", detail: "SideStore updates the app from the Conclave source.") {
                    Link("Check for updates", destination: Self.releaseURL).font(.sans(13, .medium)).foregroundStyle(Tone.signal)
                }
                CardRow(label: "SideStore source") {
                    Button {
                        UIPasteboard.general.string = Self.sourceURL
                    } label: {
                        Text("Copy").font(.sans(13, .medium))
                    }
                    .buttonStyle(CVButton(look: .outline, height: 28))
                }
            }
            if let error { Text(error).font(.sans(12.5)).foregroundStyle(Tone.fault) }
        }
        .task {
            await hub.loadModels()
            await hub.loadAccount()
        }
        .refreshable { await hub.loadAccount() }
        .confirmationDialog("Sign out of this hub?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
        } message: {
            Text("The hub stops accepting this device's token and the app forgets the hub. Chats stay on the hub.")
        }
    }

    private var me: Me? { hub.me }
    private var info: HubInfo? { hub.info }
    private var account: AccountLabel { AccountLabel.of(me, uiName: hub.uiName, hubName: info?.name ?? "") }

    private var modelMenu: some View {
        let current = me?.preferences.defaultModel
        return Menu {
            Button("Hub default") { Task { await set(nil) } }
            ForEach(hub.models.filter { $0.enabled && $0.configured }, id: \.provider) { g in
                Section(g.name.isEmpty ? g.provider : g.name) {
                    ForEach(g.models) { m in
                        Button { Task { await set(m.ref) } } label: {
                            if m.ref == current { Label(m.name, systemImage: "checkmark") } else { Text(m.name) }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(current.map { ref in hub.models.flatMap(\.models).first { $0.ref == ref }?.name ?? ModelRefs.displayName(ref) } ?? "Hub default")
                    .font(.sans(13, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Tone.fg3)
            }
            .padding(.horizontal, 10).frame(height: 28)
            .panel(.clear, radius: Radius.r2, border: Tone.rule2)
        }
        .accessibilityIdentifier("default-model")
    }

    private func set(_ ref: String?) async {
        do {
            try await hub.client.setDefaultModel(ref)
            hub.setMe(try await hub.client.me())
            error = nil
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}
