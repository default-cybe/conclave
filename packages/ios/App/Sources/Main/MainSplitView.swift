import ConclaveKit
import SwiftUI

/// The iPad layout: sidebar, transcript and an inspector. On iPhone and in a narrow window it
/// collapses to a stack. Each window keeps its own selection.
struct MainSplitView: View {
    @Environment(AppModel.self) private var model
    @State private var selection: String?
    @State private var showInspector = false
    /// Collapsed (iPhone, a narrow window) the sidebar is not a List, so a pick pushes the chat through this.
    @State private var column = NavigationSplitViewColumn.sidebar

    var body: some View {
        if let hub = model.hub {
            NavigationSplitView(preferredCompactColumn: $column) {
                SidebarView(hub: hub, selection: $selection)
            } detail: {
                Group {
                    if let id = selection {
                        ChatView(chat: hub.chat(id), hub: hub, title: hub.session(id).map(Panel.title) ?? "")
                            .id(id)
                    } else {
                        // the web's empty page: the knot and one quiet line, no system placeholder
                        VStack(spacing: 14) {
                            KnotMark(size: 40)
                            Text("Pick a chat, or start a new one.").font(.sans(15)).foregroundStyle(Tone.fg3)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .background(Tone.bg.ignoresSafeArea())
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
            // chrome icons in fg-2 as the web's (no accent on the sidebar toggles); content sets signal where it means focus
            .tint(Tone.fg2)
            .onChange(of: selection, initial: true) { _, s in if s != nil { column = .detail } }
            // back to the list: forget the pick, so tapping the same chat opens it again
            .onChange(of: column) { _, c in if c == .sidebar { selection = nil } }
            .onChange(of: hub.sessions.map(\.id)) { _, ids in
                if let s = selection, !ids.contains(s) { selection = nil }
            }
        }
    }
}
