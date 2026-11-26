import ConclaveKit
import SwiftUI

/// The iPad layout: sidebar, transcript and an inspector. On iPhone and in a narrow window it
/// collapses to a stack. Each window keeps its own selection.
struct MainSplitView: View {
    @Environment(AppModel.self) private var model
    @State private var selection: String?
    @State private var showInspector = false

    var body: some View {
        if let hub = model.hub {
            NavigationSplitView {
                SidebarView(hub: hub, selection: $selection)
            } detail: {
                Group {
                    if let id = selection {
                        ChatView(chat: hub.chat(id), hub: hub, title: hub.session(id).map(Panel.title) ?? "")
                            .id(id)
                    } else {
                        ContentUnavailableView("Pick a chat", systemImage: "bubble.left.and.bubble.right")
                    }
                }
                .toolbar {
                    Button {
                        showInspector.toggle()
                    } label: {
                        Label("Details", systemImage: "sidebar.right")
                    }
                    .keyboardShortcut("i", modifiers: [.command, .option])
                }
                .inspector(isPresented: $showInspector) {
                    Text("Details").foregroundStyle(.secondary)
                }
            }
            #if DEBUG
            // CI screenshots open a chat with `-openChat <id>`
            .onAppear {
                selection = selection ?? UserDefaults.standard.string(forKey: "openChat")
                if ProcessInfo.processInfo.arguments.contains("-mockHub"), let id = selection { MockHub.fillComposer(hub.chat(id)) }
            }
            #endif
            .onChange(of: hub.sessions.map(\.id)) { _, ids in
                if let s = selection, !ids.contains(s) { selection = nil }
            }
        }
    }
}
