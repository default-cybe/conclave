import ConclaveKit
import SwiftUI

/// The address in use answered with another key or a bad signature, so nothing with the token went
/// there (Android IdentityScreen). Over everything until an address proves the key or you pair again.
struct NotYourHubView: View {
    @Environment(AppModel.self) private var model
    let address: String
    @State private var choosing = false

    var body: some View {
        let others = model.pairing?.addresses.filter { $0 != address } ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Image(systemName: "lock.trianglebadge.exclamationmark")
                    .font(.system(size: 40))
                    .foregroundStyle(Tone.fault)
                Text("This address is not your hub.").font(.title.weight(.semibold))
                Text("Conclave did not send your sign-in.").foregroundStyle(Tone.fg2)
                Text(HubAddresses.host(address).isEmpty ? address : HubAddresses.host(address))
                    .font(.callout.monospaced())
                    .foregroundStyle(Tone.fg3)
                Text("Another machine answers at this address, perhaps on a network that reuses it. Use another address of your hub, or pair again.")
                    .foregroundStyle(Tone.fg3)
                if !choosing {
                    Button("Try another address") { choosing = true }
                        .buttonStyle(.borderedProminent)
                        .frame(maxWidth: .infinity)
                } else if others.isEmpty {
                    Text("No other address is saved for your hub.").foregroundStyle(Tone.fg2)
                } else {
                    ForEach(others, id: \.self) { url in
                        Button {
                            model.use(url)
                        } label: {
                            Label(url, systemImage: "chevron.right").font(.callout.monospaced())
                        }
                    }
                }
                Button("Pair again") { model.forget() }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
    }
}

/// After a password login, once: the hub's fingerprint in groups of four, to compare with
/// Settings on the hub. There was no code to check it against.
struct FingerprintSheet: View {
    let fingerprint: String
    let hubName: String?
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(hubName.map { "Signed in to \($0)" } ?? "Signed in").font(.title2.weight(.semibold))
            Text("Your hub's fingerprint").font(.subheadline).foregroundStyle(Tone.fg3)
            Text(HubKeys.groups(fingerprint)).font(.title3.monospaced()).textSelection(.enabled)
            Text("Compare it with Settings on your hub.").foregroundStyle(Tone.fg2)
            Button("Done", action: done)
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(24)
        .presentationDetents([.medium])
    }
}
