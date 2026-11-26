import SwiftUI

@main
struct ConclaveApp: App {
    @State private var model = AppModel(store: KeychainStore())

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.open($0) }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.pairing == nil {
            ConnectView()
        } else {
            MainSplitView()
        }
    }
}
