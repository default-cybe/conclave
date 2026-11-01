package dev.conclave.client

import dev.conclave.client.logic.Asks
import dev.conclave.client.logic.SubagentNow
import dev.conclave.client.logic.Tasks
import dev.conclave.client.logic.Transcript
import dev.conclave.client.logic.TranscriptReducer
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.AskFrom
import dev.conclave.client.model.AskWorkflow
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Question
import dev.conclave.client.model.QuestionOption
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Approvals and questions from subagents and workflow agents show in the
 * chat the owner is in (Asks.kt, docs/design/CHAT-AND-MOTION.md 1.4): the
 * hub's rootSessionId and from decode, which requests show where, the line
 * above the card, the session answer's words, the Inbox line, and the
 * transcript that takes a subagent's request.
 */
class AsksTest {
    private val email = AskFrom(sessionId = "s_email", agent = "email", label = "Find the Lisbon booking mail", chain = listOf("s_email"))
    private val child = ApprovalRequest("ap_mail", "s_email", tool = "MailRead", summary = "Read message msg_4f1c", rootSessionId = "s_mail", from = email)
    private val own = ApprovalRequest("ap_own", "s_mail", tool = "Bash", summary = "Run: ls", rootSessionId = "s_mail")
    private val twoDown = ApprovalRequest(
        "ap_deep",
        "s_read",
        tool = "Read",
        rootSessionId = "s_mail",
        from = AskFrom(sessionId = "s_read", agent = "explore", label = "Read the thread", chain = listOf("s_email", "s_read")),
    )
    private val workflow = ApprovalRequest(
        "ap_wf",
        "s_wf3",
        tool = "Bash",
        rootSessionId = "s_mail",
        from = AskFrom(sessionId = "s_wf3", agent = "workflow", label = "search r1 3", workflow = AskWorkflow("wfr_1", "deep-research"), chain = listOf("s_wf3")),
    )
    private val older = ApprovalRequest("ap_old", "s_mail", tool = "Bash")
    private val question = QuestionRequest("q1", "s_email", listOf(Question("Which inbox?", options = listOf(QuestionOption("Work"), QuestionOption("Home")))), rootSessionId = "s_mail", from = email)

    @Test
    fun `the hub's rootSessionId and from decode, on the list and on the event`() {
        val json = """{"id":"ap_mail","sessionId":"s_email","rootSessionId":"s_mail","from":{"sessionId":"s_email","agent":"email","label":"Find the Lisbon booking mail","chain":["s_email"]},"toolUseId":"tu","tool":"MailRead","input":{"id":"m1"},"summary":"Read message m1","createdAt":5,"noAlways":true}"""
        val a = ConclaveJson.decodeFromString(ApprovalRequest.serializer(), json)
        assertEquals("s_mail", a.rootSessionId)
        assertEquals(email, a.from)
        val wf = ConclaveJson.decodeFromString(
            ApprovalRequest.serializer(),
            """{"id":"a","sessionId":"s_wf3","rootSessionId":"s_mail","from":{"sessionId":"s_wf3","agent":"workflow","label":"search r1 3","workflow":{"runId":"wfr_1","name":"deep-research"},"chain":["s_wf3"]},"tool":"Bash"}""",
        )
        assertEquals(AskWorkflow("wfr_1", "deep-research"), wf.from?.workflow)
        // an older hub: neither
        val old = ConclaveJson.decodeFromString(ApprovalRequest.serializer(), """{"id":"a","sessionId":"s1","tool":"Bash"}""")
        assertNull(old.rootSessionId)
        assertNull(old.from)

        val frame = Frame.parse("""{"type":"question.asked","seq":1,"ts":1,"question":{"id":"q1","sessionId":"s_email","rootSessionId":"s_mail","from":{"sessionId":"s_email","agent":"email","label":"Find it","chain":["s_email"]},"questions":[{"question":"Which inbox?","options":[{"label":"Work"}]}],"createdAt":1}}""") as Frame.Event
        val q = (frame.envelope.event as EngineEvent.QuestionAsked).question
        assertEquals("s_mail", q.rootSessionId)
        assertEquals("email", q.from?.agent)
        assertEquals("s_email", frame.envelope.event.sessionKey)
    }

