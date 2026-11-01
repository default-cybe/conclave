package dev.conclave.client

import dev.conclave.client.MapFixture.I
import dev.conclave.client.map.MapLabels
import dev.conclave.client.map.MapLayouts
import dev.conclave.client.map.NodeMeta
import dev.conclave.client.model.MapNodeKind
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A node's words on the Map (map/MapLabels.kt), the same cases as the web's
 * test/map-model.test.ts "node labels": short names from real titles, and
 * the line under them.
 */
class MapLabelsTest {
    private val now = Instant.parse("2026-10-20T15:00:00Z").toEpochMilli()

    private class Case(val title: String, val kind: MapNodeKind, val agent: String?, val cwd: String? = null, val group: String? = null, val device: String? = null, val want: String)

    // titles from a real hub: imported chats, raw first prompts, headless runs, workflow steps
    private val cases = listOf(
        Case("Continued in Claude Code on DefaulTs-MacBook-Pro-2.local", MapNodeKind.SESSION, "coder", "/home/default/CMU", "CMU", "MacBook", want = "Code chat on MacBook"),
        Case("project-t - Session continued from prior context", MapNodeKind.SESSION, "coder", "/home/x/project-t", "project-t", "arch", want = "Code chat on arch"),
        Case("New chat", MapNodeKind.CHAT, "chat", device = "madx", want = "Chat on madx"),
        Case("conclave chat", MapNodeKind.SESSION, "coder", "/Users/default/MadX/CMU/conclave", "conclave", "MacBook", want = "Code chat on MacBook"),
        Case("Skip To Content Dashboard Kaivalya Ahir Account Dashboard Courses Groups Cale...", MapNodeKind.SESSION, "coder", want = "Dashboard Kaivalya Ahir"),
        Case("Run `cat /home/conclave/work/tool-probe/fixtures/chat_d2.txt", MapNodeKind.SUBAGENT, "explore", want = "Run cat chat_d2.txt"),
        Case("AFFiNE 0.27.0, LXC 122 (/opt/affine, port 3010, db `affine`,", MapNodeKind.SUBAGENT, "coder", want = "AFFiNE 0.27.0, LXC 122"),
        Case("so this is the hook, to not use all the highend security words for security a...", MapNodeKind.SESSION, "coder", want = "This is the hook"),
        Case("harness-parity-and-file-outputs / Build A: harness parity", MapNodeKind.SUBAGENT, "builder", want = "Build A: harness parity"),
        Case("pnahir-security-overhaul / correctness-review-2", MapNodeKind.SUBAGENT, "reviewer", want = "Correctness review 2"),
        Case("Read AFFiNE doc \"see this chat 5544\"", MapNodeKind.SUBAGENT, "explore", want = "Read AFFiNE doc"),
        Case("Fix review findings: harness parity", MapNodeKind.SUBAGENT, "builder", want = "Fix review findings"),
        Case("review-changes", MapNodeKind.WORKFLOW, "workflow", want = "Review changes"),
    )

    private fun label(c: Case) = MapLabels.mapLabel(c.title, c.kind, c.agent, c.cwd, c.group, c.device)

    @Test
    fun `real titles get short names`() {
        for (c in cases) assertEquals(c.want, label(c), c.title)
    }

    @Test
    fun `a short, clean title stays as it is, 2 to 5 words at most`() {
        assertEquals("Fix login redirect", MapLabels.mapLabel("Fix login redirect", MapNodeKind.SESSION, "coder"))
        for (c in cases) {
            val words = label(c).split(' ').size
            assertTrue(words in 2..MapLabels.MAX_WORDS, c.title)
        }
    }

    @Test
    fun `the line under it, mode, state, and when a resting node last worked`() {
        assertEquals("Chat", MapLabels.modeWord(MapNodeKind.CHAT, "chat"))
        assertEquals("Assistant", MapLabels.modeWord(MapNodeKind.SESSION, "assistant"))
        assertEquals("Code", MapLabels.modeWord(MapNodeKind.SESSION, "coder"))
        assertEquals("General purpose", MapLabels.modeWord(MapNodeKind.SUBAGENT, "general-purpose"))
        val byId = MapFixture.snapshot(now).nodes.associateBy { it.id }
        val e2e = byId.getValue(I.e2e)
        assertEquals(NodeMeta("Tester", "idle", "3h ago"), MapLabels.nodeMeta(e2e, now))
        assertEquals("Code · running", MapLayouts.labelWords(byId.getValue(I.login), now).second)
        // the full title is kept on the node: only the label is short
        assertEquals("Write e2e tests for checkout", e2e.title)
    }

    @Test
    fun `when words, from now to a date`() {
        val hour = MapFixture.HOUR
        assertEquals("now", MapLabels.whenWords(now - 10_000, now))
        assertEquals("5m ago", MapLabels.whenWords(now - 5 * MapFixture.MIN, now))
        assertEquals("3h ago", MapLabels.whenWords(now - 3 * hour, now))
        assertTrue(Regex("[A-Z][a-z]{2}").matches(MapLabels.whenWords(now - 48 * hour, now)))
        assertTrue(Regex("""\d{1,2} [A-Z][a-z]{2}""").matches(MapLabels.whenWords(now - 240 * hour, now)))
    }
}
