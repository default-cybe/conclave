import Foundation

/// Model refs ("provider/model") and how their makers write them (Android logic/Logos.kt ModelRefs).
public enum ModelRefs {
    /// CLI coding agents Conclave can drive, with the names their makers use.
    public static let harnesses: KeyValuePairs<String, String> = [
        "claude-code": "Claude Code",
        "codex": "Codex",
        "gemini-cli": "Gemini CLI",
        "opencode": "OpenCode",
        "cursor": "Cursor",
        "cline": "Cline",
        "openhands": "OpenHands",
    ]

    private static let harnessNames = Dictionary(uniqueKeysWithValues: harnesses.map { ($0.key, $0.value) })

    private static let providerNames: [String: String] = harnessNames.merging([
        "anthropic": "Anthropic", "claude-max": "Claude Max", "claude-pro": "Claude Pro",
        "openai": "OpenAI", "chatgpt": "ChatGPT", "chatgpt-pro": "ChatGPT Pro", "codex": "Codex",
        "google": "Google", "gemini": "Gemini", "ai-studio": "AI Studio",
        "zai": "Z.ai", "zai-coding": "Z.ai Coding", "zhipu": "Zhipu",
        "openrouter": "OpenRouter", "ollama": "Ollama", "lmstudio": "LM Studio",
        "deepseek": "DeepSeek", "moonshot": "Moonshot", "kimi": "Kimi", "mistral": "Mistral",
        "groq": "Groq", "xai": "xAI", "qwen": "Qwen", "dashscope": "Alibaba Cloud",
        "minimax": "MiniMax", "meta": "Meta", "cliproxy": "CLIProxy",
    ]) { _, plan in plan }

    /// "anthropic/claude-sonnet-5-5" to ("anthropic", "claude-sonnet-5-5"). A ref without a slash is a bare model.
    public static func split(_ ref: String?) -> (provider: String, model: String) {
        guard let ref, !ref.isEmpty else { return ("", "") }
        guard let i = ref.firstIndex(of: "/") else { return ("", ref) }
        return (String(ref[..<i]), String(ref[ref.index(after: i)...]))
    }

    /// "claude-code/opus" to "claude-code". Also accepts a bare harness id.
    public static func harnessId(_ ref: String?) -> String? {
        guard let ref, !ref.isEmpty else { return nil }
        if harnessNames[ref] != nil { return ref }
        let p = split(ref).provider
        return harnessNames[p] != nil ? p : nil
    }

    public static func isHarness(_ ref: String?) -> Bool { harnessId(ref) != nil }

