import SwiftUI

@main
struct ConclaveApp: App {
    @State private var model = ConclaveApp.makeModel()
    /// Settings > Appearance: system, light or dark.
    @AppStorage("theme") private var theme = "system"
    /// Settings > Appearance > Reduce motion: every animation becomes a short linear one (Motion.of's).
    @AppStorage("reduceMotion") private var reduceMotion = false

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.open($0) }
                .preferredColorScheme(scheme)
                .transaction { t in if reduceMotion, t.animation != nil { t.animation = .linear(duration: Motion.dur1) } }
        }
    }

    private var scheme: ColorScheme? {
        #if DEBUG
        // CI screenshots: `-appearance dark|light` (XCUIDevice.appearance left every shot light)
        if let a = UserDefaults.standard.string(forKey: "appearance") { return a == "dark" ? .dark : .light }
        #endif
        return theme == "dark" ? .dark : theme == "light" ? .light : nil
    }

    @MainActor
    private static func makeModel() -> AppModel {
        #if DEBUG
        // CI screenshots: a scripted hub with fixtures, no network (MockHub.swift)
        if ProcessInfo.processInfo.arguments.contains("-mockHub") { return MockHub.appModel() }
        #endif
        return AppModel(store: KeychainStore())
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var phase

    var body: some View {
        Group {
            if let address = model.notYourHub {
                NotYourHubView(address: address)
            } else if model.pairing == nil {
                ConnectView()
            } else {
                MainSplitView()
            }
        }
        .sheet(isPresented: Binding(get: { model.newSignIn != nil }, set: { if !$0 { model.newSignIn = nil } })) {
            FingerprintSheet(fingerprint: model.newSignIn ?? "", hubName: model.pairing?.hubName) { model.newSignIn = nil }
        }
        // the socket runs while the app is on screen: that is the hub's presence signal
        .onChange(of: phase, initial: true) { _, now in
            if now == .active { model.hub?.start() } else if now == .background { model.hub?.stop() }
        }
        .onChange(of: model.hub.map(ObjectIdentifier.init)) { if phase == .active { model.hub?.start() } }
    }
}
