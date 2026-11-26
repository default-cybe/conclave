import Foundation

/// The model picker in two levels, as on the web and Android (logic/ModelPicks.kt): one row per
/// maker (Anthropic, OpenAI, Google, Z.ai, the others, the coding agents last), a maker's models
/// behind it, one flat list while searching. A model sits under its maker whatever route reaches it.
public enum ModelPicks {
    /// The key of the coding agents' row.
    public static let agents = "harness"

    /// One way to reach a row's model: its own ref first, a plan's prefix, another provider, an effort variant.
    public struct Route: Sendable, Hashable {
        public var ref: String
        public var label: String
        public var first = false

        public init(_ ref: String, _ label: String, first: Bool = false) {
            self.ref = ref
            self.label = label
            self.first = first
        }
    }

    public struct Row: Sendable, Hashable {
        public var ref: String
        public var model: ModelInfo
        public var label: String
        public var via: String?
        public var harness: Bool
        public var routes: [Route] = []
    }

    public struct Group: Sendable, Hashable {
        public var key: String
        public var name: String
        public var rows: [Row]
    }

    private static let makers: [(Pattern, String)] = [
        (Pattern("claude"), "anthropic"),
        (Pattern("gpt|(^|/)o\\d|codex"), "openai"),
        (Pattern("gemini|gemma"), "google"),
        (Pattern("glm"), "zai"),
        (Pattern("muse"), "meta"),
        (Pattern("deepseek"), "deepseek"),
        (Pattern("kimi|moonshot"), "moonshot"),
        (Pattern("qwen"), "qwen"),
        (Pattern("mistral|codestral|devstral"), "mistral"),
        (Pattern("grok"), "xai"),
    ]

    public static func makerOf(_ id: String) -> String? {
        let s = id.lowercased()
        return makers.first { $0.0.contains(s) }?.1
    }

    /// A model's maker: by its id, else the vendor of the plan that lists it (gemini is Google's).
    public static func makerOf(_ m: ModelInfo) -> String? {
        makerOf(m.id) ?? m.vendor.map { $0 == "gemini" ? "google" : $0 }
    }

    private static let nonChat = Pattern("(^|/)(gpt-image|codex-auto-review|dall-e|whisper|tts-)|-image(-|$)|embedding", ignoreCase: true)

    /// Image generators, review models and embeddings are not chat models.
    public static func isChatModel(_ id: String) -> Bool { !nonChat.contains(id) }

    /// An effort or thinking variant of one model ("claude-opus-5-5-high").
    private static let variant = Pattern("-(minimal|low|medium|high|xhigh|thinking)$", ignoreCase: true)

    private static func bare(_ id: String) -> String { id.afterLast("/").lowercased() }

    /// The words for a route: a plan's short name, "Main accounts" for plans without one, else the provider.
    public static func routeLabel(_ ref: String) -> String {
        let provider = ref.before("/")
        let id = ref.after("/")
        let account = id.contains("/") ? id.beforeLast("/", or: "") : ""
        return provider == "cliproxy" ? (account.isEmpty ? "Main accounts" : account) : ModelRefs.providerName(provider)
    }

    /// A ref through one plan's prefix ("cliproxy/backup-gemini/claude-opus-5-5-high").
    private static func onPlan(_ ref: String) -> Bool { ref.hasPrefix("cliproxy/") && ref.removingPrefix("cliproxy/").contains("/") }

    /// Effort and thinking variants fold under their model's row as routes ("High", "Thinking").
    /// A variant whose model is not listed becomes the row, named as the model.
    public static func foldVariants(_ rows: [Row]) -> [Row] {
        var base: [String: Row] = [:]
        for r in rows where !r.harness && !variant.contains(bare(r.model.id)) { base[bare(r.model.id)] = r }
        var order: [String] = []
        var out: [String: Row] = [:]
        for r in rows {
            let id = bare(r.model.id)
            let m = variant.find(id)
            guard !r.harness, let m else {
                // a variant listed before its model already put its route on it
                if !r.harness, let b = base[id], b.ref == r.ref { out[r.ref] = b } else { out[r.ref] = r }
                order.append(r.ref)
                continue
            }
            let w = m[1].lowercased()
            let word = w == "xhigh" ? "Extra high" : w.capitalizedFirst
            let key = id.removingSuffix(m[0].lowercased())
            if let host = base[key] {
                let now = out[host.ref] ?? host
                let had = now.routes.isEmpty ? [Route(now.ref, "Default", first: true)] : now.routes
                // a plan the row does not reach yet that lists only a variant: one more route, by the variant's own id
                var reached = Set(had.map { routeLabel($0.ref) })
                let plans = ([r.ref] + (r.model.choices ?? [])).filter { onPlan($0) && reached.insert(routeLabel($0)).inserted }
                var next = now
                next.routes = had + (plans.contains(r.ref) ? [] : [Route(r.ref, word)]) + plans.map { Route($0, routeLabel($0)) }
                out[host.ref] = next
                base[key] = next
                continue
            }
            var row = r
            row.label = Pattern("[\\s-]\(NSRegularExpression.escapedPattern(for: m[1]))$", ignoreCase: true).replace(r.label, with: "")
            row.routes = [Route(r.ref, word, first: true)] + (r.model.choices ?? []).map { Route($0, routeLabel($0)) }
            base[key] = row
            out[r.ref] = row
            order.append(r.ref)
        }
        return order.compactMap { out[$0] }
    }

