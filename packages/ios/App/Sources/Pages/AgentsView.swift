import ConclaveKit
import SwiftUI

/// The hub's agents (Android agents/AgentsScreen.kt, web features/agents): agents one starts, then
/// subagents; each row its name, description and default model. A tap opens the agent: what it runs
/// with, its tools and skills, its prompt, and a new session with it.
struct AgentsView: View {
    let hub: HubModel
    let open: (String) -> Void
    @State private var shown: AgentDef?
    @State private var loaded = false

    var body: some View {
        let (primary, sub) = AgentPicks.sections(hub.agents)
        Page(title: "Agents", sub: loaded ? "\(primary.count + sub.count) agents" : nil) {
            if !loaded {
                LoadingLine(text: "Reading the hub's agents")
            } else if hub.agents.isEmpty {
                EmptyLine(text: "No agents. Agents are markdown files on the hub (.claude/agents style).")
            } else {
                if !primary.isEmpty { section("Agents", primary) }
                if !sub.isEmpty { section("Subagents", sub) }
            }
        }
        .refreshable { await hub.loadAgents(force: true) }
        .task { await hub.loadAgents(force: true); loaded = true }
        .sheet(item: $shown) { a in AgentSheet(hub: hub, agent: a) { id in shown = nil; open(id) } }
    }

    private func section(_ title: String, _ list: [AgentDef]) -> some View {
        CardSection(title: title) {
            ForEach(list) { a in
                Button { shown = a } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(AgentPicks.label(a.name)).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                            if !a.description.isEmpty { Text(a.description).font(.sans(12.5)).foregroundStyle(Tone.fg2).lineLimit(2) }
                            Text(a.model.map(ModelRefs.displayName) ?? "Hub default model").font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Tone.fg4)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(QuietPress(radius: 0))
                .accessibilityIdentifier("agent-\(a.name)")
            }
        }
    }
}

/// One agent (Android AgentDetailScreen): New session with it, then its settings, tools, skills and prompt.
private struct AgentSheet: View {
    let hub: HubModel
    let agent: AgentDef
    let created: (String) -> Void
    @State private var starting = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text(AgentPicks.label(agent.name)).font(.sans(18, .semibold)).foregroundStyle(Tone.fg).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Close") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                if !agent.description.isEmpty { Text(agent.description).font(.sans(14)).foregroundStyle(Tone.fg2).fixedSize(horizontal: false, vertical: true) }
                if agent.primary != false, agent.subagent != true {
                    Button(starting ? "Starting…" : "New session with \(AgentPicks.label(agent.name))") { Task { await start() } }
                        .buttonStyle(CVButton(look: .solid, height: 40, full: true))
                        .disabled(starting)
                }
                if let error { Text(error).font(.sans(13)).foregroundStyle(Tone.fault) }
                CardSection(title: "Runs with") {
                    CardRow("Model", agent.model.map(ModelRefs.displayName) ?? "Hub default")
                    if let v = agent.mode { CardRow("Mode", v) }
                    if let v = agent.permissionMode { CardRow("Permissions", v) }
                    if let v = agent.thinking { CardRow("Effort", v) }
                    if let v = agent.memory { CardRow("Memory", v) }
                    if let v = agent.device { CardRow("Device", v) }
                    CardRow("Source", agent.plugin.map { "plugin \($0)" } ?? agent.source)
                    if agent.untrusted == true { CardRow("Input", "Untrusted (no shell, no writes)") }
                }
                if let tools = agent.tools, !tools.isEmpty { chips("Tools", tools) }
                if let skills = agent.skills, !skills.isEmpty { chips("Skills", skills) }
                if !agent.prompt.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("System prompt").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3)
                        Text(agent.prompt).font(.mono(12.5)).foregroundStyle(Tone.fg2).textSelection(.enabled)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .panel(Tone.sunk, radius: Radius.r2, border: Tone.rule)
                    }
                }
            }
            .padding(24).frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
    }

    private func chips(_ title: String, _ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3)
            Text(items.joined(separator: "  ·  ")).font(.mono(12.5)).foregroundStyle(Tone.fg2).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func start() async {
        starting = true
        do {
            let s = try await hub.client.createSession(CreateSessionInput(agent: agent.name))
            hub.apply(.sessionCreated(s))
            created(s.id)
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
        starting = false
    }
}
