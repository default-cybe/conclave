import ConclaveKit
import SwiftUI

/// Settings > Signed in (web settings/signedin.tsx): the phones, browsers and desktop app you signed
/// in with, each with Sign out. This device is marked; signing it out forgets the hub here.
struct SignedInSection: View {
    let hub: HubModel
    @Environment(AppModel.self) private var model
    @State private var apps: [SignedInApp]?
    @State private var ending: SignedInApp?
    @State private var error: String?

    var body: some View {
        CardSection(title: "Signed in", note: "Phones, browsers and the desktop app you signed in with. They only talk to the hub; your computers run the work.") {
            if let apps {
                if apps.isEmpty { EmptyLine(text: "No apps yet") }
                let now = Int64(Date().timeIntervalSince1970 * 1000)
                ForEach(apps) { a in
                    CardRow(label: a.name.isEmpty ? a.kind : a.name + (here(a) ? "  This device" : ""), detail: a.line(now: now)) {
                        Button("Sign out") { ending = a }.buttonStyle(CVButton(look: .outline, height: 32))
                    }
                }
            } else if let error {
                ErrorBox(message: error) { Task { await load() } }
            } else {
                LoadingLine()
            }
        }
        .task { await load() }
        .alert(ending.map { here($0) ? "Sign out of this device?" : "Sign out \($0.name)?" } ?? "", isPresented: Binding(get: { ending != nil }, set: { if !$0 { ending = nil } }), presenting: ending) { a in
            Button("Sign out", role: .destructive) { Task { await end(a) } }
            Button("Cancel", role: .cancel) {}
        } message: { a in
            Text(here(a) ? "This device forgets the sign in. Your chats and memory stay on the hub." : "It stops getting approvals and notifications. Sign in on it again to bring it back.")
        }
    }

    private func here(_ a: SignedInApp) -> Bool { a.id == model.pairing?.clientId }

    private func load() async {
        do {
            apps = try await hub.client.signedInApps().filter { !$0.revoked }
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func end(_ a: SignedInApp) async {
        if here(a) { await model.signOut(); return }
        do {
            try await hub.client.signOut(clientId: a.id)
            apps?.removeAll { $0.id == a.id }
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}
