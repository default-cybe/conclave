package dev.conclave.client

import dev.conclave.client.logic.ModelPicks
import dev.conclave.client.logic.PickerTabs
import dev.conclave.client.logic.PickerTabs.Item
import dev.conclave.client.logic.PickerTabs.Section
import dev.conclave.client.logic.PickerTabs.Tab
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ModelInfo
import dev.conclave.client.model.Session
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The model picker's tabs and list (logic/PickerTabs.kt), the same rules as
 * the web's ModelPicker.tsx and test/model-picker.test.tsx: provider tabs,
 * Pinned, then Recent, then the tab's models most capable first, and a
 * search across every tab.
 */
class PickerTabsTest {
    private fun m(provider: String, id: String, name: String, tier: String? = null, ctx: Long = 0, out: Double = 0.0) =
        ModelInfo(id = id, ref = "$provider/$id", provider = provider, name = name, tier = tier, contextWindow = ctx, outputPrice = out)

    private fun g(provider: String, vararg models: ModelInfo) = ModelGroup(provider = provider, name = provider, configured = true, enabled = true, models = models.toList())

    private val hub = listOf(
        g(
            "anthropic",
            m("anthropic", "claude-opus-5-5", "Claude Opus 5.5", tier = "deep", ctx = 1_000_000, out = 25.0),
            m("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", tier = "smart", ctx = 1_000_000, out = 15.0),
            m("anthropic", "claude-haiku-5", "Claude Haiku 5", tier = "fast", ctx = 200_000, out = 5.0),
        ),
        g("openai", m("openai", "gpt-5.5", "GPT-5.5", tier = "deep", ctx = 400_000, out = 10.0)),
        g("zai", m("zai", "glm-5", "GLM-5", tier = "smart", ctx = 200_000, out = 3.0)),
        g("ollama", m("ollama", "llama-4-local", "Llama 4"), m("ollama", "gemma-3", "Gemma 3")),
        g("deepseek", m("deepseek", "deepseek-chat", "DeepSeek V3.2", ctx = 128_000, out = 1.0)),
        g("claude-code", m("claude-code", "default", "Claude Code")),
    )

    private val entries = PickerTabs.entries(ModelPicks.groups(hub))

    private fun refs(items: List<Item>, section: Section? = null) =
        items.filterIsInstance<Item.Model>().filter { section == null || it.section == section }.map { it.entry.row.ref }

    private fun heads(items: List<Item>) = items.filterIsInstance<Item.Head>().map { it.label }

    @Test
    fun eachModelInItsTabLocalByServerAndCodingAgentsApart() {
        val tabOf = entries.associate { it.row.ref to it.tab }
        assertEquals(Tab.ANTHROPIC, tabOf["anthropic/claude-opus-5-5"])
        assertEquals(Tab.OPENAI, tabOf["openai/gpt-5.5"])
        assertEquals(Tab.ZAI, tabOf["zai/glm-5"])
        // a local server's model is Local, whoever made it (Gemma is Google's)
        assertEquals(Tab.LOCAL, tabOf["ollama/gemma-3"])
        assertEquals(Tab.LOCAL, tabOf["ollama/llama-4-local"])
        assertEquals(Tab.OTHER, tabOf["deepseek/deepseek-chat"])
        assertEquals(Tab.AGENTS, tabOf["claude-code/default"])
    }

    @Test
    fun onlyTabsWithModelsShowInOrder() {
        assertEquals(listOf(Tab.ALL, Tab.ANTHROPIC, Tab.OPENAI, Tab.ZAI, Tab.LOCAL, Tab.AGENTS, Tab.OTHER), PickerTabs.shownTabs(entries))
        assertEquals(listOf("All", "Anthropic", "OpenAI", "Z.ai", "Local", "Coding agents", "Other"), PickerTabs.shownTabs(entries).map { it.label })
        assertEquals(Tab.ZAI, PickerTabs.tabFor(entries, "zai/glm-5"))
        assertEquals(Tab.ALL, PickerTabs.tabFor(entries, null))
    }

