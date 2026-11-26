import Foundation

/// One readable line for a tool call's fold (Android logic/Tools.kt ToolSummary).
/// shortcut: paths show whole, not relative to the session's folder (Android Paths.pathIn); port Paths with the Code mode.
public enum ToolSummary {
    public static func of(_ name: String, _ input: JSONObject) -> String {
        func s(_ key: String) -> String? {
            input[key]?.string?.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init)
        }
        let detail: String? = switch name {
        case "Read": s("file_path").map { "Read \($0)" }
        case "Write": s("file_path").map { "Write \($0)" }
        case "Edit", "MultiEdit": s("file_path").map { "Edit \($0)" }
        case "NotebookEdit": s("notebook_path").map { "Edit \($0)" }
        case "Bash": s("command").map { "Run: \($0)" }
        case "Glob": s("pattern").map { "Find \($0)" }
        case "Grep": s("pattern").map { "Search \"\($0)\"" }
        case "WebFetch": s("url").map { "Fetch \($0)" }
        case "WebSearch": s("query").map { "Web search \"\($0)\"" }
        case "Task": s("description").map { "Subagent: \($0)" }
        case "Delegate": (s("description") ?? s("prompt")).map { "\(s("to") == "assistant" ? "Assistant" : "Code"): \($0)" }
        case "TodoWrite": "Update todo list"
        case "AskUserQuestion": "Ask a question"
        case "Skill": s("skill").map { "Use skill \($0)" }
        default: nil
        }
        if let detail, !detail.isEmpty { return detail }
        // the wire's key order is lost in a Swift dictionary: the first string key by name
        let first = input.keys.sorted().lazy.compactMap { input[$0]?.string }.first?
            .split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init)
        guard let first, !first.trimmingCharacters(in: .whitespaces).isEmpty else { return name }
        return "\(name): \(first)"
    }
}
