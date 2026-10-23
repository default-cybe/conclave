package dev.conclave.client

import dev.conclave.client.logic.AgentResults
import dev.conclave.client.logic.ChatItem
import dev.conclave.client.logic.ChatItems
import dev.conclave.client.logic.ChatUnit
import dev.conclave.client.logic.ChatUnits
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ToolResultBlock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A finished background task reads as one row; hub context alone never draws an empty bubble. */
class AgentResultsTest {
    private val block = "<system-reminder>\nA background subagent you started has finished. Its final report:\n" +
        "<subagent_result session=\"ses_child\" agent=\"general-purpose\" state=\"completed\" description=\"count widgets\">\n**42** widgets\n</subagent_result>\n</system-reminder>"
    private val notice = Message(
        id = "n1", seq = 3, role = Role.ASSISTANT, kind = MessageKind.NOTICE,
        content = listOf(TextBlock("Background task finished: count widgets")),
        meta = buildJsonObject {
            put("kind", "agent-result")
            putJsonObject("agentResult") { put("type", "subagent"); put("id", "ses_child"); put("label", "count widgets"); put("agent", "general-purpose"); put("state", "completed") }
        },
    )
    private val carrier = Message(id = "u2", seq = 4, role = Role.USER, content = listOf(TextBlock(block)))
    private val list = listOf(
        Message(id = "u1", seq = 1, role = Role.USER, content = listOf(TextBlock("start"))),
        Message(id = "a1", seq = 2, role = Role.ASSISTANT, content = listOf(TextBlock("Started it.")), stopReason = "end_turn"),
        notice,
        carrier,
        Message(id = "a2", seq = 5, role = Role.ASSISTANT, content = listOf(TextBlock("42 it is.")), stopReason = "end_turn"),
    )

    @Test
    fun noticeIsTheRowWithItsReport() {
        val r = AgentResults.forNotice(list, notice)!!
        assertEquals("Message from subagent count widgets", r.title)
        assertEquals("done", r.stateWord)
        assertEquals("**42** widgets", r.report)
        // a hub from before the meta: matched by its words and label
        val old = notice.copy(meta = null, content = listOf(TextBlock("Background task failed: count widgets")))
        val o = AgentResults.forNotice(list, old)!!
        assertTrue(o.failed)
        assertEquals("**42** widgets", o.report)
        assertNull(AgentResults.ofNotice(notice.copy(meta = null, content = listOf(TextBlock("Switched to GPT-5.5")))))
    }

    @Test
    fun noEmptyBubble() {
        val items = ChatItems.build(list)
        assertEquals(listOf("u1"), items.filterIsInstance<ChatItem.User>().map { it.message.id })
        assertEquals("**42** widgets", items.filterIsInstance<ChatItem.Notice>().single().result?.report)
        val units = ChatUnits.build(list)
        assertEquals(listOf("u1"), units.filterIsInstance<ChatUnit.User>().map { it.message.id })
        assertTrue(units.filterIsInstance<ChatUnit.Notice>().single().result != null)
        val mixed = Message(id = "u3", role = Role.USER, content = listOf(ToolResultBlock(toolUseId = "t1"), TextBlock(block)))
        assertTrue(AgentResults.isContextOnly(mixed))
        assertTrue(AgentResults.isContextOnly(Message(id = "u4", role = Role.USER, content = listOf(TextBlock("  ")))))
        assertFalse(AgentResults.isContextOnly(list[0]))
    }


    /** The exact body the hub stores for the carrier message: multi-line markdown with a table. */
    @Test
    fun parsesRealReportWithTable() {
        val body = "<system-reminder>\nA background subagent you started has finished. Its final report:\n" +
            "<subagent_result session=\"ses_0mvl9rhaeidizkmhv6f\" agent=\"general-purpose\" state=\"completed\" description=\"Probe tool visibility per model\">\n" +
            "Partly done.\n\n**Dry result:**\n\n| wire | tools sent |\n|---|---|\n| anthropic | 47/47 |\n</subagent_result>\n</system-reminder>"
        val carrier = Message(id = "u9", seq = 10, role = Role.USER, content = listOf(TextBlock(body)))
        val results = AgentResults.resultsIn(carrier)
        assertEquals(1, results.size)
        val r = results[0]
        assertEquals("ses_0mvl9rhaeidizkmhv6f", r.id)
        assertEquals("Probe tool visibility per model", r.label)
        assertEquals("completed", r.state)
        assertTrue(r.report!!.contains("| anthropic | 47/47 |"))
    }

    /** meta.kind is agent-result but the agentResult object or its type is missing: no row, no crash. */
    @Test
    fun missingAgentResultFieldIsNull() {
        // other words than the old hub's line, which still makes a row from the text alone (as on the web)
        val noObj = notice.copy(content = listOf(TextBlock("Task ended")), meta = buildJsonObject { put("kind", "agent-result") })
        assertNull(AgentResults.ofNotice(noObj))
        val noType = notice.copy(meta = buildJsonObject {
            put("kind", "agent-result")
            putJsonObject("agentResult") { put("id", "ses_x"); put("label", "x"); put("state", "completed") }
        })
        assertNull(AgentResults.ofNotice(noType))
    }
}
