import Foundation

/// The composer's "/" menu (Android Start.slashMatches/commandOf, web slash.ts): the hub's commands
/// plus /btw, which the client runs itself. A chat (no tools) lists only the commands that fit it.
public enum Slash {
    /// Web BUILTINS' /btw: the hub answers it apart from the transcript, so it is not in /api/commands.
    public static let btw = CommandDef(name: "btw", description: "Ask a side question; the running turn never sees it", argumentHint: "<question>", source: "builtin", chat: true)

    /// The commands a bare "/" lists first (web TOP_COMMANDS and PHONE_TOP_COMMANDS share these).
    static let top = ["btw", "compact", "cost", "init", "export", "clear"]

    /// What the menu can offer here: /btw first, the hub's built-ins (a chat: only those that fit it), then custom ones.
    public static func available(_ commands: [CommandDef], chat: Bool) -> [CommandDef] {
        var seen: Set<String> = ["btw"]
        var out = [btw]
        for c in commands where !seen.contains(c.name) && (!chat || c.source != "builtin" || c.chat) {
            seen.insert(c.name)
            out.append(c)
        }
        return out
    }

    /// The name typed so far while the box holds "/" and one word; nil otherwise.
    public static func query(_ text: String) -> String? {
        guard text.hasPrefix("/"), !text.contains(where: \.isWhitespace) else { return nil }
        return String(text.dropFirst())
    }

    /// The rows for what was typed: a bare "/" puts the top commands first; a name, the ones that
    /// start with it, then the ones that contain it.
    public static func matches(_ text: String, _ commands: [CommandDef], max: Int = 8) -> [CommandDef] {
        guard let q = query(text)?.lowercased() else { return [] }
        if q.isEmpty {
            let first = top.compactMap { n in commands.first { $0.name == n } }
            return Array((first + commands.filter { !top.contains($0.name) }).prefix(max))
        }
        let starts = commands.filter { $0.name.lowercased().hasPrefix(q) }
        let contains = commands.filter { !$0.name.lowercased().hasPrefix(q) && $0.name.lowercased().contains(q) }
        return Array((starts + contains).prefix(max))
    }

    /// The command a message is ("/compact keep the plan" is compact), when it names one offered; else nil.
    public static func commandOf(_ text: String, _ commands: [CommandDef]) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("/") else { return nil }
        let name = String(t.dropFirst().prefix { !$0.isWhitespace })
        guard !name.isEmpty, commands.contains(where: { $0.name == name }) else { return nil }
        return name
    }

    /// What follows the command's name ("/btw why?" gives "why?").
    public static func argument(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let space = t.firstIndex(where: \.isWhitespace) else { return "" }
        return t[space...].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
