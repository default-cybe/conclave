import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client ModelPicksTest.kt and ModelPicksRoutesTest.kt: the model picker
// in two levels, routes behind a row, effort variants folded, Cyber access and ultra.

private func m(
    _ provider: String, _ id: String, _ name: String = "", sameAs: String? = nil, via: String? = nil,
    choices: [String]? = nil, vendor: String? = nil, cyber: [String]? = nil
) -> ModelInfo {
    var x = ModelInfo(id: id, ref: "\(provider)/\(id)", provider: provider, name: name, via: via, sameAs: sameAs)
    x.choices = choices
    x.vendor = vendor
    x.cyber = cyber
    return x
}

private func g(_ provider: String, _ models: ModelInfo..., enabled: Bool = true, configured: Bool = true) -> ModelGroup {
    ModelGroup(provider: provider, name: provider, enabled: enabled, configured: configured, models: models)
}

struct ModelPicksTests {
    // the hub's order: Z.ai before Google, GLM also through OpenRouter, a provider that is off, a harness last
    let hub = [
        g("anthropic", m("anthropic", "claude-opus-5-5", "Claude Opus 5.5"), m("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5")),
        g("openai", m("openai", "gpt-5.5", "GPT-5.5")),
        g("zai", m("zai", "glm-5", "GLM-5")),
        g("google", m("google", "gemini-3-pro", "Gemini 3 Pro")),
        g("openrouter", m("openrouter", "z-ai/glm-5.3", "GLM-5.3"), m("openrouter", "anthropic/claude-opus-5-5", "Claude Opus 5.5", sameAs: "anthropic/claude-opus-5-5")),
        g("deepseek", m("deepseek", "deepseek-chat", "DeepSeek V3.2"), enabled: false),
        g("ollama", m("ollama", "llama-4-local", "Llama 4")),
        g("claude-code", m("claude-code", "default", "Claude Code"), m("claude-code", "opus", "Claude Code, Opus")),
        g("codex", m("codex", "default", "Codex"), configured: false),
    ]

    @Test func makersInTheOwnersOrderThenTheOthersThenCodingAgents() {
        let groups = ModelPicks.groups(hub)
        #expect(groups.map(\.key) == ["anthropic", "openai", "google", "zai", "ollama", ModelPicks.agents])
        #expect(groups.map(\.name) == ["Anthropic", "OpenAI", "Google", "Z.ai", "Ollama", "Coding agents"])
        #expect(ModelPicks.rank("zai") < ModelPicks.rank("deepseek"))
        #expect(ModelPicks.rank("cliproxy") < ModelPicks.rank(ModelPicks.agents))
    }

    @Test func eachModelUnderItsMakerOnceWithItsRoute() {
        let groups = ModelPicks.groups(hub)
        let zai = groups.first { $0.key == "zai" }!
        #expect(zai.rows.map(\.ref) == ["zai/glm-5", "openrouter/z-ai/glm-5.3"])
        #expect(zai.rows[1].via == "OpenRouter")
        #expect(zai.rows[0].via == nil)
        #expect(groups[0].rows.map(\.ref) == ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"])
        #expect(groups[0].rows[1].label == "Sonnet 5.5")
        // the same models the flat list offered: off and unset providers and merged copies stay out
        let all = groups.flatMap { $0.rows.map(\.ref) }
        #expect(!all.contains("deepseek/deepseek-chat"))
        #expect(!all.contains("codex/default"))
        #expect(!all.contains("openrouter/anthropic/claude-opus-5-5"))
        #expect(all.count == Set(all).count)
        let harnessOnly = groups.last!.rows.allSatisfy { $0.harness }
        #expect(harnessOnly)
    }

    @Test func opensOnTheMakerOfTheCurrentModel() {
        let groups = ModelPicks.groups(hub)
        #expect(ModelPicks.groupOf(groups, "openrouter/z-ai/glm-5.3") == "zai")
        #expect(ModelPicks.groupOf(groups, "claude-code/opus") == ModelPicks.agents)
        // a stored ref of another route checks the merged row, and opens on its maker
        let shown = ModelPicks.shown(hub, "openrouter/anthropic/claude-opus-5-5")
        #expect(shown == "anthropic/claude-opus-5-5")
        #expect(ModelPicks.groupOf(groups, shown) == "anthropic")
        #expect(ModelPicks.groupOf(groups, nil) == nil)
        #expect(ModelPicks.groupOf(groups, "nowhere/model") == nil)
    }

    @Test func aMakersRowNamesTheCurrentModelElseCountsItsModels() {
        let anthropic = ModelPicks.groups(hub)[0]
        #expect(ModelPicks.note(anthropic, "anthropic/claude-opus-5-5") == "Opus 5.5")
        #expect(ModelPicks.note(anthropic, "openai/gpt-5.5") == "2")
        #expect(ModelPicks.note(anthropic, nil) == "2")
    }

    @Test func searchIsOneFlatListFromEveryMaker() {
        let groups = ModelPicks.groups(hub)
        #expect(ModelPicks.search(groups, "opus").map(\.ref) == ["anthropic/claude-opus-5-5", "claude-code/opus"])
        #expect(ModelPicks.search(groups, " GLM ").map(\.ref) == ["zai/glm-5", "openrouter/z-ai/glm-5.3"])
        #expect(ModelPicks.search(groups, "  ").isEmpty)
        #expect(ModelPicks.search(groups, "zzz").isEmpty)
    }

