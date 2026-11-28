import ConclaveKit
import SwiftUI

/// The pages the sidebar opens besides chats.
enum SidePage: String { case inbox, devices, settings, search, memory, usage, tasks, workflows, agents, today, routines, providers, subscriptions, secrets, accounts, people, remote, reflect, meetings, friends, map, files }

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
              HStack(spacing: 0) {
                Group {
                    if let page {
                        switch page {
                        case .inbox: InboxView(hub: hub) { open($0) }
                        case .devices: DevicesView(hub: hub)
                        case .settings: SettingsView(hub: hub) { self.page = $0 }
                        case .providers: ProvidersView(hub: hub) { self.page = .settings }
                        case .subscriptions: SubscriptionsView(hub: hub) { self.page = .settings }
                        case .meetings: MeetingsView(hub: hub) { open($0) }
                        case .friends: FriendsView(hub: hub)
                        case .map: MapView(hub: hub) { open($0) }
                        case .files: FilesView(hub: hub)
                        case .reflect: ReflectView(hub: hub) { self.page = .settings }
                        case .remote: RemoteView(hub: hub) { self.page = .settings }
                        case .people: PeopleView(hub: hub) { self.page = .settings }
                        case .accounts: AccountsView(hub: hub) { self.page = .settings }
                        case .secrets: SecretsView(hub: hub, member: hub.me?.isMember ?? false) { self.page = .settings }
                        case .search: SearchView(hub: hub) { open($0) }
                        case .memory: MemoryView(hub: hub)
                        case .usage: UsageView(hub: hub)
                        case .tasks: TasksView(hub: hub) { open($0) }
                        case .workflows: WorkflowsView(hub: hub) { open($0) }
                        case .agents: AgentsView(hub: hub) { open($0) }
                        case .today: TodayView(hub: hub, page: { self.page = $0 }) { open($0) }
                        case .routines: RoutinesView(hub: hub) { open($0) }
                        }
                    } else if let id = selection {
                        ChatView(chat: hub.chat(id), hub: hub, title: hub.session(id).map(Panel.title) ?? "") { selection = $0 }
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
                .frame(maxWidth: .infinity)
                // iPad: the inspector as the web's right column beside the chat. SwiftUI's .inspector
                // laid itself over a dimmed chat at this width, the chat's cards running under it
                if sizeClass != .compact, inspectorShown, let id = selection {
                    Rectangle().fill(Tone.rule).frame(width: 1).ignoresSafeArea(edges: .bottom)
                    InspectorView(sessionId: id, hub: hub).frame(width: 320)
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
                // iPhone: a sheet, as .inspector gave it
                .sheet(isPresented: Binding(get: { sizeClass == .compact && inspectorShown }, set: { showInspector = $0 })) {
                    if let id = selection { InspectorView(sessionId: id, hub: hub).presentationDetents([.medium, .large]) }
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
                // `-emptyComposer`: shots that type into the box start it empty
                let args = ProcessInfo.processInfo.arguments
                if args.contains("-mockHub"), !args.contains("-emptyComposer"), let id = selection { MockHub.fillComposer(hub.chat(id)) }
            }
            #endif
            // chrome icons in fg-2 as the web's (no accent on the sidebar toggles); content sets signal where it means focus
            .tint(Tone.fg2)
            .onChange(of: selection, initial: true) { _, s in
                if s != nil { page = nil; column = .detail }
                DeviceNotices.shared.visible = page == nil ? s : nil
            }
            // a tapped banner opens its chat
            .onAppear { DeviceNotices.shared.onOpen = { open($0) } }
            .onChange(of: page, initial: true) { _, p in if p != nil { column = .detail } }
            // back to the list: forget the pick, so tapping the same chat or page opens it again
            .onChange(of: column) { _, c in if c == .sidebar { selection = nil; page = nil } }
            .onChange(of: hub.sessions.map(\.id)) { _, ids in
                if let s = selection, !ids.contains(s) { selection = nil }
            }
        }
    }

    private var inspectorShown: Bool { showInspector && page == nil && selection != nil }

    private func open(_ id: String) {
        page = nil
        selection = id
    }
}
