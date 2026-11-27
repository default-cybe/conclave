import ConclaveKit
import SwiftUI

/// The pages the sidebar opens besides chats.
enum SidePage: String { case inbox, devices, settings }

/// The iPad layout: sidebar, transcript and an inspector. On iPhone and in a narrow window it
/// collapses to a stack. Each window keeps its own selection.
struct MainSplitView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var selection: String?
    /// A page in the detail column instead of a chat; picking a chat closes it.
    @State private var page: SidePage?
    @State private var showInspector = false
    /// Collapsed (iPhone, a narrow window) the sidebar is not a List, so a pick pushes the chat through this.
    @State private var column = NavigationSplitViewColumn.sidebar

    var body: some View {
        if let hub = model.hub {
            NavigationSplitView(preferredCompactColumn: $column) {
                SidebarView(hub: hub, selection: $selection, page: $page)
            } detail: {
                Group {
                    if let page {
                        switch page {
                        case .inbox: InboxView(hub: hub) { open($0) }
                        case .devices: DevicesView(hub: hub)
                        case .settings: SettingsView(hub: hub)
                        }
                    } else if let id = selection {
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
                    if page == nil, selection != nil {
                        Button {
                            showInspector.toggle()
                        } label: {
                            Label("Files and tasks", systemImage: "sidebar.right")
                        }
                        .keyboardShortcut("i", modifiers: [.command, .option])
                        .accessibilityIdentifier("inspector-toggle")
                    }
                }
                .inspector(isPresented: Binding(get: { showInspector && page == nil && selection != nil }, set: { showInspector = $0 })) {
                    if let id = selection { InspectorView(sessionId: id, hub: hub) }
                }
            }
            #if DEBUG
            // CI screenshots open a chat with `-openChat <id>`, a page with `-openPage inbox|devices|settings`,
            // and the inspector with `-inspectorTab files|tasks`
            .onAppear {
                let d = UserDefaults.standard
                selection = selection ?? d.string(forKey: "openChat")
                page = page ?? d.string(forKey: "openPage").flatMap(SidePage.init)
                if d.string(forKey: "inspectorTab") != nil { showInspector = true }
                if ProcessInfo.processInfo.arguments.contains("-mockHub"), let id = selection { MockHub.fillComposer(hub.chat(id)) }
            }
            #endif
            // chrome icons in fg-2 as the web's (no accent on the sidebar toggles); content sets signal where it means focus
            .tint(Tone.fg2)
            .onChange(of: selection, initial: true) { _, s in if s != nil { page = nil; column = .detail } }
            .onChange(of: page, initial: true) { _, p in if p != nil { column = .detail } }
            // back to the list: forget the pick, so tapping the same chat or page opens it again
            .onChange(of: column) { _, c in if c == .sidebar { selection = nil; page = nil } }
            .onChange(of: hub.sessions.map(\.id)) { _, ids in
                if let s = selection, !ids.contains(s) { selection = nil }
            }
        }
    }

    private func open(_ id: String) {
        page = nil
        selection = id
    }
}
