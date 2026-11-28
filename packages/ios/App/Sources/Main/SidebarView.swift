import ConclaveKit
import SwiftUI

/// The web sidebar (packages/web/src/components/Sidebar.tsx, SPEC 5.3) and Android's side panel:
/// the knot and the mode switch on top; Search, New chat, Inbox, Meetings and More; the chats grouped
/// under bold headings (Drawer.groups); the hub's account row at the foot. Ground --side, rows 32 pt
/// with radius 8, the open one on --side-active.
struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduce
    let hub: HubModel
    @Binding var selection: String?
    @Binding var page: SidePage?
    @AppStorage("drawerGroup") private var groupWire = GroupBy.project.rawValue
    @AppStorage("sideMode") private var mode = "chat"
    @State private var query = ""
    @State private var searching = false
    @State private var creating = false
    /// Code and Security: the folder, computer and agent sheet before a new session (web NewSession).
    @State private var picking = false
    @State private var sheets = SessionSheets()
    @FocusState private var searchFocus: Bool

    private var m: Metrics { Metrics(sizeClass) }

    /// The modes this person has: Security unless they turned it off (Settings, Modes on the web).
    /// Canvas is not here: the app has no canvas yet, and a dead mode is worse than none.
    private var modes: [StartMode] { StartMode.allCases.filter { $0 != .security || hub.me?.modeOn("security") != false } }
    private var start: StartMode { StartMode(rawValue: mode).flatMap { modes.contains($0) ? $0 : nil } ?? .chat }

    var body: some View {
        // web lib/sidebar.ts sideGroups: a mode shows its own conversations; Code and Security group by
        // the chosen key, Chat by time, the Assistant its home then History
        let groups = Drawer.groups(hub.sessions, mode: start, by: start.inFolders ? GroupBy.from(groupWire) : .time, waiting: hub.waiting, query: query)
        VStack(spacing: 0) {
            header
            nav.padding(.horizontal, 8).padding(.top, 4)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    if hub.loaded && groups.isEmpty {
                        Text(query.isEmpty ? start.emptyWords : "Nothing matches \"\(query)\".")
                            .font(.sans(m.compact ? 14 : 12.5))
                            .foregroundStyle(Tone.fg3)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                    } else if !hub.loaded {
                        SkeletonRows(m: m)
                    }
                    ForEach(groups) { g in
                        // sidebar.ts: by project, the folderless group is "No folder"
                        Text(g.key == Drawer.chats ? "No folder" : g.title)
                            .font(.sans(m.compact ? 14 : 12.5, .semibold))
                            .foregroundStyle(Tone.fg)
                            .frame(height: m.compact ? 32 : 24, alignment: .bottom)
                            .padding(.leading, 10).padding(.top, g.id == groups.first?.id ? 0 : 8).padding(.bottom, 2)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(g.items) { item in
                            SideRow(item: item, on: page == nil && selection == item.id, m: m) {
                                withAnimation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce)) { selection = item.id }
                            }
                            .contextMenu {
                                if let s = hub.session(item.id) {
                                    SessionMenu(hub: hub, session: s, sheets: sheets) { id in
                                        if let id { selection = id } else if selection == item.id { selection = nil }
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 8).padding(.top, 12).padding(.bottom, 20)
            }
            .scrollIndicators(.hidden)
            .refreshable { await hub.load() }
            .sessionActionSheets(hub: hub, sheets: sheets)
            ConnectionLine(state: hub.connection, error: hub.error) { Task { await hub.load() } }
            AccountRow(hub: hub, m: m, page: $page).padding(.horizontal, 8).padding(.top, 4).padding(.bottom, 8)
        }
        .background(Tone.side.ignoresSafeArea())
        .background { keys(groups.flatMap(\.items).map(\.id)) }
        // the web's sidebar is 264 px; the system default (320) made it read wide on iPad
        .navigationSplitViewColumnWidth(min: 240, ideal: 272, max: 340)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $picking) {
            NewCodeSessionSheet(hub: hub, mode: start) { id in
                picking = false
                selection = id
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            KnotMark(size: 20, ground: Tone.side)
            Spacer(minLength: 0)
            ModeSwitch(mode: $mode, modes: modes)
        }
        .padding(.leading, 16).padding(.trailing, 8)
        .frame(height: 52)
    }

    @ViewBuilder private var nav: some View {
        VStack(spacing: 1) {
            if searching {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Tone.fg3)
                    TextField("Search chats", text: $query)
                        .font(.sans(m.row))
                        .foregroundStyle(Tone.fg)
                        .focused($searchFocus)
                        .submitLabel(.search)
                    Button("Done") { query = ""; searching = false }
                        .font(.sans(12.5)).foregroundStyle(Tone.fg3)
                }
                .padding(.horizontal, 10)
                .frame(height: m.compact ? 44 : 32)
                .panel(Tone.sideActive, radius: Radius.row)
                .transition(.opacity)
            } else {
                // web: Search opens the search page (titles and every message); filtering the list is ⌘F
                NavRow(icon: "magnifyingglass", label: "Search", m: m, hint: m.compact ? nil : "⌘K", on: page == .search) { page = .search }
                    .keyboardShortcut("k", modifiers: .command)
                    .accessibilityIdentifier("nav-search")
            }
            NavRow(icon: "square.and.pencil", label: creating ? "Starting…" : start.newWords, m: m) { newSession() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(creating)
                .accessibilityIdentifier("nav-new")
            NavRow(icon: "tray", label: "Inbox", m: m, count: hub.approvals.count + hub.questions.count, on: page == .inbox) { page = .inbox }
                .accessibilityIdentifier("nav-inbox")
            // web: More holds the pages; Devices is one of them, Group by sits by the list (Code and Security)
            Menu {
                Button("Filter this list", systemImage: "line.3.horizontal.decrease") { searching = true; searchFocus = true }
                Button("Tasks", systemImage: "checklist") { page = .tasks }
                Button("Workflows", systemImage: "point.3.connected.trianglepath.dotted") { page = .workflows }
                Button("Memory", systemImage: "brain") { page = .memory }
                Button("Usage", systemImage: "chart.bar") { page = .usage }
                Button("Devices", systemImage: "desktopcomputer") { page = .devices }
                if start.inFolders {
                    Picker("Group by", selection: $groupWire) {
                        ForEach(GroupBy.allCases, id: \.self) { Text($0.label).tag($0.rawValue) }
                    }
                }
                Button("Settings", systemImage: "gearshape") { page = .settings }
            } label: {
                NavLabel(icon: "ellipsis", label: "More", m: m)
            }
            .buttonStyle(QuietPress(fill: Tone.sideHover))
            .hoverEffect(.highlight)
            .accessibilityIdentifier("nav-more")
        }
        .animation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce), value: searching)
    }

    /// New in the open mode, with the person's defaults (HubModel.newSession); the haptic says it started.
    private func newSession() {
        guard !creating else { return }
        if start.inFolders { picking = true; return }
        creating = true
        Task {
            if let id = await hub.newSession(start) {
                selection = id
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            creating = false
        }
    }

    /// iPad keys beside the visible ones (⌘K, ⌘N): ⌘[ and ⌘] step through the list, ⌘, opens
    /// Settings, Esc closes the search or the open page (web ShortcutsSheet).
    private func keys(_ ids: [String]) -> some View {
        Group {
            Button("Previous chat") { step(ids, -1) }.keyboardShortcut("[", modifiers: .command)
            Button("Next chat") { step(ids, 1) }.keyboardShortcut("]", modifiers: .command)
            Button("Settings") { page = .settings }.keyboardShortcut(",", modifiers: .command)
            Button("Filter") { searching = true; searchFocus = true }.keyboardShortcut("f", modifiers: .command)
            Button("Close") {
                if searching { query = ""; searching = false } else if page != nil { page = nil }
            }
            .keyboardShortcut(.escape, modifiers: [])
        }
        .opacity(0).allowsHitTesting(false).accessibilityHidden(true)
    }

    private func step(_ ids: [String], _ by: Int) {
        guard !ids.isEmpty else { return }
        let i = selection.flatMap { ids.firstIndex(of: $0) }
        let next = i.map { min(max($0 + by, 0), ids.count - 1) } ?? (by > 0 ? 0 : ids.count - 1)
        page = nil
        selection = ids[next]
    }
}

