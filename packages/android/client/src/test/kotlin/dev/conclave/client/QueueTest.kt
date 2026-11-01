package dev.conclave.client

import dev.conclave.client.logic.PendingQueue
import dev.conclave.client.logic.Sending
import dev.conclave.client.logic.Transcript
import dev.conclave.client.logic.TranscriptReducer
import dev.conclave.client.model.Attachment
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.QueuedAttachment
import dev.conclave.client.model.QueuedMessage
import dev.conclave.client.model.Role
import dev.conclave.client.model.SendInput
import dev.conclave.client.model.SendResult
import dev.conclave.client.model.TextBlock
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Messages sent while a session works (docs/design/CHAT-AND-MOTION.md 2.11),
 * the same rules as the web's store/queue.ts: yours shows at once, the hub's
 * list takes it over, the stored message takes its place in the same copy,
 * Remove takes it off, and a load never lays an older list over a newer one.
 */
class QueueTest {

    private fun q(id: String, text: String = id, whenBusy: String = "queue") = QueuedMessage(id = id, text = text, at = 1, whenBusy = whenBusy)

    private fun user(id: String, seq: Long, vararg pending: String, whenBusy: String? = null): Message {
        val meta = buildMap<String, kotlinx.serialization.json.JsonElement> {
            if (pending.isNotEmpty()) put("pendingIds", JsonArray(pending.map { JsonPrimitive(it) }))
            if (whenBusy != null) put("whenBusy", JsonPrimitive(whenBusy))
        }
        return Message(id = id, sessionId = "s1", seq = seq, role = Role.USER, kind = MessageKind.NORMAL, content = listOf(TextBlock(id)), createdAt = seq, meta = if (meta.isEmpty()) null else JsonObject(meta))
    }

    private fun ids(t: Transcript) = t.pending.map { it.id }

    @Test
    fun theEventAndTheSendDecodeAndEncode() {
        val frame = Frame.parse(
            """{"type":"session.queue","seq":7,"ts":5,"sessionId":"s1","queue":[{"id":"q_1","text":"next","at":3,"whenBusy":"steer","attachments":[{"name":"a.png","mediaType":"image/png"}]}]}""",
        )
        val e = (frame as Frame.Event).envelope.event as EngineEvent.SessionQueue
        assertEquals("s1", e.sessionKey)
        assertEquals(listOf(QueuedMessage("q_1", "next", listOf(QueuedAttachment("a.png", "image/png")), 3, "steer")), e.queue)
        assertEquals(SendResult(queued = true, pendingId = "q_1"), ConclaveJson.decodeFromString(SendResult.serializer(), """{"queued":true,"pendingId":"q_1"}"""))
        val body = ConclaveJson.encodeToString(SendInput.serializer(), SendInput(text = "hi", whenBusy = "queue", pendingId = "a_x1y2z3"))
        assertTrue(body.contains("\"pendingId\":\"a_x1y2z3\""), body)
        // an idle send carries no id, as before
        assertFalse(ConclaveJson.encodeToString(SendInput.serializer(), SendInput(text = "hi")).contains("pendingId"))
    }

    @Test
    fun theRules() {
        assertEquals(listOf("a", "b", "c"), PendingQueue.shown(listOf(q("a"), q("b")), listOf(Sending(q("b")), Sending(q("c")))).map { it.id })
        val hub = listOf(q("a"))
        assertSame(hub, PendingQueue.shown(hub, emptyList()))

        val sending = listOf(Sending(q("mine")), Sending(q("done"), confirmedAt = 100))
        assertEquals(listOf("mine", "done"), PendingQueue.afterHubList(sending, listOf(q("other"))).map { it.item.id })
        assertEquals(listOf("done"), PendingQueue.afterHubList(sending, listOf(q("mine"))).map { it.item.id })
        // a load asked after the hub answered "done" is the whole truth; one asked before is not
        assertEquals(listOf("mine"), PendingQueue.afterHubList(sending, emptyList(), loadedFrom = 200).map { it.item.id })
        assertEquals(listOf("mine", "done"), PendingQueue.afterHubList(sending, emptyList(), loadedFrom = 50).map { it.item.id })

        assertEquals(listOf("a", "b"), PendingQueue.pendingIds(user("u", 1, "a", "b")))
        assertEquals(emptyList(), PendingQueue.pendingIds(user("u", 1)))
        assertTrue(PendingQueue.replacesPending(user("u", 1, "a")))
        // the row of the stored message keeps the waiting one's key
        assertEquals("p:a", PendingQueue.keyOf(user("u", 1, "a")))
        assertEquals("u", PendingQueue.keyOf(user("u", 1)))

        val id = PendingQueue.newId(now = 1_700_000_000_000, random = Random(1))
        assertTrue(PendingQueue.validId(id), id)
        assertFalse(PendingQueue.validId("no spaces!"))
        assertFalse(id == PendingQueue.newId(now = 1_700_000_000_000, random = Random(2)))
    }

    @Test
    fun theWords() {
        assertEquals("Queued", PendingQueue.pendingWord("queue"))
        assertEquals("Sending to the running turn", PendingQueue.pendingWord("steer"))
        assertEquals("Queued", PendingQueue.storedWord(user("u", 1, "a", whenBusy = "queue").meta))
        assertEquals("Steered the running turn", PendingQueue.storedWord(user("u", 1, "a", whenBusy = "steer").meta))
        assertNull(PendingQueue.storedWord(user("u", 1).meta))
        val item = PendingQueue.item("a_1", "look", listOf(Attachment(mediaType = "image/png", data = "eA==", name = "x.png")), "steer", 9)
        assertEquals(QueuedMessage("a_1", "look", listOf(QueuedAttachment("x.png", "image/png")), 9, "steer"), item)
    }

