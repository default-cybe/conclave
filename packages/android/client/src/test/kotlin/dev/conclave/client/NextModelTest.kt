package dev.conclave.client

import dev.conclave.client.logic.ChatItem
import dev.conclave.client.logic.ChatItems
import dev.conclave.client.logic.ChatUnit
import dev.conclave.client.logic.ChatUnits
import dev.conclave.client.logic.NextModel
import dev.conclave.client.logic.Transcript
import dev.conclave.client.logic.TranscriptReducer
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.plainText
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Refusal fallback on the phone: "Try the next model" (logic/NextModel.kt,
 * POST /api/sessions/:id/next-model), message.deleted in the transcript, and
 * the step notices changing in place. The transcript is the web mock's
 * (packages/web/src/mock/data.ts fwTranscript).
 */
class NextModelTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    private fun msg(
        id: String,
        seq: Long,
        role: Role = Role.ASSISTANT,
        vararg blocks: ContentBlock,
        kind: MessageKind = MessageKind.NORMAL,
        stopReason: String? = null,
        meta: JsonObject? = null,
        model: String? = null,
    ) = Message(id = id, sessionId = "s_fw", seq = seq, role = role, kind = kind, content = blocks.toList(), stopReason = stopReason, meta = meta, model = model)

    private fun notice(id: String, seq: Long, text: String, meta: JsonObject) = msg(id, seq, Role.ASSISTANT, TextBlock(text), kind = MessageKind.NOTICE, meta = meta)

    private val offerMeta = buildJsonObject { put("type", "refusal"); put("canTryNext", true); put("level", "warning") }

    private val ask1 = msg("u1", 1, Role.USER, TextBlock("Walk me through the stack overflow in httpd."))
    private val answered = notice(
        "n1", 2, "Opus 5.5 (neu) declined. Answered by Opus 5.5 (personal).",
        buildJsonObject { put("type", "refusal"); put("outcome", "answered"); put("level", "info") },
    )
    private val reply1 = msg("a1", 3, Role.ASSISTANT, TextBlock("handle_login() copies the user field with strcpy."), stopReason = "end_turn", model = "cliproxy/claude-opus-5-5")
    private val ask2 = msg("u2", 4, Role.USER, TextBlock("Now draft the vendor advisory."))
    private val refused = msg("a2", 5, Role.ASSISTANT, TextBlock("I can not help with that part."), stopReason = "refusal", model = "cliproxy/claude-opus-5-5")
    private val offer = notice("n2", 6, "The model refused to continue.", offerMeta)
    private val transcript = listOf(ask1, answered, reply1, ask2, refused, offer)

    // ----------------------------------------------------------------- the call

    @Test
    fun postsTheRefusedReplyAndReadsWhichModelItTries() = runBlocking {
        val client = ConclaveClient(server.url("/").toString(), "t")
        server.enqueue(MockResponse(body = """{"model":"zai/glm-5.3","label":"GLM-5.3","later":"ignored"}"""))
        val r = client.tryNextModel("s_fw", "a2")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/sessions/s_fw/next-model", req.url.encodedPath)
        assertEquals("""{"messageId":"a2"}""", req.body?.utf8())
        assertEquals("zai/glm-5.3", r.model)
        assertEquals("GLM-5.3", r.label)

        // without a reply id the hub takes the last one
        server.enqueue(MockResponse(body = """{"model":"zai/glm-5.3","label":"GLM-5.3"}"""))
        client.tryNextModel("s_fw")
        assertEquals("{}", server.takeRequest().body?.utf8())
    }

    @Test
    fun theHubsRefusalReadsAsItsOwnWords() = runBlocking {
        val client = ConclaveClient(server.url("/").toString(), "t")
        server.enqueue(MockResponse(code = 409, body = """{"error":"No model is left in Refusal fallback."}"""))
        val e = assertFailsWith<ConclaveApiException> { client.tryNextModel("s_fw", "a2") }
        assertEquals(409, e.status)
        assertEquals("No model is left in Refusal fallback.", e.message)
    }

    // ----------------------------------------------------------------- message.deleted

    @Test
    fun decodesMessageDeleted() {
        val frame = Frame.parse("""{"type":"message.deleted","seq":7,"ts":1,"sessionId":"s_fw","messageId":"a2"}""")
        assertIs<Frame.Event>(frame)
        val e = frame.envelope.event
        assertEquals(EngineEvent.MessageDeleted("s_fw", "a2"), e)
        assertEquals("s_fw", e.sessionKey)
        assertEquals("message.deleted", frame.envelope.type)
    }

    @Test
    fun aDeletedReplyLeavesTheTranscriptAtOnce() {
        var t = TranscriptReducer.merge(Transcript("s_fw"), transcript)
        t = TranscriptReducer.apply(t, EngineEvent.MessageDeleted("s_fw", "a2"))
        assertEquals(listOf("u1", "n1", "a1", "u2", "n2"), t.messages.map { it.id })

        // another chat's, or one that is not here: nothing changes
        val same = TranscriptReducer.apply(t, EngineEvent.MessageDeleted("other", "a1"))
        assertSame(t, same)
        assertSame(t, TranscriptReducer.apply(t, EngineEvent.MessageDeleted("s_fw", "gone")))
    }

    @Test
    fun aDeletedReplysCallsStopRunning() {
        val use = ToolUseBlock(id = "t1", name = "Bash")
        var t = TranscriptReducer.apply(Transcript("s_fw"), EngineEvent.MessageCreated(msg("a3", 1, Role.ASSISTANT, use)))
        t = TranscriptReducer.apply(t, EngineEvent.ToolStarted("s_fw", "a3", "t1", "Bash", JsonObject(emptyMap())))
        t = TranscriptReducer.apply(t, EngineEvent.ToolProgress("s_fw", "t1", "running"))
        assertEquals(setOf("t1"), t.runningTools)
        t = TranscriptReducer.apply(t, EngineEvent.MessageDeleted("s_fw", "a3"))
        assertTrue(t.messages.isEmpty())
        assertTrue(t.runningTools.isEmpty())
        assertTrue(t.toolProgress.isEmpty())
    }

    // ----------------------------------------------------------------- the step notices

    @Test
    fun theStepNoticeChangesInPlace() {
        // the automatic walk: the refused reply goes, one notice says the step, then the answer
        var t = TranscriptReducer.merge(Transcript("s_fw"), listOf(ask1))
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(msg("a0", 2, Role.ASSISTANT, TextBlock("I can"), model = "cliproxy/neu/claude-opus-5-5")))
        t = TranscriptReducer.apply(t, EngineEvent.MessageDeleted("s_fw", "a0"))
        val trying = notice("n1", 3, "Opus 5.5 (neu) declined. Trying Opus 5.5 (personal).", buildJsonObject { put("type", "refusal"); put("outcome", "trying"); put("level", "warning") })
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(trying))
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(reply1.copy(seq = 4)))
        t = TranscriptReducer.apply(t, EngineEvent.MessageUpdated(answered.copy(seq = 3)))
        assertEquals(listOf("u1", "n1", "a1"), t.messages.map { it.id })
        assertEquals("Opus 5.5 (neu) declined. Answered by Opus 5.5 (personal).", t.messages[1].content.plainText())

        // one notice line, where it was, in both lists
        val items = ChatItems.turns(ChatItems.build(t.messages))
        assertEquals(listOf("u1", "n1", "turn:a1"), items.map { it.key })
        assertEquals("Opus 5.5 (neu) declined. Answered by Opus 5.5 (personal).", (items[1] as ChatItem.Notice).message.content.plainText())
        val units = ChatUnits.build(t.messages)
        assertIs<ChatUnit.User>(units[0])
        assertEquals("Opus 5.5 (neu) declined. Answered by Opus 5.5 (personal).", (units[1] as ChatUnit.Notice).message.content.plainText())
        assertIs<ChatUnit.Reply>(units[2])
        assertEquals(3, units.size)
    }

    // ----------------------------------------------------------------- when the button shows

    @Test
    fun offersOnlyOnARefusalNoticeThatSaysSo() {
        assertTrue(NextModel.offers(offer))
        assertFalse(NextModel.offers(answered))
        assertFalse(NextModel.offers(notice("x", 9, "No.", buildJsonObject { put("type", "refusal"); put("canTryNext", false) })))
        assertFalse(NextModel.offers(notice("x", 9, "No.", buildJsonObject { put("type", "refusal"); put("canTryNext", "true") })))
        assertFalse(NextModel.offers(notice("x", 9, "No.", buildJsonObject { put("type", "limit"); put("canTryNext", true) })))
        assertFalse(NextModel.offers(notice("x", 9, "No.", JsonObject(emptyMap()))))
        // a reply is never the offer, whatever its meta says
        assertFalse(NextModel.offers(refused.copy(meta = offerMeta)))
    }

    @Test
    fun theOfferIsTheRefusedReplyAndItsNotice() {
        val o = NextModel.of(transcript, SessionStatus.IDLE)!!
        assertEquals("n2", o.notice.id)
        assertEquals("a2", o.reply.id)
        // a failed turn or a limit still takes it; a running one or one waiting on you does not
        assertEquals("a2", NextModel.of(transcript, SessionStatus.ERROR)?.reply?.id)
        assertEquals("a2", NextModel.of(transcript, SessionStatus.WAITING_RESET)?.reply?.id)
        assertNull(NextModel.of(transcript, SessionStatus.RUNNING))
        assertNull(NextModel.of(transcript, SessionStatus.WAITING_APPROVAL))
        assertNull(NextModel.of(transcript, SessionStatus.WAITING_INPUT))
        assertNull(NextModel.of(transcript, null))
    }

    @Test
    fun theNotRunAnswersAndOtherNoticesDoNotEndIt() {
        // a refused reply with calls: they were answered "Not run", then the notice
        val use = ToolUseBlock(id = "t1", name = "Bash")
        val withCalls = refused.copy(content = listOf(TextBlock("Running it."), use))
        val notRun = msg("r1", 6, Role.USER, ToolResultBlock("t1", JsonPrimitive("Not run: the model refused."), isError = true))
        val callsNotice = notice("n3", 7, "The model refused, so the tool calls in its reply were not run.", offerMeta)
        val list = listOf(ask1, answered, reply1, ask2, withCalls, notRun, callsNotice)
        assertEquals("a2", NextModel.of(list, SessionStatus.IDLE)?.reply?.id)
        // a notice after it (a step that came to nothing) leaves it standing
        val later = notice("n4", 8, "Background task finished.", buildJsonObject { put("level", "info") })
        assertEquals("n3", NextModel.of(list + later, SessionStatus.IDLE)?.notice?.id)
    }

    @Test
    fun aReplyOrAMessageOfYoursAfterItEndsIt() {
        assertNull(NextModel.of(transcript + msg("u3", 7, Role.USER, TextBlock("Never mind.")), SessionStatus.IDLE))
        assertNull(NextModel.of(transcript + msg("a3", 7, Role.ASSISTANT, TextBlock("Here is a draft."), stopReason = "end_turn"), SessionStatus.IDLE))
        // a second opinion after it: the hub takes only the last reply
        assertNull(NextModel.of(transcript + msg("x1", 7, Role.ASSISTANT, TextBlock("Another view."), kind = MessageKind.ASIDE), SessionStatus.IDLE))
    }

    @Test
    fun goneOnceTheHubDropsTheRefusedReply() {
        // the tap: the reply leaves, so the notice has no refused reply to offer for
        var t = TranscriptReducer.merge(Transcript("s_fw"), transcript)
        assertEquals("a2", NextModel.of(t.messages, SessionStatus.IDLE)?.reply?.id)
        t = TranscriptReducer.apply(t, EngineEvent.MessageDeleted("s_fw", "a2"))
        assertNull(NextModel.of(t.messages, SessionStatus.IDLE))
    }

    @Test
    fun theNewestRefusalWins() {
        val refusedAgain = msg("a4", 9, Role.ASSISTANT, TextBlock("No."), stopReason = "refusal")
        val offerAgain = notice("n5", 10, "The model refused to continue.", offerMeta)
        val list = transcript + msg("a3", 7, Role.ASSISTANT, TextBlock("Draft."), stopReason = "end_turn") + msg("u3", 8, Role.USER, TextBlock("More.")) + refusedAgain + offerAgain
        val o = NextModel.of(list, SessionStatus.IDLE)!!
        assertEquals("n5", o.notice.id)
        assertEquals("a4", o.reply.id)
        // a notice that offers it after a reply that was not refused offers nothing
        assertNull(NextModel.of(listOf(ask1, reply1, offer.copy(seq = 4)), SessionStatus.IDLE))
    }

    @Test
    fun theWordsAreShortAndPlain() {
        assertEquals("Try the next model", NextModel.LABEL)
        assertEquals("Trying", NextModel.BUSY)
        for (w in listOf(NextModel.LABEL, NextModel.BUSY)) assertFalse(w.contains('\u2014') || w.contains('\u2013'))
    }
}
