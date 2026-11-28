import Foundation

/// Settings > Permissions words (web settings/permissions.tsx MODES and RULE).
public enum PermissionWords {
    /// value, label, help
    public static let modes: [(String, String, String)] = [
        ("default", "Ask before edits", "Reading runs freely. Edits and commands ask you first."),
        ("acceptEdits", "Accept edits", "Edits apply without asking. Commands still ask."),
        ("plan", "Plan only", "Read only. A session plans, and you approve before anything changes."),
        ("bypass", "Bypass", "Nothing asks. Only for throwaway containers you can rebuild."),
    ]

    public static func help(_ mode: String) -> String { modes.first { $0.0 == mode }?.2 ?? modes[0].2 }

    /// Claude Code rule syntax: Tool, Tool(spec), mcp__server or mcp__server__tool (a trailing * allowed).
    public static func ruleOK(_ r: String) -> Bool {
        r.range(of: #"^(?:[A-Z][A-Za-z]*(?:\(.+\))?|mcp__[\w-]+(?:__[\w*-]+)?\*?)$"#, options: .regularExpression) != nil
    }
}

extension JSONValue {
    /// The strings of an array value; nil when it is not an array.
    public var arrayStrings: [String]? {
        if case .array(let a) = self { return a.compactMap(\.string) }
        return nil
    }
}
