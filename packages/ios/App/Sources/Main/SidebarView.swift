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
    @FocusState private var searchFocus: Bool

    private var m: Metrics { Metrics(sizeClass) }

    var body: some View {
        // web lib/sidebar.ts sideGroups: a mode shows its own conversations; only Code groups by the
        // chosen key, the others by time; Security and Canvas have no list here yet, so they show all
        let start: StartMode? = mode == "chat" ? .chat : mode == "assistant" ? .assistant : mode == "code" ? .code : nil
        let groups = Drawer.groups(hub.sessions, mode: start, by: mode == "code" ? GroupBy.from(groupWire) : .time, waiting: hub.waiting, query: query)
        VStack(spacing: 0) {
            header
            nav.padding(.horizontal, 8).padding(.top, 4)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    if hub.loaded && groups.isEmpty {
                        Text(query.isEmpty ? "No chats." : "No chat matches \"\(query)\".")
                            .font(.sans(m.compact ? 14 : 12.5))
                            .foregroundStyle(Tone.fg3)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                    } else if !hub.loaded {
                        ProgressView().tint(Tone.fg3).frame(maxWidth: .infinity).padding(.vertical, 12)
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
                        }
                    }
                }
                .padding(.horizontal, 8).padding(.top, 12).padding(.bottom, 20)
            }
            .scrollIndicators(.hidden)
            .refreshable { await hub.load() }
            ConnectionLine(state: hub.connection, error: hub.error)
            account.padding(.horizontal, 8).padding(.top, 4).padding(.bottom, 8)
        }
        .background(Tone.side.ignoresSafeArea())
        // the web's sidebar is 264 px; the system default (320) made it read wide on iPad
        .navigationSplitViewColumnWidth(min: 240, ideal: 272, max: 340)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var header: some View {
        HStack(spacing: 8) {
            KnotMark(size: 20, ground: Tone.side)
            Spacer(minLength: 0)
            ModeSwitch(mode: $mode)
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
                NavRow(icon: "magnifyingglass", label: "Search", m: m, hint: m.compact ? nil : "⌘K") {
                    searching = true
                    searchFocus = true
                }
                .keyboardShortcut("k", modifiers: .command)
            }
            NavRow(icon: "square.and.pencil", label: mode == "code" ? "New session" : "New chat", m: m) {
                Task { if let id = await hub.newChat() { selection = id } }
            }
            .keyboardShortcut("n", modifiers: .command)
            NavRow(icon: "tray", label: "Inbox", m: m, count: hub.approvals.count + hub.questions.count, on: page == .inbox) { page = .inbox }
                .accessibilityIdentifier("nav-inbox")
            NavRow(icon: "desktopcomputer", label: "Devices", m: m, on: page == .devices) { page = .devices }
                .accessibilityIdentifier("nav-devices")
            NavRow(icon: "person.wave.2", label: "Meetings", m: m) {}
            Menu {
                Picker("Group by", selection: $groupWire) {
                    ForEach(GroupBy.allCases, id: \.self) { Text($0.label).tag($0.rawValue) }
                }
                Button("Settings", systemImage: "gearshape") { page = .settings }
                Button("Forget this hub", role: .destructive) { model.forget() }
            } label: {
                NavLabel(icon: "ellipsis", label: "More", m: m)
            }
            .buttonStyle(QuietPress(fill: Tone.sideHover))
        }
        .animation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce), value: searching)
    }

    private var account: some View {
        let name = model.pairing?.hubName.isEmpty == false ? model.pairing!.hubName : "Conclave"
        return HStack(spacing: 10) {
            Text(String(name.prefix(1)).uppercased())
                .font(.sans(12, .semibold))
                .foregroundStyle(Tone.bg)
                .frame(width: 26, height: 26)
                .background(Tone.fg2, in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text("Owner").font(.sans(m.compact ? 15.5 : 13, .medium)).foregroundStyle(Tone.fg)
                Text(name).font(.sans(m.compact ? 13 : 11.5)).foregroundStyle(Tone.fg3)
            }
            Spacer(minLength: 0)
            Circle()
                .fill(hub.connection == .open ? Tone.ok : Tone.warn)
                .frame(width: 7, height: 7)
                .accessibilityLabel(hub.connection == .open ? "Connected" : "Not connected")
        }
        .lineLimit(1)
        .padding(.horizontal, 10)
        .frame(height: m.compact ? 56 : 48)
    }
}

/// The web's compact mode switch (features/home/ModeSwitch.tsx): icon buttons on a hover tint, the open one raised.
private struct ModeSwitch: View {
    @Binding var mode: String
    @Namespace private var ns
    @Environment(\.accessibilityReduceMotion) private var reduce
    private let modes: [(String, String, String)] = [
        ("chat", "bubble.left", "Chat"), ("assistant", "calendar", "Assistant"), ("code", "chevron.left.forwardslash.chevron.right", "Code"),
        ("security", "checkmark.shield", "Security"), ("canvas", "point.topleft.down.to.point.bottomright.curvepath", "Canvas"),
    ]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(modes, id: \.0) { value, icon, label in
                let on = value == mode
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
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Shown only while the socket is not open.
private struct ConnectionLine: View {
    let state: ConnectionState
    let error: String?

    var body: some View {
        if state != .open || error != nil {
            Text(error ?? (state == .connecting ? "Connecting" : "Offline, retrying"))
                .font(.sans(12.5))
                .foregroundStyle(Tone.fg3)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 18).padding(.vertical, 6)
        }
    }
}