/// The account row at the sidebar's foot and its menu (web components/AccountMenu.tsx): the person's
/// initial, their name, "Owner, <hub>" under it, the hub's state as a dot. The menu: the hub's
/// address, Settings, Devices, Appearance, the hub's and the app's versions, Get help, What's new, Sign out.
private struct AccountRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let hub: HubModel
    let m: Metrics
    @Binding var page: SidePage?
    @AppStorage("theme") private var theme = "system"
    @State private var confirmSignOut = false

    var body: some View {
        let a = AccountLabel.of(hub.me, uiName: hub.uiName, hubName: hub.info?.name ?? model.pairing?.hubName ?? "")
        let state = hub.connection == .open ? "online" : hub.connection == .closed ? "offline" : "reconnecting"
        Menu {
            Section(model.pairing?.addresses.first.map { $0.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression) } ?? a.name) {
                Button("Settings", systemImage: "gearshape") { page = .settings }
                Button("Devices", systemImage: "desktopcomputer") { page = .devices }
                Picker(selection: $theme) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                } label: {
                    Label("Appearance", systemImage: "circle.lefthalf.filled")
                }
                .pickerStyle(.menu)
            }
            Section {
                Link(destination: URL(string: "https://conclave.dymnitguys.com/details.html")!) { Label("Get help", systemImage: "questionmark.circle") }
                Link(destination: URL(string: "https://github.com/default-cybe/conclave/releases")!) { Label("What's new", systemImage: "sparkles") }
            }
            AccountsMenuSection()
            Section("Hub \(hub.info?.version ?? "…") · App \(AppLogs.version)") {
                Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmSignOut = true }
            }
        } label: {
            HStack(spacing: 10) {
                Text(a.initial)
                    .font(.sans(m.compact ? 15.5 : 13.5, .semibold))
                    .foregroundStyle(Tone.fg2)
                    .frame(width: m.compact ? 34 : 30, height: m.compact ? 34 : 30)
                    .background(Tone.surface2, in: Circle())
                    .overlay(Circle().strokeBorder(Tone.rule))
                VStack(alignment: .leading, spacing: 1) {
                    Text(a.name).font(.sans(m.compact ? 15.5 : 13.5, .medium)).foregroundStyle(Tone.fg)
                    Text(a.sub).font(.sans(m.compact ? 13 : 12)).foregroundStyle(Tone.fg3)
                }
                Spacer(minLength: 0)
                Circle()
                    .fill(hub.connection == .open ? Tone.ok : hub.connection == .closed ? Tone.fault : Tone.warn)
                    .frame(width: 7, height: 7)
                    .frame(width: 20, height: 20)
            }
            .lineLimit(1)
            .padding(.horizontal, 8)
            .frame(height: m.compact ? 52 : 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(QuietPress(fill: Tone.sideHover, radius: m.compact ? 12 : 10))
        .hoverEffect(.highlight)
        .accessibilityLabel("Account: \(a.name), hub \(hub.info?.name ?? "") \(state)")
        .accessibilityIdentifier("account")
        .confirmationDialog("Sign out of \(hub.info?.name ?? model.pairing?.hubName ?? "this hub")?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
        } message: {
            Text("This iPad's token stops working on the hub. Pair again or sign in with your password to come back.")
        }
        .addAccountSheet()
    }
}

