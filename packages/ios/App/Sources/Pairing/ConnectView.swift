import ConclaveKit
import SwiftUI
import VisionKit

/// Connect to a hub: scan its QR code, or type the address with a pairing code or the hub's password.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var withPassword = false

    var body: some View {
        @Bindable var model = model
        Form {
            // the title sits in the same column as the form, so they line up on a wide iPad
            Text("Connect to your hub")
                .font(.largeTitle.bold())
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 24, leading: 4, bottom: 8, trailing: 4))
            if DataScannerViewController.isSupported {
                Section {
                    Button {
                        model.scanning = true
                    } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                    }
                } footer: {
                    Text("Open Devices on your hub and choose Pair a device.")
                }
            }
            Section {
                TextField("Hub address", text: $model.address, prompt: Text("https://hub.example.com"))
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Picker("Sign in with", selection: $withPassword) {
                    Text("Pairing code").tag(false)
                    Text("Password").tag(true)
                }
                .pickerStyle(.segmented)
                if withPassword {
                    TextField("Name or email (optional)", text: $model.account)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $model.password)
                        .textContentType(.password)
                        .onSubmit { Task { await model.login() } }
                } else {
                    TextField("Pairing code", text: $model.code)
                        .textContentType(.oneTimeCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await model.pair() } }
                }
            } footer: {
                Text(withPassword ? "The password set in Settings on your hub." : "Devices on your hub, then Pair a device, shows a code.")
            }
            if let hub = HubAddress.parse(model.address), hub.needsWarning {
                Label(
                    withPassword ? PasswordRule.refused : "This address is plain http on the internet. Use https.",
                    systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(Tone.warn)
            }
            if let fp = model.fingerprint {
                LabeledContent("Hub key", value: HubKeys.groups(fp)).font(.caption.monospaced())
            }
            if let error = model.error {
                Text(error).foregroundStyle(Tone.fault)
            }
            Button {
                Task { withPassword ? await model.login() : await model.pair() }
            } label: {
                if model.busy { ProgressView() } else { Text(withPassword ? "Sign in" : "Connect") }
            }
            .disabled(withPassword ? !model.canLogin : !model.canPair)
            .keyboardShortcut(.defaultAction)
        }
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
        .fullScreenCover(isPresented: $model.scanning) {
            QRScanner { model.scanned($0) }
                .ignoresSafeArea()
                .overlay(alignment: .topLeading) {
                    Button("Close") { model.scanning = false }
                        .buttonStyle(.borderedProminent)
                        .padding()
                }
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
