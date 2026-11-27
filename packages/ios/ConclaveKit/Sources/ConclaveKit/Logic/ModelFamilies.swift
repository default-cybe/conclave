import Foundation

/// A maker's rows split by family, as the web's ModelPicker familyOf (components/pickers/ModelPicker.tsx):
/// Anthropic Mythos, Fable, Opus, Sonnet, Haiku, other Claude; OpenAI GPT, GPT mini and nano, o-series,
/// Codex; Google Gemini Pro, Flash, Flash-Lite, Gemini, Gemma; Z.ai GLM, GLM Air, GLM Flash. A model with
/// no known family has "" (rank 9).
public enum ModelFamilies {
    public struct Family: Sendable, Hashable {
        public var name: String
        public var rows: [ModelPicks.Row]
    }

    private static let claude = ["mythos", "fable", "opus", "sonnet", "haiku"]

    public static func of(_ id: String) -> (name: String, rank: Int) {
        var m = id.lowercased()
        if let slash = m.lastIndex(of: "/") { m = String(m[m.index(after: slash)...]) }
        let base = m.replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
        func has(_ p: String) -> Bool { base.range(of: p, options: .regularExpression) != nil }
        for (i, f) in claude.enumerated() where base.contains(f) { return (f.prefix(1).uppercased() + f.dropFirst(), i) }
        if has("^claude") { return ("Claude", claude.count) }
        // Codex before GPT: gpt-5.3-codex is a Codex model
        if has("codex") { return ("Codex", 3) }
        if has("^gpt") { return has(#"-(mini|nano)\b"#) ? ("GPT mini and nano", 1) : ("GPT", 0) }
        if has(#"^o\d"#) { return ("o-series", 2) }
        if has("^gemini") {
            if has("flash-lite") { return ("Gemini Flash-Lite", 2) }
            if has("flash") { return ("Gemini Flash", 1) }
            if has("pro") { return ("Gemini Pro", 0) }
            return ("Gemini", 3)
        }
        if has("^gemma") { return ("Gemma", 4) }
        if has("^glm") { return has(#"-air\b"#) ? ("GLM Air", 1) : has(#"-flash\b"#) ? ("GLM Flash", 2) : ("GLM", 0) }
        return ("", 9)
    }

    /// The rows by family, strongest family first; rows keep their order inside a family.
    public static func split(_ rows: [ModelPicks.Row]) -> [Family] {
        var out: [(rank: Int, family: Family)] = []
        for r in rows {
            let f = of(r.model.id)
            if let i = out.firstIndex(where: { $0.family.name == f.name }) { out[i].family.rows.append(r) } else { out.append((f.rank, Family(name: f.name, rows: [r]))) }
        }
        return out.enumerated().sorted { ($0.element.rank, $0.offset) < ($1.element.rank, $1.offset) }.map(\.element.family)
    }
}
