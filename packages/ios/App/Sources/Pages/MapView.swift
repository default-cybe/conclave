import ConclaveKit
import SwiftUI

/// The Map (Android MapScreen, web features/map): everything running now, by computer. Each row is
/// a chat, session or workflow with what it does this second and how many subagents work under it;
/// a tap opens the chat, Stop stops it. Refreshes every few seconds while open.
struct MapView: View {
    let hub: HubModel
    let open: (String) -> Void
    @State private var snapshot: MapSnapshot?
    @State private var error: String?
    @State private var stopping: MapNode?

    var body: some View {
        Page(title: "Map", sub: snapshot.map(summary)) {
            EmptyView()
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let s = snapshot {
                let groups = MapWords.byDevice(s)
                if groups.isEmpty { EmptyLine(text: "Nothing runs now. Chats and sessions show here while they work.") }
                ForEach(groups, id: \.1) { device, name, rows in
                    CardSection(title: name + (device?.online == false ? "  offline" : "")) {
                        ForEach(rows) { n in row(n, s) }
                    }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .refreshable { await load() }
        .task {
            // the web keeps a live socket; a few seconds is close enough here
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(4))
            }
        }
        .alert("Stop \(stopping?.title ?? "")?", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }), presenting: stopping) { n in
            Button("Stop", role: .destructive) { Task { await stop(n) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("The turn ends now; what it already did stays.") }
    }

    private func summary(_ s: MapSnapshot) -> String {
        let running = s.nodes.filter { $0.state == "running" }.count
        let waiting = s.nodes.filter { $0.state == "waiting" }.count
        return [running > 0 ? "\(running) running" : nil, waiting > 0 ? "\(waiting) waiting on you" : nil].compactMap { $0 }.joined(separator: ", ").nilIfEmpty ?? "Nothing runs now"
    }

    private func row(_ n: MapNode, _ s: MapSnapshot) -> some View {
        let kids = MapWords.children(s, of: n.id)
        let live = n.state == "running"
        return HStack(spacing: 10) {
            Circle().fill(dot(n.state)).frame(width: 8, height: 8)
            Button { if n.kind != "workflow" { open(n.id) } } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(n.title.isEmpty ? (n.kind == "workflow" ? "Workflow" : "Untitled") : n.title).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                    Text([MapWords.line(n), kids > 0 ? "\(kids) \(kids == 1 ? "subagent" : "subagents")" : nil, n.agent].compactMap { $0 }.joined(separator: " · "))
                        .font(.sans(12)).foregroundStyle(n.state == "waiting" ? Tone.warn : Tone.fg3).lineLimit(1).truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if live { Button("Stop") { stopping = n }.buttonStyle(CVButton(look: .quietFault, height: 30)) }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }

    private func dot(_ state: String) -> Color {
        switch state {
        case "running": Tone.signal
        case "waiting": Tone.warn
        case "failed": Tone.fault
        default: Tone.fg4
        }
    }

    private func load() async {
        do {
            snapshot = try await hub.client.map()
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func stop(_ n: MapNode) async {
        do {
            if n.kind == "workflow", let run = n.runId { _ = try await hub.client.stopWorkflow(run) } else { try await hub.client.abort(n.id) }
            await load()
        } catch { self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription }
    }
}
