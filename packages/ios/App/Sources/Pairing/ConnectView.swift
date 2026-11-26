import ConclaveKit
import SwiftUI

/// Pair with a hub by address and code. Phase 2 adds the QR scanner and password login.
struct ConnectView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    TextField("Hub address", text: $model.address, prompt: Text("https://hub.example.com"))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Pairing code", text: $model.code)
                        .textContentType(.oneTimeCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await model.pair() } }
                } footer: {
                    Text("Open Devices on your hub and choose Pair a device to get a code.")
                }
                if let hub = HubAddress.parse(model.address), hub.needsWarning {
                    Label("This address is plain http on the internet. Use https.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                if let fp = model.fingerprint {
                    LabeledContent("Hub key", value: HubKeys.groups(fp)).font(.caption.monospaced())
                }
                if let error = model.error {
                    Text(error).foregroundStyle(.red)
                }
                Button {
                    Task { await model.pair() }
                } label: {
                    if model.busy { ProgressView() } else { Text("Connect") }
                }
                .disabled(!model.canPair)
                .keyboardShortcut(.defaultAction)
            }
            .navigationTitle("Connect to your hub")
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
    }
}

#Preview {
    ConnectView().environment(AppModel(store: PreviewStore()))
}

struct PreviewStore: PairingStore {
    func load() -> SavedPairing? { nil }
    func save(_ p: SavedPairing?) {}
}