    @Test func makersMatchTheWeb() {
        #expect(ModelPicks.makerOf("claude-opus-5-5") == "anthropic")
        #expect(ModelPicks.makerOf("gpt-5.5") == "openai")
        #expect(ModelPicks.makerOf("o3") == "openai")
        #expect(ModelPicks.makerOf("gemini-3.1-pro-preview") == "google")
        #expect(ModelPicks.makerOf("z-ai/glm-5.3") == "zai")
        #expect(ModelPicks.makerOf("deepseek-v4-pro") == "deepseek")
        #expect(ModelPicks.makerOf("kimi-k3") == "moonshot")
        #expect(ModelPicks.makerOf("qwen3.8-max") == "qwen")
        #expect(ModelPicks.makerOf("llama-4-local") == nil)
    }
}

struct ModelPicksRoutesTests {
    let hub = [
        g("anthropic", m("anthropic", "claude-opus-5-5", "Claude Opus 5.5", sameAs: "cliproxy/claude-opus-5-5"), m("anthropic", "claude-opus-4-5-20251101", "Claude Opus 4.5 20251101")),
        g(
            "cliproxy",
            m("cliproxy", "claude-opus-5-5", "Claude Opus 5.5", choices: ["cliproxy/neu-claude/claude-opus-5-5"]),
            m("cliproxy", "claude-opus-5-5-high", "claude-opus-5-5-high"),
            m("cliproxy", "claude-opus-4-6-thinking", "Opus 4.6 Thinking"),
            m("cliproxy", "neu-claude/claude-opus-5-5", "Claude Opus 5.5, neu-claude", sameAs: "cliproxy/claude-opus-5-5"),
            m("cliproxy", "gpt-6-sol", "GPT-6-Sol", cyber: ["standard", "daybreak_blue"]),
            m("cliproxy", "gpt-image-2", "gpt-image-2"),
            m("cliproxy", "codex-auto-review", "Review"),
            m("cliproxy", "nova-preview", "Nova", vendor: "openai"),
            m("cliproxy", "muse-spark-1", "Muse Spark")
        ),
    ]
    var groups: [ModelPicks.Group] { ModelPicks.groups(hub) }
    func rows(_ key: String) -> [ModelPicks.Row] { groups.first { $0.key == key }!.rows }

    @Test func oneRowPerModelWithItsRoutesBehindIt() {
        let opus = rows("anthropic").first { $0.ref == "cliproxy/claude-opus-5-5" }!
        #expect(opus.routes.map(\.label) == ["Main accounts", "neu-claude", "High"])
        #expect(opus.routes[0].first)
        #expect(groups.flatMap(\.rows).filter { $0.model.id.hasSuffix("claude-opus-5-5") }.count == 1)
        // a saved ref on the plan's prefix or the variant checks the one row
        #expect(ModelPicks.shownRow(groups, hub, "cliproxy/neu-claude/claude-opus-5-5") == "cliproxy/claude-opus-5-5")
        #expect(ModelPicks.shownRow(groups, hub, "cliproxy/claude-opus-5-5-high") == "cliproxy/claude-opus-5-5")
    }

    @Test func aPlanOfAnotherVendorThatListsOnlyAVariantIsARouteUnderTheModel() {
        // Antigravity (gemini vendor) lists claude-opus-5-5-high only, under its short name backup-gemini
        let ag = "cliproxy/backup-gemini/claude-opus-5-5-high"
        let withAg = hub.map { gr -> ModelGroup in
            guard gr.provider == "cliproxy" else { return gr }
            var out = gr
            out.models = gr.models.filter { $0.id != "claude-opus-5-5-high" } + [m("cliproxy", "backup-gemini/claude-opus-5-5-high", "Claude Opus 5.5 (High), backup-gemini")]
            return out
        }
        let anthropic = ModelPicks.groups(withAg).first { $0.key == "anthropic" }!.rows
        #expect(anthropic.filter { $0.label == "Opus 5.5" }.count == 1)
        let opus = anthropic.first { $0.ref == "cliproxy/claude-opus-5-5" }!
        #expect(opus.routes.map(\.label) == ["Main accounts", "neu-claude", "backup-gemini"])
        #expect(opus.routes.last?.ref == ag)
    }

    @Test func aVariantAloneStandsAsItsModelAndDatesComeOffTheName() {
        let r = rows("anthropic").first { $0.ref == "cliproxy/claude-opus-4-6-thinking" }!
        #expect(r.label == "Opus 4.6")
        #expect(r.routes.map(\.label) == ["Thinking"])
        #expect(!rows("anthropic").first { $0.ref == "anthropic/claude-opus-4-5-20251101" }!.label.contains("2025"))
    }

    @Test func imageAndReviewModelsAreOutAndMakersFollowTheWeb() {
        let all = groups.flatMap(\.rows).map(\.ref)
        #expect(!all.contains("cliproxy/gpt-image-2"))
        #expect(!all.contains("cliproxy/codex-auto-review"))
        #expect(rows("openai").contains { $0.ref == "cliproxy/nova-preview" })
        #expect(rows("meta").contains { $0.ref == "cliproxy/muse-spark-1" })
        #expect(ModelPicks.makerOf("glm-5") == "zai")
        #expect(ModelPicks.makerOf("gpt-oss-120b-medium") == "openai")
    }

    @Test func cyberAccessAndUltra() {
        let sol = rows("openai").first { $0.ref == "cliproxy/gpt-6-sol" }!.model
        #expect(CyberAccess.choices(sol) == [nil, "standard", "daybreak_blue"])
        #expect(CyberAccess.label("daybreak_blue") == "Daybreak Blue")
        #expect(CyberAccess.choices(rows("anthropic")[0].model).isEmpty)
        let plan = ModelEffort(levels: ["low", "medium", "high", "xhigh", "ultra"], defaultLevel: "medium")
        #expect(Effort.choices(plan).last == .ultra)
        #expect(ThinkingLevel(rawValue: "ultra") == .ultra)
    }
}
