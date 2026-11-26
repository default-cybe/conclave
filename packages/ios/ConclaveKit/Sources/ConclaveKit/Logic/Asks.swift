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

    /// The quiet line above a card: "Subagent email asks". Nil in the session that asks.
    public static func fromLine(_ r: some Ask, viewing: String?) -> String? {
        guard viewing != r.sessionId, let f = r.from else { return nil }
        if let wf = f.workflow { return "Workflow \(wf.name), agent \(f.label), asks" }
        return "Subagent \(f.agent) asks"
    }

    /// "Allow for this subagent" when a subagent asks: it applies to the session that asked.
    public static func sessionLabel(_ r: some Ask) -> String { r.from != nil ? "Allow for this subagent" : "Allow for this chat" }
}