/// Grey bars where the list will be while it loads, as the web's skeleton rows.
private struct SkeletonRows: View {
    let m: Metrics
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RoundedRectangle(cornerRadius: 4).fill(Tone.hover).frame(width: 64, height: 10).padding(.bottom, 4)
            ForEach([0.82, 0.64, 0.9, 0.55, 0.72, 0.6], id: \.self) { w in
                GeometryReader { g in RoundedRectangle(cornerRadius: 4).fill(Tone.hover).frame(width: g.size.width * w, height: 10) }
                    .frame(height: m.compact ? 30 : 20)
            }
        }
        .padding(.horizontal, 10).padding(.top, 6)
        .opacity(dim ? 0.5 : 1)
        .animation(.easeInOut(duration: 0.9).repeatForever(), value: dim)
        .onAppear { dim = true }
        .accessibilityLabel("Loading")
    }
}

/// The web's compact mode switch (features/home/ModeSwitch.tsx): icon buttons on a hover tint, the open one raised.
private struct ModeSwitch: View {
    @Binding var mode: String
    let modes: [StartMode]
    @Namespace private var ns
    @Environment(\.accessibilityReduceMotion) private var reduce
    private static let looks: [StartMode: (String, String)] = [
        .chat: ("bubble.left", "Chat"), .assistant: ("calendar", "Assistant"),
        .code: ("chevron.left.forwardslash.chevron.right", "Code"), .security: ("checkmark.shield", "Security"),
    ]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(modes, id: \.self) { m in
                let (icon, label) = Self.looks[m]!
                let value = m.rawValue
                let on = value == mode || (m == .chat && !modes.map(\.rawValue).contains(mode))
                Button {
                    withAnimation(Motion.of(.spring(response: 0.3, dampingFraction: 0.85), reduce: reduce)) { mode = value }
                } label: {
                    Image(systemName: icon)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(on ? Tone.fg : Tone.fg3)
                        .frame(width: 26, height: 26)
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .fill(Tone.raise)
                                    .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Tone.rule))
                                    .matchedGeometryEffect(id: "on", in: ns)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .help(label)
                .accessibilityLabel(label)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Tone.hover.opacity(0.6), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

private struct NavLabel: View {
    let icon: String
    let label: String
    let m: Metrics
    var hint: String?
    var count = 0

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: m.compact ? 14 : 13)).frame(width: 16)
            // phone: Android's PanelRow strong, 16 semibold in ink
            Text(label).font(.sans(m.compact ? 16 : m.row, m.compact ? .semibold : .regular)).lineLimit(1)
            Spacer(minLength: 0)
            if count > 0 {
                Text(count > 99 ? "99+" : "\(count)").font(.sans(12.5, .medium)).monospacedDigit().foregroundStyle(Tone.warn)
                    .accessibilityLabel("\(count) waiting on you")
            }
            if let hint { Text(hint).font(.sans(12)).foregroundStyle(Tone.fg4) }
        }
        .foregroundStyle(m.compact ? Tone.fg : Tone.fg2)
        .padding(.horizontal, 10)
        .frame(height: m.compact ? 44 : 32)
        .contentShape(Rectangle())
    }
}