    @Test
    fun `the top session shows its own and its subagents' requests, and a subagent shows its own and those under it`() {
        for (a in listOf(child, own, twoDown, workflow, older)) assertTrue(Asks.showsIn(a, "s_mail"), a.id)
        assertTrue(Asks.showsIn(child, "s_email"))
        assertTrue(Asks.showsIn(twoDown, "s_email"))
        assertFalse(Asks.showsIn(own, "s_email"))
        assertFalse(Asks.showsIn(child, "s_other"))
        assertEquals(listOf("ap_mail", "ap_deep"), Asks.of(listOf(own, child, twoDown), "s_email").map { it.id })
        assertEquals("s_mail", Asks.home(child))
        assertEquals("s_mail", Asks.home(older))
        // the turn that started a subagent waits with it
        assertTrue(Asks.below(listOf(child), "s_mail"))
        assertFalse(Asks.below(listOf(own), "s_mail"))
        assertTrue(Asks.waitsIn(listOf(twoDown), "s_email"))
        assertFalse(Asks.waitsIn(listOf(own), "s_email"))
        assertTrue(Asks.runWaits(listOf(workflow), "wfr_1"))
        assertFalse(Asks.runWaits(listOf(child), "wfr_1"))
    }

    @Test
    fun `who asks above the card, the session answer, and the Inbox line`() {
        assertEquals("Subagent email asks", Asks.fromLine(child, "s_mail"))
        assertEquals("Workflow deep-research, agent search r1 3, asks", Asks.fromLine(workflow, "s_mail"))
        assertEquals("Subagent email asks", Asks.fromLine(question, "s_mail"))
        assertNull(Asks.fromLine(own, "s_mail"))
        // in the subagent's own session it is the one you are looking at
        assertNull(Asks.fromLine(child, "s_email"))
        assertEquals("Subagent explore asks", Asks.fromLine(twoDown, "s_email"))
        assertEquals("Allow for this subagent", Asks.sessionLabel(child))
        assertEquals("Allowed for this subagent", Asks.sessionDone(child))
        assertEquals("Allow for this chat", Asks.sessionLabel(own))
        assertEquals("Allowed for this chat", Asks.sessionDone(own))
        assertEquals("from subagent email in Lisbon flight booking code", Asks.inboxLine(child, "Lisbon flight booking code"))
        assertEquals("from workflow deep-research, agent search r1 3, in Research", Asks.inboxLine(workflow, "Research"))
        assertNull(Asks.inboxLine(own, "x"))
        assertEquals("Subagent email wants to read a file", Asks.askerLine(child, "Wants to read a file"))
        assertEquals("Wants to run ls", Asks.askerLine(own, "Wants to run ls"))
        val words = listOf(Asks.fromLine(workflow, "s_mail"), Asks.inboxLine(workflow, "R"), Asks.askerLine(workflow, "Asks: Now?")).joinToString(" ")
        assertFalse(words.contains('—') || words.contains('–'))
    }

    @Test
    fun `the chat's transcript takes a subagent's request and lets it go when answered`() {
        var t = Transcript("s_mail")
        t = TranscriptReducer.apply(t, EngineEvent.ApprovalRequested(child))
        t = TranscriptReducer.apply(t, EngineEvent.QuestionAsked(question))
        assertEquals(listOf("ap_mail"), t.approvals.map { it.id })
        assertEquals(listOf("q1"), t.questions.map { it.id })
        // another chat's subagent stays out
        val elsewhere = child.copy(id = "ap_x", rootSessionId = "s_other", from = email.copy(chain = listOf("s_x")), sessionId = "s_x")
        assertEquals(t, TranscriptReducer.apply(t, EngineEvent.ApprovalRequested(elsewhere)))
        t = TranscriptReducer.apply(t, EngineEvent.ApprovalResolved("ap_mail", "s_email"))
        t = TranscriptReducer.apply(t, EngineEvent.QuestionAnswered("q1", "s_email"))
        assertTrue(t.approvals.isEmpty())
        assertTrue(t.questions.isEmpty())
        assertTrue(Asks.isAskEvent(EngineEvent.ApprovalRequested(child)))
        assertFalse(Asks.isAskEvent(EngineEvent.ConfigUpdated()))
    }

    @Test
    fun `a subagent's row waits on you while it or one under it asks`() {
        val running = Session("s_email", agent = "email", status = SessionStatus.RUNNING)
        assertEquals(SubagentNow("Waiting on you", waiting = true), Tasks.now(running, emptyList(), emptyMap(), asks = listOf(twoDown)))
        assertEquals(SubagentNow("Starting"), Tasks.now(running, emptyList(), emptyMap(), asks = listOf(own)))
    }
}
