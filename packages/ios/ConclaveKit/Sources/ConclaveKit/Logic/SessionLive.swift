import Foundation

/// What a running session is doing now, for the live line under the turn (Android logic/SessionLive.kt).
public enum SessionActivity: Sendable, Hashable {
    /// The request is out, a tool result just went back, or a thought streams.
    case thinking
    /// A tool runs; `id` changes when the step changes.
    case tool(verb: String, target: String?, id: String)
    case writing
}

public enum SessionLive {
    /// The newest running tool wins; then the message that still streams says whether it thinks or
    /// writes; otherwise it is thinking. Looks back over the last few messages only.
    public static func activity(_ messages: [Message], running: Set<String>) -> SessionActivity {
        for m in messages.suffix(6).reversed() {
            for b in m.content.reversed() {
                if case .toolUse(let u) = b, running.contains(u.id) {
                    let s = step(u)
                    return .tool(verb: s.0, target: s.1, id: u.id)
                }
            }
            if m.role == .assistant, m.stopReason == nil {
                let last = m.content.last { if case .text(let t) = $0 { !t.isEmpty } else { true } }
                if case .text = last { return .writing }
                if case .thinking = last { return .thinking }
            }
        }
        return .thinking
    }

    /// The verb and its target for a running tool, as the web says them.
    public static func step(_ u: ToolUseBlock) -> (String, String?) {
        func s(_ k: String) -> String? {
            guard case .string(let v)? = u.input[k] else { return nil }
            let first = v.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init)
            return first?.isEmpty == false ? first : nil
        }
        let path = s("file_path") ?? s("path") ?? s("notebook_path")
        switch u.name {
        case "WebSearch": return ("Searching the web", s("query"))
        case "WebFetch": return ("Reading", s("url").map { HubAddress.host($0) })
        case "TodoWrite": return ("Planning", nil)
        case "Bash": return ("Running", s("command"))
        case "Read", "NotebookRead": return ("Reading", path)
        case "Write", "Edit", "MultiEdit", "NotebookEdit": return ("Editing", path)
        case "Glob", "Grep": return ("Searching", s("pattern"))
        case "LS": return ("Searching", path)
        case "Task": return ("Subagent working on", s("description"))
        case "Delegate": return (s("to") == "assistant" ? "Assistant working on" : "Code working on", s("description") ?? s("prompt"))
        case "Browser": return ("Fetching", s("url").map { HubAddress.host($0) } ?? s("action"))
        case "Skill": return ("Running", s("skill") ?? s("name") ?? u.name)
        default:
            if u.name.hasPrefix("Memory") { return ("Checking memory", nil) }
            if u.name.hasPrefix("mcp__") {
                let parts = u.name.dropFirst(5).components(separatedBy: "__").filter { !$0.isEmpty }.joined(separator: " ")
                return ("Running", parts.isEmpty ? u.name : parts)
            }
            // the tool's name, then the first text it was given
            let first = u.input.keys.sorted().lazy.compactMap { s($0) }.first
            return ("Running", first.map { "\(u.name) \($0)" } ?? u.name)
        }
    }

    /// "4s", "1m 12s", "3m": how long a turn ran.
    public static func duration(_ ms: Int64) -> String {
        let s = max(0, ms / 1000)
        if s < 60 { return "\(s)s" }
        if s < 600 { return s % 60 == 0 ? "\(s / 60)m" : "\(s / 60)m \(s % 60)s" }
        return "\(s / 60)m"
    }
}
