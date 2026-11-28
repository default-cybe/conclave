import Foundation

/// A provider that takes an API key (web lib/providers.ts PROVIDERS, the keyed ones).
public struct KeyProvider: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let description: String
    public let keyPrefix: String?
}

/// Settings > Providers and Subscriptions words and choices (Android logic/Providers.kt, web
/// settings/providers.tsx and components/subscriptions), kept here so they are tested.
public enum Providers {
    /// The providers the web's Add a provider menu offers with a key, in its order.
    public static let keyed: [KeyProvider] = [
        KeyProvider(id: "anthropic", name: "Anthropic", description: "Claude models with an API key", keyPrefix: "sk-ant-"),
        KeyProvider(id: "openai", name: "OpenAI", description: "GPT and o-series models", keyPrefix: "sk-proj-"),
        KeyProvider(id: "zai", name: "Z.ai", description: "GLM Coding plan", keyPrefix: nil),
        KeyProvider(id: "google", name: "Google Gemini", description: "Gemini through AI Studio", keyPrefix: "AIza"),
        KeyProvider(id: "openrouter", name: "OpenRouter", description: "One key for hundreds of models", keyPrefix: "sk-or-"),
        KeyProvider(id: "deepseek", name: "DeepSeek", description: "DeepSeek V3 and R1", keyPrefix: "sk-"),
        KeyProvider(id: "moonshot", name: "Moonshot", description: "Kimi models", keyPrefix: "sk-"),
        KeyProvider(id: "mistral", name: "Mistral", description: "Mistral and Codestral", keyPrefix: nil),
        KeyProvider(id: "groq", name: "Groq", description: "Fast open models", keyPrefix: "gsk_"),
        KeyProvider(id: "xai", name: "xAI", description: "Grok models", keyPrefix: "xai-"),
        KeyProvider(id: "qwen", name: "Qwen", description: "Qwen through Alibaba Cloud", keyPrefix: "sk-"),
    ]

    public static func info(_ id: String) -> KeyProvider? { keyed.first { $0.id == id } }

    public static func name(_ id: String) -> String { info(id)?.name ?? id }

    public static func placeholder(_ id: String) -> String { info(id)?.keyPrefix.map { "Paste a key that starts with \($0)" } ?? "Paste a key" }

    /// Providers with a key saved on the hub (secrets.providers) or from its config or environment (secrets.keyed).
    public static func withKeys(_ secrets: JSONValue?) -> Set<String> {
        var out: Set<String> = []
        for k in ["providers", "keyed"] {
            if case .array(let a)? = secrets?[k] { for v in a { if let s = v.string { out.insert(s) } } }
        }
        return out
    }

    /// The owner's rows: every catalog provider with a key, then other keyed (custom) ones, sorted. cliproxy is on Subscriptions.
    public static func keyedRows(_ withKeys: Set<String>) -> [String] {
        let ids = keyed.map(\.id)
        return ids.filter(withKeys.contains) + withKeys.filter { !ids.contains($0) && $0 != "cliproxy" }.sorted()
    }

    public static func addable(_ rows: [String]) -> [KeyProvider] { keyed.filter { !rows.contains($0.id) } }

    /// "Works, 7 models, 212 ms", "Rejected, 401" or "Not set" (web ProviderResultWords), and whether it worked.
    public static func testWords(_ r: ProviderTestResult) -> (String, Bool) {
        if r.ok {
            let d = r.detail.replacingOccurrences(of: #"^[Ff]ound\s+"#, with: "", options: .regularExpression)
            return ("Works, " + d + (r.latencyMs.map { ", \($0) ms" } ?? ""), true)
        }
        if r.detail.range(of: "no key set", options: .caseInsensitive) != nil { return ("Not set", false) }
        let code = r.detail.range(of: #"\b[45]\d\d\b"#, options: .regularExpression).map { ", " + r.detail[$0] } ?? ""
        return ("Rejected" + code, false)
    }

    // MARK: subscriptions

    public enum Tone: Sendable { case ok, live, dim, warn, fault }

    /// An account's state word (web lib/subscriptions.ts ACCOUNT_WORD).
    public static func accountWord(_ state: String) -> (String, Tone) {
        switch state {
        case "active": ("Active", .ok)
        case "refreshing": ("Refreshing", .live)
        case "disabled": ("Turned off", .dim)
        case "unavailable": ("Limited", .warn)
        case "error": ("Failed", .fault)
        default: ("Unknown", .dim)
        }
    }

    public static func accountLabel(_ a: SubscriptionAccount) -> String { a.label.flatMap { $0.isEmpty ? nil : $0 } ?? a.providerName }

    /// "Not signed in", the one account, or "2 accounts".
    public static func who(_ s: SubscriptionsStatus, _ p: SubscriptionProvider) -> String {
        let mine = s.accounts.filter { $0.provider == p.id }
        switch mine.count {
        case 0: return "Not signed in"
        case 1: return accountLabel(mine[0])
        default: return "\(mine.count) accounts"
        }
    }

    public static func action(_ s: SubscriptionsStatus, _ p: SubscriptionProvider) -> String {
        s.accounts.contains { $0.provider == p.id } ? "Add account" : "Sign in"
    }

    /// Sign in works: off (the first sign-in starts the built-in one), or a CLIProxyAPI whose management answers.
    public static func usable(_ s: SubscriptionsStatus) -> Bool { s.mode == "off" || s.management }

    /// Start the built-in CLIProxyAPI first: it is off, or not answering yet.
    public static func needsStart(_ s: SubscriptionsStatus) -> Bool { s.mode == "off" || s.state != "on" }

    /// The main rows, then the "More" ones once `more` (open by itself while one of those has an account).
    public static func rows(_ s: SubscriptionsStatus, more: Bool) -> [SubscriptionProvider] {
        more || s.providers.contains { $0.more && $0.accounts > 0 } ? s.providers : s.providers.filter { !$0.more }
    }

    /// A redirect sign-in the hub does not catch (a phone or tablet always): paste the address.
    public static func needsPaste(_ start: SignInStart) -> Bool { start.flow == "redirect" && !start.caught }

    public static func waitingLine(_ start: SignInStart, name: String) -> String {
        if start.flow == "device" { return "Type this code on the \(name) page that opened. This updates by itself when you are done." }
        if needsPaste(start) {
            return "\(name) ends on a \(start.callbackHost ?? "localhost") page that will not load on this device, because the hub is on another computer. Copy that page's address from the browser bar and paste it here."
        }
        return "The \(name) sign-in opened in the browser. Finish there and come back; this updates by itself."
    }

    /// The status line over the rows (web statusSentence): the word and the rest.
    public static func statusLine(_ s: SubscriptionsStatus) -> (String, String) {
        let n = s.accounts.count
        let accounts = n == 0 ? "No account is signed in yet." : n == 1 ? "One account is signed in." : "\(n) accounts are signed in."
        switch s.state {
        case "on": return ("On.", accounts)
        case "installing": return ("Installing.", s.detail ?? "Downloading CLIProxyAPI.")
        case "starting": return ("Starting.", s.detail ?? "Starting CLIProxyAPI.")
        case "error": return ("Not working.", s.error ?? "CLIProxyAPI does not answer.")
        default: return ("Off.", "The first sign-in starts CLIProxyAPI on the hub.")
        }
    }
}
