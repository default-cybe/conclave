package dev.conclave.client

import dev.conclave.client.logic.StopCards
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TextBlock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** "Why did this turn stop" on the phone (logic/StopCard.kt); the web test is packages/web/test/stop-card.test.ts. */
class StopCardTest {
    private fun s(status: SessionStatus = SessionStatus.IDLE, resumeAt: Long? = null, meta: JsonObject? = null) = Session("s1", status = status, resumeAt = resumeAt, meta = meta)
    private fun m(seq: Long, text: String, role: Role = Role.ASSISTANT, kind: MessageKind = MessageKind.NORMAL, stop: String? = null, meta: JsonObject? = null) =
        Message("m$seq", "s1", seq, role, kind, listOf(TextBlock(text)), stopReason = stop, meta = meta)
    private val clock = { t: Long -> "t$t" }

    @Test
    fun refusalOffersTheNextModelOnlyWhenTheHubDoes() {
        val reply = m(2, "I can not help with that part.", stop = "refusal")
        val offer = m(3, "declined", kind = MessageKind.NOTICE, meta = buildJsonObject { put("type", "refusal"); put("canTryNext", true) })
        assertEquals("Try the next model.", StopCards.of(s(), listOf(m(1, "hi", Role.USER), reply, offer), clock = clock)?.next)
        assertEquals("Rephrase, or switch model.", StopCards.of(s(), listOf(reply), clock = clock)?.next)
    }

    @Test
    fun providerErrorLimitStoppedAndStalled() {
        val err = m(1, "Error: Rejected with 402.", kind = MessageKind.NOTICE, meta = buildJsonObject { put("type", "provider_error"); put("canRetry", true) })
        assertEquals("Rejected with 402.", StopCards.of(s(SessionStatus.ERROR), listOf(err), clock = clock)?.evidence)
        assertEquals("Retry with another model.", StopCards.of(s(SessionStatus.ERROR), listOf(err), clock = clock)?.next)
        assertEquals("It resumes at t9. Or switch model.", StopCards.of(s(SessionStatus.WAITING_RESET, resumeAt = 9), emptyList(), clock = clock)?.next)
        val cut = m(1, "Part of", stop = "aborted")
        assertEquals("stopped", StopCards.of(s(), listOf(cut, m(2, "Stopped", kind = MessageKind.NOTICE, meta = buildJsonObject { put("level", "info") })), clock = clock)?.kind)
        // a Stop during a tool run where the turn can not resume (a task child): the reply ended on tool_use
        assertEquals("stopped", StopCards.of(s(), listOf(m(1, "Running", stop = "tool_use"), m(2, "Stopped", kind = MessageKind.NOTICE)), clock = clock)?.kind)
        val stoppedTurn = s(meta = buildJsonObject { put("stoppedTurn", true) })
        assertEquals("stopped", StopCards.of(stoppedTurn, listOf(cut, m(2, "Stopped", kind = MessageKind.NOTICE)), clock = clock)?.kind)
        // a hub restart sets stoppedTurn too but writes no "Stopped" notice: not you
        val restart = StopCards.of(stoppedTurn, listOf(cut), clock = clock)
        assertEquals("interrupted", restart?.kind)
        assertEquals("Resume to go on.", restart?.next)
        assertEquals("interrupted", StopCards.of(stoppedTurn, listOf(m(1, "Stopped", kind = MessageKind.NOTICE), m(2, "again", Role.USER)), clock = clock)?.kind)
        // a harness error or output limit also writes "aborted": the notice is the reason, not you
        val herr = StopCards.of(s(), listOf(cut, m(2, "acp error: boom", kind = MessageKind.NOTICE, meta = buildJsonObject { put("level", "error") })), clock = clock)
        assertEquals("provider", herr?.kind)
        assertEquals("acp error: boom", herr?.evidence)
        assertNull(StopCards.of(s(), listOf(cut), clock = clock))
        assertEquals("stalled", StopCards.of(s(SessionStatus.RUNNING), emptyList(), stuckSince = 5, clock = clock)?.kind)
        assertNull(StopCards.of(s(SessionStatus.RUNNING), emptyList(), clock = clock))
        assertNull(StopCards.of(s(), listOf(m(1, "Done.", stop = "end_turn")), clock = clock))
    }

    @Test
    fun aQuietTaskDoesNotLookAlive() {
        assertEquals("Active now" to false, StopCards.activity(1_000_000, 1_010_000))
        assertEquals("No activity for 7 min" to true, StopCards.activity(1_000_000, 1_000_000 + 7 * 60_000))
        assertNull(StopCards.activity(0, 5))
    }
}
