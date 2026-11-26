import SwiftUI

@main
struct ConclaveApp: App {
    @State private var model = ConclaveApp.makeModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.open($0) }
        }
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
        #if DEBUG
        .task { MockHub.applyOrientation() }
        #endif
    }
}
