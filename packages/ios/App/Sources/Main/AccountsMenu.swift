import ConclaveKit
import SwiftUI

/// Switch account, inside the account menu (web components/AccountMenu.tsx): one row per paired hub or
/// account, the hub's name over the person's, a checkmark on the one in use, then Add account.
struct AccountsMenuSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Section("Switch account") {
            ForEach(Array(model.accounts.enumerated()), id: \.offset) { i, p in
                Button { model.switchTo(i) } label: {
                    if i == model.activeIndex {
                        Label {
                            Text(hubName(p))
                            if let who = person(i, p) { Text(who) }
                        } icon: {
                            Image(systemName: "checkmark")
                        }
                    } else {
                        Text(hubName(p))
                        if let who = person(i, p) { Text(who) }
                    }
                }
                .accessibilityIdentifier("account-\(i)")
            }
            Button("Add account", systemImage: "plus") { model.addAccount() }
        }
    }

    private func hubName(_ p: SavedPairing) -> String {
        p.hubName.isEmpty ? (p.addresses.first ?? "Hub").replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression) : p.hubName
    }

    /// The person: GET /api/me for the one in use, else the name the pairing reply gave. Nil for a
    /// pairing from before several accounts, which never said.
    private func person(_ i: Int, _ p: SavedPairing) -> String? {
        if i == model.activeIndex, let hub = model.hub, hub.me != nil {
            return AccountLabel.of(hub.me, uiName: hub.uiName, hubName: p.hubName).name
        }
        guard let a = p.account else { return nil }
        return a.isOwner && a.name == "owner" ? "Owner" : a.name
    }
}

/// Add account: Connect in a sheet over the hub in use, which stays signed in. Cancel (or a swipe
/// down) comes back; a pairing that works closes it and switches to the new account.
private struct AddAccountSheet: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        @Bindable var model = model
        content.sheet(isPresented: $model.adding, onDismiss: { model.addClosed() }) {
            NavigationStack {
                ConnectView()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { model.adding = false }
                        }
                    }
            }
            .environment(model)
        }
    }
}

extension View {
    /// Shows Connect while AppModel.adding: put it once on a view that stays on screen with the hub.
    func addAccountSheet() -> some View { modifier(AddAccountSheet()) }
}
