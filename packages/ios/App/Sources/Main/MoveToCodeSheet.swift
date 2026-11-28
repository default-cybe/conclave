import ConclaveKit
import SwiftUI

/// Move to Code (Android ContinueSheet, CHAT-AND-MOTION 2.9): the conversation so far moves to Code
/// with an agent that can work on a device. "Keep this chat in Chats" moves a fork instead, which
/// takes the chat's title. Starts from the hub's defaultAgent, defaultDevice and permission mode.
struct MoveToCodeSheet: View {
    let hub: HubModel
    let chat: Session
    let done: (String) -> Void
    @State private var agent: String?
    @State private var device = "local"
    @State private var cwd = "~"
    @State private var mode = PermissionMode.default
    @State private var keep = false
    @State private var busy = false
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    static func modeLabel(_ m: PermissionMode) -> String {
        switch m {
        case .default: "Ask"
        case .acceptEdits: "Accept edits"
        case .plan: "Plan only"
        case .bypass: "Bypass"
        }
    }

    var body: some View {
        let agents = AgentPicks.switchable(hub.agents)
        let computers = FolderWords.computers(hub.devices).filter { $0.online || $0.id == "local" }
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("The conversation so far moves to Code, with an agent that can work on a device.").font(.sans(14)).foregroundStyle(Tone.fg2)
                    VStack(spacing: 0) {
                        pick("Agent", agent.map(AgentPicks.label) ?? "No agent can work on a device") {
                            ForEach(agents) { a in Button(AgentPicks.label(a.name)) { agent = a.name } }
                        }
                        Rectangle().fill(Tone.rule).frame(height: 1).padding(.leading, 14)
                        pick("Device", computers.first { $0.id == device }.map(FolderWords.placeName) ?? "Hub") {
                            ForEach(computers) { d in Button(FolderWords.placeName(d)) { device = d.id } }
                        }
                        Rectangle().fill(Tone.rule).frame(height: 1).padding(.leading, 14)
                        CardRow(label: "Folder") {
                            TextField("~", text: $cwd).font(.mono(13)).multilineTextAlignment(.trailing)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().frame(maxWidth: 260)
                        }
                        Rectangle().fill(Tone.rule).frame(height: 1).padding(.leading, 14)
                        pick("Permission mode", Self.modeLabel(mode)) {
                            ForEach(PermissionMode.allCases, id: \.self) { m in Button(Self.modeLabel(m)) { mode = m } }
                        }
                        Rectangle().fill(Tone.rule).frame(height: 1).padding(.leading, 14)
                        CardRow(label: "Keep this chat in Chats") { Toggle("Keep this chat in Chats", isOn: $keep).labelsHidden().tint(Tone.signal) }
                    }
                    .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
                    if let problem { Text(problem).font(.sans(12.5)).foregroundStyle(Tone.fault) }
                    Button(busy ? "Moving" : "Move") { Task { await move() } }
                        .buttonStyle(CVButton(look: .solid, height: 44)).frame(maxWidth: .infinity).disabled(busy)
                        .accessibilityIdentifier("move-to-code")
                }
                .padding(20)
            }
            .background(Tone.bg)
            .navigationTitle("Move to Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .task {
            await hub.loadAgents()
            let cfg = try? await hub.client.hubConfig()
            let names = agents.map(\.name)
            let def = ConfigPath.value(cfg, "defaultAgent")?.string
            agent = def.flatMap { names.contains($0) ? $0 : nil } ?? AgentPicks.switchable(hub.agents).first?.name
            if let d = ConfigPath.value(cfg, "defaultDevice")?.string, computers.contains(where: { $0.id == d }) { device = d }
            if let m = ConfigPath.value(cfg, "permissions.mode")?.string.flatMap(PermissionMode.init(rawValue:)) { mode = m }
        }
    }

    private func pick(_ label: String, _ value: String, @ViewBuilder _ items: () -> some View) -> some View {
        // built here: Menu's content closure escapes, a @ViewBuilder parameter cannot
        let content = items()
        return CardRow(label: label) {
            Menu { content } label: {
                HStack(spacing: 6) {
                    Text(value).font(.sans(13, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Tone.fg3)
                }
            }
            .accessibilityLabel(label)
        }
    }

    private func move() async {
        guard let agent else { problem = "Add an agent that can work on a device in Agents, then try again."; return }
        busy = true
        problem = nil
        defer { busy = false }
        do {
            // keep this chat: the copy moves and takes the chat's title
            let target = keep ? try await hub.client.forkSession(chat.id, fromSeq: nil) : chat
            let folder = cwd.trimmingCharacters(in: .whitespaces)
            let moved = try await hub.client.updateSession(target.id, SessionPlacePatch(agent: agent, device: device, cwd: folder.isEmpty ? "~" : folder, kind: .agent, permissionMode: mode, title: keep ? chat.title : nil))
            hub.apply(keep ? .sessionCreated(moved) : .sessionUpdated(moved))
            dismiss()
            done(moved.id)
        } catch {
            problem = ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) + " Check the device is online, then try again."
        }
    }
}
