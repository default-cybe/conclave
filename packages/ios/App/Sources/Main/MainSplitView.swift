import SwiftUI

/// The iPad layout: sidebar, transcript and an inspector. Empty until phase 2 fills it;
/// on iPhone and in a narrow window it collapses to a stack.
struct MainSplitView: View {
    @Environment(AppModel.self) private var model
    @State private var showInspector = false

    var body: some View {
        NavigationSplitView {
            List {
                Section("Chats") {
                    Text("No chats yet").foregroundStyle(.secondary)
                }
            }
            .navigationTitle(model.pairing?.hubName.isEmpty == false ? model.pairing!.hubName : "Conclave")
            .toolbar {
                Menu {
                    Button("Forget this hub", role: .destructive) { model.forget() }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        } detail: {
            ContentUnavailableView("Pick a chat", systemImage: "bubble.left.and.bubble.right")
                .toolbar {
                    Button {
                        showInspector.toggle()
                    } label: {
                        Image(systemName: "sidebar.right")
                    }
                    .keyboardShortcut("i", modifiers: [.command, .option])
                }
                .inspector(isPresented: $showInspector) {
                    Text("Details").foregroundStyle(.secondary)
                }
        }
    }
}
