package dev.conclave.client

import dev.conclave.client.logic.CyberAccess
import dev.conclave.client.logic.Effort
import dev.conclave.client.logic.ModelPicks
import dev.conclave.client.model.ModelEffort
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ModelInfo
import dev.conclave.client.model.ThinkingLevel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The picker rules the web has (components/pickers/ModelPicker.tsx): routes
 * behind a row instead of rows, a plan-listed model under its vendor, effort
 * variants folded, image and review models out, dates off the names, Cyber
 * access per model, and ultra as a level.
 */
class ModelPicksRoutesTest {
    private fun m(provider: String, id: String, name: String = "", sameAs: String? = null, choices: List<String>? = null, vendor: String? = null, cyber: List<String>? = null) =
        ModelInfo(id = id, ref = "$provider/$id", provider = provider, name = name, sameAs = sameAs, choices = choices, vendor = vendor, cyber = cyber)

    private fun g(provider: String, vararg models: ModelInfo) = ModelGroup(provider = provider, enabled = true, configured = true, models = models.toList())

    private val hub = listOf(
        g("anthropic", m("anthropic", "claude-opus-5-5", "Claude Opus 5.5", sameAs = "cliproxy/claude-opus-5-5"), m("anthropic", "claude-opus-4-5-20251101", "Claude Opus 4.5 20251101")),
        g(
            "cliproxy",
            m("cliproxy", "claude-opus-5-5", "Claude Opus 5.5", choices = listOf("cliproxy/neu-claude/claude-opus-5-5")),
            m("cliproxy", "claude-opus-5-5-high", "claude-opus-5-5-high"),
            m("cliproxy", "claude-opus-4-6-thinking", "Opus 4.6 Thinking"),
            m("cliproxy", "neu-claude/claude-opus-5-5", "Claude Opus 5.5, neu-claude", sameAs = "cliproxy/claude-opus-5-5"),
            m("cliproxy", "gpt-6-sol", "GPT-6-Sol", cyber = listOf("standard", "daybreak_blue")),
            m("cliproxy", "gpt-image-2", "gpt-image-2"),
            m("cliproxy", "codex-auto-review", "Review"),
            m("cliproxy", "nova-preview", "Nova", vendor = "openai"),
            m("cliproxy", "muse-spark-1", "Muse Spark"),
        ),
    )
    private val groups = ModelPicks.groups(hub)
    private fun rows(key: String) = groups.first { it.key == key }.rows

    @Test
    fun oneRowPerModelWithItsRoutesBehindIt() {
        val opus = rows("anthropic").first { it.ref == "cliproxy/claude-opus-5-5" }
        assertEquals(listOf("Main accounts", "neu-claude", "High"), opus.routes.map { it.label })
        assertTrue(opus.routes.first().first)
        assertEquals(1, groups.flatMap { it.rows }.count { it.model.id.endsWith("claude-opus-5-5") })
        // a saved ref on the plan's prefix or the variant checks the one row
        assertEquals("cliproxy/claude-opus-5-5", ModelPicks.shownRow(groups, hub, "cliproxy/neu-claude/claude-opus-5-5"))
        assertEquals("cliproxy/claude-opus-5-5", ModelPicks.shownRow(groups, hub, "cliproxy/claude-opus-5-5-high"))
    }

    @Test
    fun aVariantAloneStandsAsItsModelAndDatesComeOffTheName() {
        val r = rows("anthropic").first { it.ref == "cliproxy/claude-opus-4-6-thinking" }
        assertEquals("Opus 4.6", r.label)
        assertEquals(listOf("Thinking"), r.routes.map { it.label })
        assertFalse(rows("anthropic").first { it.ref == "anthropic/claude-opus-4-5-20251101" }.label.contains("2025"))
    }

    @Test
    fun imageAndReviewModelsAreOutAndMakersFollowTheWeb() {
        val all = groups.flatMap { it.rows }.map { it.ref }
        assertFalse("cliproxy/gpt-image-2" in all)
        assertFalse("cliproxy/codex-auto-review" in all)
        assertTrue(rows("openai").any { it.ref == "cliproxy/nova-preview" })
        assertTrue(rows("meta").any { it.ref == "cliproxy/muse-spark-1" })
        assertEquals("zai", ModelPicks.makerOf("glm-5"))
        assertEquals("openai", ModelPicks.makerOf("gpt-oss-120b-medium"))
    }

    @Test
    fun cyberAccessAndUltra() {
        val sol = rows("openai").first { it.ref == "cliproxy/gpt-6-sol" }.model
        assertEquals(listOf(null, "standard", "daybreak_blue"), CyberAccess.choices(sol))
        assertEquals("Daybreak Blue", CyberAccess.label("daybreak_blue"))
        assertEquals(emptyList<String?>(), CyberAccess.choices(rows("anthropic").first().model))
        val plan = ModelEffort(levels = listOf("low", "medium", "high", "xhigh", "ultra"), defaultLevel = "medium")
        assertEquals(ThinkingLevel.ULTRA, Effort.choices(plan).last())
        assertEquals(ThinkingLevel.ULTRA, ThinkingLevel.from("ultra"))
    }
}