private struct NavRow: View {
    let icon: String
    let label: String
    let m: Metrics
    var hint: String?
    var count = 0
    /// Its page is open: the row sits on the active tint, as a picked chat's.
    var on = false
    let action: () -> Void

    var body: some View {
        Button(action: action) { NavLabel(icon: icon, label: label, m: m, hint: hint, count: count) }
            .buttonStyle(QuietPress(fill: Tone.sideHover))
            .hoverEffect(.highlight)
            .background(on ? Tone.sideActive : .clear, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A chat's row: its title, and "running" in signal or "waiting" in amber as words (SPEC 0.4 rule 2).
private struct SideRow: View {
    let item: Recent
    let on: Bool
    let m: Metrics
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(item.title)
                    .font(.sans(m.compact ? 16 : m.row))
                    .foregroundStyle(on || m.compact ? Tone.fg : Tone.fg2)
                    .lineLimit(1)
                Spacer(minLength: 0)
                switch item.dot {
                case .waiting: Text("waiting").font(.sans(m.compact ? 13 : 11.5)).foregroundStyle(Tone.warn).accessibilityLabel("waiting on you")
                case .running: Text("running").font(.sans(m.compact ? 13 : 11.5)).foregroundStyle(Tone.signal)
                case .none: EmptyView()
                }
            }
            .padding(.horizontal, 10)
            .frame(height: m.compact ? 44 : 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(QuietPress(fill: Tone.sideHover, radius: m.compact ? 10 : Radius.row, selected: on, selectedFill: m.compact ? Tone.surface2 : Tone.sideActive))
        .hoverEffect(.highlight)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Shown only while the socket is not open or a load failed; an error has Retry beside it.
private struct ConnectionLine: View {
    let state: ConnectionState
    let error: String?
    let retry: () -> Void

    var body: some View {
        if state != .open || error != nil {
            HStack(spacing: 8) {
                Text(error ?? (state == .connecting ? "Connecting" : "Offline, retrying"))
                    .font(.sans(12.5))
                    .foregroundStyle(error != nil ? Tone.fault : Tone.fg3)
                    .lineLimit(2)
                Spacer(minLength: 0)
                if error != nil { Button("Retry", action: retry).buttonStyle(CVButton(look: .quiet, height: 24, size: 12)) }
            }
            .padding(.leading, 18).padding(.trailing, 10).padding(.vertical, 6)
        }
    }
}
