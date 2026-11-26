import Foundation

/// Approvals and questions from subagents and workflow agents show in the chat the owner is in
/// (docs/design/CHAT-AND-MOTION.md 1.4; Android logic/Asks.kt).
public enum Asks {
    /// The conversation the request shows in: its top session, else (an older hub) the one that asks.
    public static func home(_ r: some Ask) -> String { r.rootSessionId ?? r.sessionId }

    /// It asks here, or a subagent or workflow agent under this session asks.
    public static func showsIn(_ r: some Ask, _ sessionId: String) -> Bool {
        r.sessionId == sessionId || r.rootSessionId == sessionId || r.from?.chain.contains(sessionId) == true
    }

    public static func of<T: Ask>(_ list: [T], _ sessionId: String) -> [T] { list.filter { showsIn($0, sessionId) } }

    /// A session under this one waits on you: the turn that started it does too.
    public static func below(_ list: [any Ask], _ sessionId: String) -> Bool {
        list.contains { $0.sessionId != sessionId && showsIn($0, sessionId) }
    }

    /// This session, or one under it, waits on you: a subagent's row says so.
    public static func waitsIn(_ list: [any Ask], _ sessionId: String?) -> Bool {
        guard let sessionId else { return false }
        return list.contains { $0.sessionId == sessionId || $0.from?.chain.contains(sessionId) == true }
    }

    /// An agent of this workflow run waits on you.
    public static func runWaits(_ list: [any Ask], _ runId: String) -> Bool { list.contains { $0.from?.workflow?.runId == runId } }

    /// Who asks, as the start of a sentence: "Subagent email", "Workflow deep-research, agent search r1 3,".
    private static func who(_ r: some Ask) -> String? {
        guard let f = r.from else { return nil }
        if let wf = f.workflow { return "Workflow \(wf.name), agent \(f.label)," }
        return "Subagent \(f.agent)"
    }

    /// The quiet line above a card: "Subagent email asks". Nil in the session that asks.
    public static func fromLine(_ r: some Ask, viewing: String?) -> String? {
        guard viewing != r.sessionId else { return nil }
        return who(r).map { "\($0) asks" }
    }

    /// For the Inbox: "from subagent email in Lisbon flight booking code".
    public static func inboxLine(_ r: some Ask, rootTitle: String? = nil) -> String? {
        guard let f = r.from else { return nil }
        let w = f.workflow.map { "workflow \($0.name), agent \(f.label)," } ?? "subagent \(f.agent)"
        guard let rootTitle, !rootTitle.trimmingCharacters(in: .whitespaces).isEmpty else { return "from \(w)" }
        return "from \(w) in \(rootTitle)"
    }

    /// An Inbox row's line with who asks in front: "Subagent email wants to read a file".
    public static func askerLine(_ r: some Ask, _ line: String) -> String {
        guard let w = who(r) else { return line }
        return "\(w) \(line.prefix(1).lowercased())\(line.dropFirst())"
    }

    /// "Allow for this subagent" when a subagent asks: it applies to the session that asked.
    public static func sessionLabel(_ r: some Ask) -> String { r.from != nil ? "Allow for this subagent" : "Allow for this chat" }

    /// What the session answer reads once given.
    public static func sessionDone(_ r: some Ask) -> String { r.from != nil ? "Allowed for this subagent" : "Allowed for this chat" }
}
