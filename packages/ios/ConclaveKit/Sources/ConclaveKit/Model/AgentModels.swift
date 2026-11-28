import Foundation

/// An agent from GET /api/agents (packages/android/client model/Api.kt AgentDef; server routes.ts agentsFor).
/// The fields the app shows; mode and permissionMode stay words so a new one never fails the list.
public struct AgentDef: Sendable, Hashable, Decodable, Identifiable {
    public var name: String
    public var description = ""
    /// System prompt body.
    public var prompt = ""
    public var model: String?
    public var tools: [String]?
    public var mode: String?
    public var permissionMode: String?
    public var icon: String?
    public var skills: [String]?
    /// global, agent or none
    public var memory: String?
    public var subagent: Bool?
    public var primary: Bool?
    public var untrusted: Bool?
    public var device: String?
    /// Effort: off, low, medium, high, xhigh or max
    public var thinking: String?
    /// builtin, user, project, plugin, account or claude
    public var source = "user"
    public var plugin: String?

    public var id: String { name }

    public init(_ name: String, description: String = "", model: String? = nil, source: String = "user", subagent: Bool? = nil, primary: Bool? = nil) {
        self.name = name
        self.description = description
        self.model = model
        self.source = source
        self.subagent = subagent
        self.primary = primary
    }

    private enum CodingKeys: String, CodingKey {
        case name, description, prompt, model, tools, mode, permissionMode, icon, skills, memory, subagent, primary, untrusted, device, thinking, source, plugin
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        description = try c.or(.description, "")
        prompt = try c.or(.prompt, "")
        model = try c.opt(.model)
        tools = try c.opt(.tools)
        mode = try c.opt(.mode)
        permissionMode = try c.opt(.permissionMode)
        icon = try c.opt(.icon)
        skills = try c.opt(.skills)
        memory = try c.opt(.memory)
        subagent = try c.opt(.subagent)
        primary = try c.opt(.primary)
        untrusted = try c.opt(.untrusted)
        device = try c.opt(.device)
        thinking = try c.opt(.thinking)
        source = try c.or(.source, "user")
        plugin = try c.opt(.plugin)
    }
}

/// Which agents the pickers offer (Android logic/Start.kt, ui/agents/AgentsScreen.kt).
public enum AgentPicks {
    /// An agent Code may start in place of its own: not the chat or the assistant agent.
    public static func customAgent(_ name: String?) -> Bool {
        guard let name, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return name != "chat" && name != StartMode.assistantAgent
    }

    /// The agents offered next to the default coding agent: custom ones (not shipped, not a subagent,
    /// not the chat or assistant agent), and the one picked even when it is not (Start.customAgents).
    public static func customAgents(_ agents: [AgentDef], picked: String? = nil) -> [AgentDef] {
        agents.filter { a in
            a.name != StartMode.codeAgent && customAgent(a.name)
                && ((a.primary != false && a.subagent != true && a.source != "builtin") || a.name == picked)
        }
    }

    /// The New session sheet's Agent row: the mode's own agent first (Coder or Security), the other shipped
    /// one, then the custom agents. Names as the hub lists them; the shipped two get their words.
    public static func startChoices(_ agents: [AgentDef], mode: StartMode, picked: String? = nil) -> [(String, String)] {
        let own = mode == .security ? StartMode.securityAgent : StartMode.codeAgent
        let other = mode == .security ? StartMode.codeAgent : StartMode.securityAgent
        let custom = customAgents(agents, picked: picked).filter { $0.name != StartMode.securityAgent }.map { ($0.name, $0.name) }
        return [(own, label(own)), (other, label(other))] + custom
    }

    /// The Agents page's two groups (AgentsScreen.kt): agents one starts, then subagents. Names once each.
    public static func sections(_ agents: [AgentDef]) -> (primary: [AgentDef], sub: [AgentDef]) {
        var seen = Set<String>()
        let unique = agents.filter { seen.insert($0.name).inserted }
        return (unique.filter { $0.primary != false && $0.subagent != true }, unique.filter { !($0.primary != false && $0.subagent != true) })
    }

    /// Where the session menu's agent switch goes: agents one starts, never the chat agent.
    public static func switchable(_ agents: [AgentDef]) -> [AgentDef] {
        sections(agents).primary.filter { $0.name != "chat" }
    }

    public static func label(_ name: String) -> String {
        switch name {
        case StartMode.codeAgent: "Coder"
        case StartMode.securityAgent: "Security"
        case StartMode.assistantAgent: "Assistant"
        default: name
        }
    }
}
