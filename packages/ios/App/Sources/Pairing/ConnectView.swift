import ConclaveKit
import SwiftUI
import VisionKit

/// Connect to a hub, as docs/screenshots/apps/ios/connect-*.png: the knot, "Connect to your hub" and
/// one line under it in the middle; Scan QR code (ink, 56 pt) and "Use address and password" at the
/// foot. The address form opens in a sheet: a pairing code or the hub's password.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var withPassword = false
    @State private var typing = false

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 0) {
                KnotMark(size: 40)
                Text("Connect to your hub")
                    .font(.sans(34, .semibold, relativeTo: .largeTitle))
                    .tracking(-0.8)
                    .foregroundStyle(Tone.fg)
                    .padding(.top, 40)
                Text("Scan the QR code on\nyour hub's Devices page.")
                    .font(.sans(17))
                    .lineSpacing(5)
                    .foregroundStyle(Tone.fg3)
                    .padding(.top, 14)
            }
            .multilineTextAlignment(.center)
            .rise()
            Spacer()
            VStack(spacing: 8) {
                // no scanner (the simulator, an old iPad): the button opens the form instead
                Button("Scan QR code") { if DataScannerViewController.isSupported { model.scanning = true } else { typing = true } }
                    .buttonStyle(CVButton(look: .solid, height: 56, radius: 14, size: 17, full: true))
                Button("Use address and password") { typing = true }
                    .buttonStyle(CVButton(look: .quiet, height: 56, radius: 14, size: 17, full: true))
            }
            .frame(maxWidth: 440)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
            .rise(delay: 0.08)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tone.bg.ignoresSafeArea())
        .sheet(isPresented: $typing) { form.presentationDetents([.large]) }
        .fullScreenCover(isPresented: $model.scanning) {
            QRScanner { model.scanned($0) }
                .ignoresSafeArea()
                .overlay(alignment: .topLeading) {
                    Button("Close") { model.scanning = false }
                        .buttonStyle(CVButton(look: .solid, height: 44, radius: 12, size: 15))
                        .padding()
                }
        }
        // a scanned code fills the form: show it, with the key to compare
        .onChange(of: model.fingerprint) { _, fp in if fp != nil { typing = true } }
    }

    private var form: some View {
        @Bindable var model = model
        return Form {
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
            .buttonStyle(CVButton(look: .solid, height: 48, radius: 12, size: 16, full: true))
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
        .font(.sans(16))
        .foregroundStyle(Tone.fg)
        .scrollContentBackground(.hidden)
        .background(Tone.bg.ignoresSafeArea())
        .tint(Tone.signal)
    }
}

#Preview {
    ConnectView().environment(AppModel(store: PreviewStore()))
}

struct PreviewStore: PairingStore {
    func load() -> SavedPairing? { nil }
    func save(_ p: SavedPairing?) {}
}
