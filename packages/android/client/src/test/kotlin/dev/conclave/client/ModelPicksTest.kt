package dev.conclave.client

import dev.conclave.client.logic.ModelPicks
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ModelInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The model picker in two levels (logic/ModelPicks.kt, the web's
 * ModelPicker.tsx): a row per maker in the owner's order, a maker's models
 * behind it, the maker of the current model to open on, and one flat list
 * while searching.
 */
class ModelPicksTest {
    private fun m(provider: String, id: String, name: String = "", sameAs: String? = null, via: String? = null) =
        ModelInfo(id = id, ref = "$provider/$id", provider = provider, name = name, sameAs = sameAs, via = via)

    private fun g(provider: String, vararg models: ModelInfo, enabled: Boolean = true, configured: Boolean = true) =
        ModelGroup(provider = provider, name = provider, configured = configured, enabled = enabled, models = models.toList())

    // the hub's order: Z.ai before Google, GLM also through OpenRouter, a provider that is off, a harness last
    private val hub = listOf(
        g("anthropic", m("anthropic", "claude-opus-5-5", "Claude Opus 5.5"), m("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5")),
        g("openai", m("openai", "gpt-5.5", "GPT-5.5")),
        g("zai", m("zai", "glm-5", "GLM-5")),
        g("google", m("google", "gemini-3-pro", "Gemini 3 Pro")),
        g("openrouter", m("openrouter", "z-ai/glm-5.3", "GLM-5.3"), m("openrouter", "anthropic/claude-opus-5-5", "Claude Opus 5.5", sameAs = "anthropic/claude-opus-5-5")),
        g("deepseek", m("deepseek", "deepseek-chat", "DeepSeek V3.2"), enabled = false),
        g("ollama", m("ollama", "llama-4-local", "Llama 4")),
        g("claude-code", m("claude-code", "default", "Claude Code"), m("claude-code", "opus", "Claude Code, Opus")),
        g("codex", m("codex", "default", "Codex"), configured = false),
    )

    @Test
    fun makersInTheOwnersOrderThenTheOthersThenCodingAgents() {
        val groups = ModelPicks.groups(hub)
        assertEquals(listOf("anthropic", "openai", "google", "zai", "ollama", ModelPicks.AGENTS), groups.map { it.key })
        assertEquals(listOf("Anthropic", "OpenAI", "Google", "Z.ai", "Ollama", "Coding agents"), groups.map { it.name })
        assertTrue(ModelPicks.rank("zai") < ModelPicks.rank("deepseek"))
        assertTrue(ModelPicks.rank("cliproxy") < ModelPicks.rank(ModelPicks.AGENTS))
    }

    @Test
    fun eachModelUnderItsMakerOnceWithItsRoute() {
        val groups = ModelPicks.groups(hub)
        val zai = groups.first { it.key == "zai" }
        assertEquals(listOf("zai/glm-5", "openrouter/z-ai/glm-5.3"), zai.rows.map { it.ref })
        assertEquals("OpenRouter", zai.rows[1].via)
        assertNull(zai.rows[0].via)
        assertEquals(listOf("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"), groups.first().rows.map { it.ref })
        assertEquals("Sonnet 5.5", groups.first().rows[1].label)
        // the same models the flat list offered: off and unset providers and merged copies stay out
        val all = groups.flatMap { g -> g.rows.map { it.ref } }
        assertFalse("deepseek/deepseek-chat" in all)
        assertFalse("codex/default" in all)
        assertFalse("openrouter/anthropic/claude-opus-5-5" in all)
        assertEquals(all.size, all.toSet().size)
        assertTrue(groups.last().rows.all { it.harness })
    }

    @Test
    fun opensOnTheMakerOfTheCurrentModel() {
        val groups = ModelPicks.groups(hub)
        assertEquals("zai", ModelPicks.groupOf(groups, "openrouter/z-ai/glm-5.3"))
        assertEquals(ModelPicks.AGENTS, ModelPicks.groupOf(groups, "claude-code/opus"))
        // a stored ref of another route checks the merged row, and opens on its maker
        val shown = ModelPicks.shown(hub, "openrouter/anthropic/claude-opus-5-5")
        assertEquals("anthropic/claude-opus-5-5", shown)
        assertEquals("anthropic", ModelPicks.groupOf(groups, shown))
        assertNull(ModelPicks.groupOf(groups, null))
        assertNull(ModelPicks.groupOf(groups, "nowhere/model"))
    }

    @Test
    fun aMakersRowNamesTheCurrentModelElseCountsItsModels() {
        val anthropic = ModelPicks.groups(hub).first()
        assertEquals("Opus 5.5", ModelPicks.note(anthropic, "anthropic/claude-opus-5-5"))
        assertEquals("2", ModelPicks.note(anthropic, "openai/gpt-5.5"))
        assertEquals("2", ModelPicks.note(anthropic, null))
    }

    @Test
    fun searchIsOneFlatListFromEveryMaker() {
        val groups = ModelPicks.groups(hub)
        assertEquals(listOf("anthropic/claude-opus-5-5", "claude-code/opus"), ModelPicks.search(groups, "opus").map { it.ref })
        assertEquals(listOf("zai/glm-5", "openrouter/z-ai/glm-5.3"), ModelPicks.search(groups, " GLM ").map { it.ref })
        assertTrue(ModelPicks.search(groups, "  ").isEmpty())
        assertTrue(ModelPicks.search(groups, "zzz").isEmpty())
    }

    @Test
    fun makersMatchTheWeb() {
        assertEquals("anthropic", ModelPicks.makerOf("claude-opus-5-5"))
        assertEquals("openai", ModelPicks.makerOf("gpt-5.5"))
        assertEquals("openai", ModelPicks.makerOf("o3"))
        assertEquals("google", ModelPicks.makerOf("gemini-3.1-pro-preview"))
        assertEquals("zai", ModelPicks.makerOf("z-ai/glm-5.3"))
        assertEquals("deepseek", ModelPicks.makerOf("deepseek-v4-pro"))
        assertEquals("moonshot", ModelPicks.makerOf("kimi-k3"))
        assertEquals("qwen", ModelPicks.makerOf("qwen3.8-max"))
        assertNull(ModelPicks.makerOf("llama-4-local"))
    }
}