    @Test
    fun yoursShowsAtOnceAndTheHubsListTakesItOver() {
        var t = TranscriptReducer.sent(Transcript("s1"), q("a_1", "next"))
        assertEquals(listOf("a_1"), ids(t))
        // an event from before the hub had it keeps it
        t = TranscriptReducer.apply(t, EngineEvent.SessionQueue("s1", listOf(q("other"))))
        assertEquals(listOf("other", "a_1"), ids(t))
        t = TranscriptReducer.apply(t, EngineEvent.SessionQueue("s1", listOf(q("other"), q("a_1", "next"))))
        assertEquals(listOf("other", "a_1"), ids(t))
        assertEquals(emptyList(), t.sending)
        assertEquals(2, t.queueVersion)
        // another session's list leaves this one alone
        assertSame(t, TranscriptReducer.apply(t, EngineEvent.SessionQueue("s2", emptyList())))
    }

    @Test
    fun theStoredMessageTakesItsPlaceInOneCopy() {
        var t = TranscriptReducer.apply(Transcript("s1"), EngineEvent.SessionQueue("s1", listOf(q("a"), q("b"))))
        t = TranscriptReducer.sent(t, q("c"))
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(user("u-a", 3, "a", whenBusy = "queue")))
        // the message is there and its bubble is not, in the same copy
        assertEquals(listOf("u-a"), t.messages.map { it.id })
        assertEquals(listOf("b", "c"), ids(t))
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(user("u-c", 4, "c")))
        assertEquals(listOf("b"), ids(t))
        // a message without ids leaves the list as it is
        val before = t
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(user("u5", 5)))
        assertEquals(before.queue, t.queue)
        // a transcript load that brings the message drops its bubble too
        var u = TranscriptReducer.apply(Transcript("s1"), EngineEvent.SessionQueue("s1", listOf(q("x"))))
        u = TranscriptReducer.merge(u, listOf(user("u-x", 1, "x")))
        assertEquals(emptyList(), ids(u))
    }

    @Test
    fun theHubsAnswer() {
        var t = TranscriptReducer.sent(Transcript("s1"), q("a_1"))
        t = TranscriptReducer.answered(t, "a_1", SendResult(queued = true, pendingId = "a_1"), now = 10)
        assertEquals(10L, t.sending.single().confirmedAt)
        // the session was free after all and it ran at once, or the send failed: it leaves
        t = TranscriptReducer.sent(t, q("a_2"))
        t = TranscriptReducer.answered(t, "a_2", SendResult(queued = false))
        assertEquals(listOf("a_1"), ids(t))
        t = TranscriptReducer.sent(t, q("a_3"))
        t = TranscriptReducer.answered(t, "a_3", null)
        assertEquals(listOf("a_1"), ids(t))
    }

    @Test
    fun removeTakesItOffAndARefusalPutsItBack() {
        val start = TranscriptReducer.sent(TranscriptReducer.apply(Transcript("s1"), EngineEvent.SessionQueue("s1", listOf(q("a"), q("b")))), q("c"))
        var t = TranscriptReducer.removed(start, "b")
        assertEquals(listOf("a", "c"), ids(t))
        t = TranscriptReducer.unremoved(t, start, "b")
        assertEquals(listOf("a", "b", "c"), ids(t))
        t = TranscriptReducer.removed(start, "c")
        assertEquals(listOf("a", "b"), ids(t))
        t = TranscriptReducer.unremoved(t, start, "c")
        assertEquals(listOf("a", "b", "c"), ids(t))
        // a newer list came meanwhile: it wins
        t = TranscriptReducer.removed(start, "a")
        t = TranscriptReducer.apply(t, EngineEvent.SessionQueue("s1", listOf(q("b"))))
        t = TranscriptReducer.unremoved(t, start, "a")
        assertEquals(listOf("b", "c"), ids(t))
    }

    @Test
    fun aLoadNeverLaysAnOlderListOverANewerOne() {
        var t = TranscriptReducer.merge(Transcript("s1"), listOf(user("u-a", 1, "a")))
        t = TranscriptReducer.loadedQueue(t, listOf(q("a"), q("b")), askedAt = 5, version = t.queueVersion)
        // never one already in the transcript
        assertEquals(listOf("b"), ids(t))
        val version = t.queueVersion
        t = TranscriptReducer.apply(t, EngineEvent.SessionQueue("s1", listOf(q("c"))))
        t = TranscriptReducer.loadedQueue(t, listOf(q("b")), askedAt = 6, version = version)
        assertEquals(listOf("c"), ids(t))
        // a confirmed send the load does not list is gone; an unconfirmed one is still on its way
        var u = TranscriptReducer.answered(TranscriptReducer.sent(Transcript("s1"), q("a_1")), "a_1", SendResult(queued = true, pendingId = "a_1"), now = 10)
        u = TranscriptReducer.sent(u, q("a_2"))
        u = TranscriptReducer.loadedQueue(u, emptyList(), askedAt = 20, version = u.queueVersion)
        assertEquals(listOf("a_2"), ids(u))
    }
}