    public static func providerName(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return "" }
        return providerNames[id] ?? providerNames[id.lowercased()] ?? titleCase(id)
    }

    /// Display name for a ref: "anthropic/claude-sonnet-5-5" is "Sonnet 5.5", "claude-code/default" is "Claude Code".
    public static func displayName(_ ref: String?) -> String {
        guard let ref, !ref.isEmpty else { return "" }
        if let h = harnessId(ref) {
            let m = split(ref).model
            if m.isEmpty || m == "default" || m == h { return harnessNames[h]! }
            return formatModelId(m)
        }
        let m = split(ref).model
        return formatModelId(m.isEmpty ? ref : m)
    }

    private static let claudePrefix = Pattern("^Claude (?=(Opus|Sonnet|Haiku)\\b)")

    /// A hub model name without the maker prefix ("Claude Sonnet 5.5" to "Sonnet 5.5").
    public static func cleanName(_ name: String) -> String { claudePrefix.replace(name, with: "") }

    private static let words: [String: String] = [
        "pro": "Pro", "flash": "Flash", "lite": "Lite", "mini": "mini", "nano": "nano",
        "air": "Air", "coder": "Coder", "codex": "Codex", "chat": "Chat", "reasoner": "Reasoner",
        "instruct": "Instruct", "turbo": "Turbo", "large": "Large", "medium": "Medium",
        "small": "Small", "max": "Max", "plus": "Plus", "thinking": "Thinking",
        "preview": "Preview", "latest": "latest", "exp": "Exp", "vision": "Vision",
    ]

    private static let separators = Pattern("[-_\\s]+")

    static func titleCase(_ s: String) -> String {
        separators.replace(s, with: "\u{0}").split(separator: "\u{0}").map { w in
            let w = String(w)
            if let known = words[w.lowercased()] { return known }
            return w.first!.isNumber ? w.uppercased() : w.capitalizedFirst
        }.joined(separator: " ")
    }

    private static let claudeA = Pattern("^(?:claude-)?(opus|sonnet|haiku)(?:-(\\d+)(?:[-.](\\d+))?)?(.*)$")
    private static let claudeB = Pattern("^claude-(\\d+)(?:[-.](\\d+))?-(opus|sonnet|haiku)(.*)$")
    private static let gpt = Pattern("^gpt-?([\\d.]+o?)(?:-(.*))?$")
    private static let oSeries = Pattern("^(o\\d)(?:-(.*))?$")
    private static let codex = Pattern("^codex(?:-(.*))?$")
    private static let gemini = Pattern("^gemini-([\\d.]+)(?:-(.*))?$")
    private static let glm = Pattern("^glm-([\\d.]+v?)(?:-(.*))?$")
    private static let deepseek = Pattern("^deepseek-(.*)$")
    private static let qwen = Pattern("^qwen([\\d.]*)[-:]?(.*)$")
    private static let kimi = Pattern("^kimi-(.*)$")
    private static let grok = Pattern("^grok-(.*)$")
    private static let llama = Pattern("^llama-?([\\d.]+)(?:-(.*))?$")
    private static let minimax = Pattern("^minimax-(.*)$")
    private static let mistral = Pattern("^(mistral|codestral|devstral|magistral|ministral)(?:-(.*))?$")
    private static let dated = Pattern("-\\d{8}$")
    private static let version = Pattern("@.*$")
    private static let latest = Pattern("-latest$")

    /// A raw model id the way its maker writes it: "claude-opus-5-5" is "Opus 5.5".
    public static func formatModelId(_ id: String) -> String {
        var m = id.lowercased().afterLast("/")
        m = latest.replace(version.replace(dated.replace(m, with: ""), with: ""), with: "")
        func rest(_ s: String, _ sep: String = " ") -> String { s.isEmpty ? "" : sep + titleCase(s) }
        if let r = claudeA.matchEntire(m) {
            let v = r[2].isEmpty ? "" : " " + r[2] + (r[3].isEmpty ? "" : "." + r[3])
            return r[1].capitalizedFirst + v + rest(r[4])
        }
        if let r = claudeB.matchEntire(m) { return r[3].capitalizedFirst + " " + r[1] + (r[2].isEmpty ? "" : "." + r[2]) }
        if let r = gpt.matchEntire(m) { return "GPT-" + r[1] + rest(r[2]) }
        if let r = oSeries.matchEntire(m) { return r[1] + (r[2].isEmpty ? "" : "-" + r[2]) }
        if let r = codex.matchEntire(m) { return "Codex" + rest(r[1]) }
        if let r = gemini.matchEntire(m) { return "Gemini " + r[1] + rest(r[2]) }
        if let r = glm.matchEntire(m) { return "GLM-" + r[1].uppercased() + rest(r[2]) }
        if let r = deepseek.matchEntire(m) { return "DeepSeek " + titleCase(r[1]) }
        if let r = qwen.matchEntire(m) { return "Qwen" + r[1] + rest(r[2].replacingOccurrences(of: ":", with: "-")) }
        if let r = kimi.matchEntire(m) { return "Kimi " + titleCase(r[1]) }
        if let r = grok.matchEntire(m) { return "Grok " + titleCase(r[1]) }
        if let r = llama.matchEntire(m) { return "Llama " + r[1] + rest(r[2]) }
        if let r = minimax.matchEntire(m) { return "MiniMax " + titleCase(r[1]) }
        if let r = mistral.matchEntire(m) { return titleCase(r[1]) + rest(r[2]) }
        return titleCase(m.replacingOccurrences(of: ":", with: "-"))
    }
}