    private static let firstMakers = ["anthropic", "openai", "google", "zai"]
    private static let providers = ["anthropic", "openai", "zai", "google", "openrouter", "deepseek", "moonshot", "ollama", "mistral", "groq", "xai", "lmstudio", "qwen"]

    /// Place on the first level: Anthropic, OpenAI, Google, Z.ai, then the others, coding agents last.
    public static func rank(_ key: String) -> Int {
        if key == agents { return 10_000 }
        if let i = firstMakers.firstIndex(of: key) { return i }
        if let i = providers.firstIndex(of: key) { return firstMakers.count + i }
        return 1_000
    }

    private static let snapshot = Pattern("[\\s-]\\(?\\d{8}\\)?$")

    /// A row's name: the hub's name without the maker's prefix ("Sonnet 5.5"), else one made from the ref.
    public static func label(_ m: ModelInfo) -> String {
        let named = !m.name.isEmpty && m.name.lowercased() != m.id.lowercased()
        let name = named ? ModelRefs.cleanName(m.name) : ModelRefs.displayName(m.fullRef)
        // a plan's prefix is a route, not part of the name; a dated snapshot reads as its model
        let account = m.id.beforeLast("/", or: "")
        let plain = !account.isEmpty && name.hasSuffix(", \(account)") ? name.removingSuffix(", \(account)") : name
        return snapshot.replace(plain, with: "")
    }

    /// The makers and their models: providers that are on and set up, each model once.
    public static func groups(_ all: [ModelGroup]) -> [Group] {
        var seen = Set<String>()
        let offered = all.filter { $0.enabled && $0.configured && seen.insert($0.provider).inserted }
            .enumerated().sorted { (rank($0.element.provider), $0.offset) < (rank($1.element.provider), $1.offset) }.map(\.element)
        var byMaker: [(key: String, rows: [Row])] = []
        var agentRows: [Row] = []
        for g in offered {
            let harness = ModelRefs.isHarness(g.provider)
            for m in g.models where m.sameAs == nil && isChatModel(m.id) {
                if harness {
                    agentRows.append(Row(ref: m.fullRef, model: m, label: label(m), via: m.via, harness: true))
                    continue
                }
                let maker = makerOf(m) ?? g.provider
                // a custom provider goes by its config name, else the known name or its id
                let via = m.via ?? (maker != g.provider ? (!g.name.isEmpty && g.name != g.provider ? g.name : ModelRefs.providerName(g.provider)) : nil)
                let choices = m.choices ?? []
                let routes = choices.isEmpty ? [] : [Route(m.fullRef, routeLabel(m.fullRef), first: true)] + choices.map { Route($0, routeLabel($0)) }
                let row = Row(ref: m.fullRef, model: m, label: label(m), via: via, harness: false, routes: routes)
                if let i = byMaker.firstIndex(where: { $0.key == maker }) { byMaker[i].rows.append(row) } else { byMaker.append((maker, [row])) }
            }
        }
        let made = byMaker.enumerated()
            .sorted { (rank($0.element.key), $0.offset) < (rank($1.element.key), $1.offset) }
            .map { Group(key: $0.element.key, name: ModelRefs.providerName($0.element.key), rows: foldVariants(unique($0.element.rows))) }
        return agentRows.isEmpty ? made : made + [Group(key: agents, name: "Coding agents", rows: unique(agentRows))]
    }

    private static func unique(_ rows: [Row]) -> [Row] {
        var seen = Set<String>()
        return rows.filter { seen.insert($0.ref).inserted }
    }

    /// The ref the picker checks for a stored one: the merged row it points at, else itself.
    public static func shown(_ all: [ModelGroup], _ ref: String?) -> String? {
        guard let ref else { return nil }
        return all.lazy.flatMap(\.models).first { $0.fullRef == ref }?.sameAs ?? ref
    }

    /// The row whose routes hold [ref] (a variant, a plan's prefix), else `shown`.
    public static func shownRow(_ groups: [Group], _ all: [ModelGroup], _ ref: String?) -> String? {
        guard let s = shown(all, ref) else { return nil }
        return groups.lazy.flatMap(\.rows).first { r in r.ref == s || r.routes.contains { $0.ref == ref } }?.ref ?? s
    }

    /// The maker that holds [ref]: where the picker opens.
    public static func groupOf(_ groups: [Group], _ ref: String?) -> String? {
        guard let ref else { return nil }
        return groups.first { g in g.rows.contains { $0.ref == ref } }?.key
    }

    /// What a maker's row says at the right: the current model's name when it is there, else how many models.
    public static func note(_ g: Group, _ current: String?) -> String {
        g.rows.first { $0.ref == current }?.label ?? String(g.rows.count)
    }

    /// Every model whose name or ref has [query] in it, from every maker, as one list. Blank: none.
    public static func search(_ groups: [Group], _ query: String) -> [Row] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return groups.flatMap(\.rows).filter {
            $0.label.lowercased().contains(q) || $0.model.name.lowercased().contains(q) || $0.ref.lowercased().contains(q)
        }
    }
}
