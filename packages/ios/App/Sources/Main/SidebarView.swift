import ConclaveKit
import SwiftUI

/// Chats and sessions grouped like the Android side panel (Drawer.groups), with search and New chat.
struct SidebarView: View {
    @Environment(AppModel.self) private var model
    let hub: HubModel
    @Binding var selection: String?
    @AppStorage("drawerGroup") private var groupWire = GroupBy.project.rawValue
    @State private var query = ""

    var body: some View {
        let by = GroupBy.from(groupWire)
        let groups = Drawer.groups(hub.sessions, by: by, waiting: hub.waiting, query: query)
        List(selection: $selection) {
            ForEach(groups) { g in
                Section(g.title) {
                    ForEach(g.items) { SidebarRow(item: $0).tag($0.id) }
                }
            }
        }
        .overlay {
            if hub.loaded && groups.isEmpty {
                ContentUnavailableView(query.isEmpty ? "No chats yet" : "No results", systemImage: query.isEmpty ? "bubble.left" : "magnifyingglass")
            } else if !hub.loaded {
                ProgressView()
            }
        }
        .searchable(text: $query, placement: .sidebar)
        .refreshable { await hub.load() }
        .navigationTitle(model.pairing?.hubName.isEmpty == false ? model.pairing!.hubName : "Conclave")
        .safeAreaInset(edge: .bottom) { ConnectionLine(state: hub.connection, error: hub.error) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { if let id = await hub.newChat() { selection = id } }
                } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                }
                .keyboardShortcut("n", modifiers: .command)
            }
            ToolbarItem(placement: .secondaryAction) {
                Menu {
                    Picker("Group by", selection: $groupWire) {
                        ForEach(GroupBy.allCases, id: \.self) { Text($0.label).tag($0.rawValue) }
                    }
                    Button("Forget this hub", role: .destructive) { model.forget() }
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
    }
}

private struct SidebarRow: View {
    let item: Recent

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: item.isChat ? "bubble.left" : "terminal")
                .foregroundStyle(Tone.fg3)
                .frame(width: 20)
            Text(item.title).lineLimit(1)
            Spacer(minLength: 0)
            switch item.dot {
            case .waiting: Circle().fill(Tone.warn).frame(width: 8, height: 8).accessibilityLabel("Waiting on you")
            case .running: Circle().fill(Tone.signal).frame(width: 8, height: 8).accessibilityLabel("Running")
            case .none: EmptyView()
            }
        }
    }
}

/// Shown only while the socket is not open.
private struct ConnectionLine: View {
    let state: ConnectionState
    let error: String?

    var body: some View {
        if state != .open || error != nil {
            Text(error ?? (state == .connecting ? "Connecting" : "Offline, retrying"))
                .font(.footnote)
                .foregroundStyle(Tone.fg3)
                .lineLimit(2)
                .frame(maxWidth: .infinity)
                .padding(8)
                .background(.bar)
        }
    }
}