    @Test
    fun mostCapableFirstByTierThenContextThenPrice() {
        val all = PickerTabs.items(entries, "", Tab.ALL)
        assertEquals(
            listOf(
                "anthropic/claude-opus-5-5", // deep, 1M
                "openai/gpt-5.5", // deep, 400K
                "anthropic/claude-sonnet-5-5", // smart, 1M
                "zai/glm-5", // smart, 200K
                "anthropic/claude-haiku-5", // fast
                "deepseek/deepseek-chat", // no tier, 128K
            ),
            refs(all).take(6),
        )
        // coding agents last
        assertEquals("claude-code/default", refs(all).last())
        assertEquals(listOf("All models, most capable first"), heads(all))
        assertEquals(listOf("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5"), refs(PickerTabs.items(entries, "", Tab.ANTHROPIC)))
        assertEquals(listOf("Anthropic, most capable first"), heads(PickerTabs.items(entries, "", Tab.ANTHROPIC)))
    }

    @Test
    fun withinAFamilyTheNewerVersionFirst() {
        assertTrue(PickerTabs.compareModels("claude-opus-5-5", "claude-opus-4-1") < 0)
        assertTrue(PickerTabs.compareModels("claude-opus-5", "claude-sonnet-5") < 0)
        assertTrue(PickerTabs.compareModels("gpt-5.5", "gpt-5.5-20260101") < 0)
    }

    @Test
    fun pinnedThenRecentThenTheList() {
        val items = PickerTabs.items(entries, "", Tab.ALL, pinned = listOf("zai/glm-5"), recent = listOf("zai/glm-5", "openai/gpt-5.5", "ollama/gemma-3", "anthropic/claude-haiku-5", "claude-code/default"))
        assertEquals(listOf("Pinned", "Recent", "All models, most capable first"), heads(items))
        assertEquals(listOf("zai/glm-5"), refs(items, Section.PIN))
        // a pin is not repeated in Recent; three at most
        assertEquals(listOf("openai/gpt-5.5", "ollama/gemma-3", "anthropic/claude-haiku-5"), refs(items, Section.RECENT))
        // the ranked list still holds every model, the pinned one too
        assertTrue("zai/glm-5" in refs(items, Section.LIST))
        // in a tab, pins and Recent of other tabs stay out
        val local = PickerTabs.items(entries, "", Tab.LOCAL, pinned = listOf("zai/glm-5"), recent = listOf("ollama/gemma-3"))
        assertEquals(listOf("Recent", "Local, most capable first"), heads(local))
        assertEquals(listOf("ollama/gemma-3"), refs(local, Section.RECENT))
    }

    @Test
    fun aSearchSpansEveryTabWithNoPinnedOrRecent() {
        val found = PickerTabs.items(entries, "claude", Tab.LOCAL, pinned = listOf("anthropic/claude-haiku-5"), recent = listOf("anthropic/claude-opus-5-5"))
        assertEquals(listOf("Matches for \"claude\""), heads(found))
        assertEquals(listOf("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5", "claude-code/default"), refs(found))
        assertTrue(PickerTabs.items(entries, "nothing like this", Tab.ALL).isEmpty())
    }

    @Test
    fun pinTogglesAndKeepsAtMostFifty() {
        assertEquals(listOf("a/x", "b/y"), PickerTabs.togglePin(listOf("a/x"), "b/y"))
        assertEquals(listOf("b/y"), PickerTabs.togglePin(listOf("a/x", "b/y"), "a/x"))
        val full = (1..PickerTabs.PINS_MAX).map { "p/m$it" }
        val next = PickerTabs.togglePin(full, "p/new")
        assertEquals(PickerTabs.PINS_MAX, next.size)
        assertEquals("p/new", next.last())
        assertEquals("p/m2", next.first())
    }

    @Test
    fun recentIsTheLastDistinctModelsNewestFirst() {
        val sessions = listOf(
            Session(id = "1", model = "openai/gpt-5.5", updatedAt = 1),
            Session(id = "2", model = "zai/glm-5", updatedAt = 3),
            Session(id = "3", model = "openai/gpt-5.5", updatedAt = 2),
            Session(id = "4", model = "", updatedAt = 4),
        )
        assertEquals(listOf("zai/glm-5", "openai/gpt-5.5"), PickerTabs.recent(sessions))
    }
}
