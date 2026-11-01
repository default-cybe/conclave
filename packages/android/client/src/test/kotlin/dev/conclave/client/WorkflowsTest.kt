package dev.conclave.client

import dev.conclave.client.logic.RunActivity
import dev.conclave.client.logic.RunLive
import dev.conclave.client.logic.RunReducer
import dev.conclave.client.logic.StateTone
import dev.conclave.client.logic.WorkflowWords
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.WorkflowCall
import dev.conclave.client.model.WorkflowCallKind
import dev.conclave.client.model.WorkflowCallState
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunDetail
import dev.conclave.client.model.WorkflowRunStatus
import dev.conclave.client.motion.KnotState
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Workflow runs on the phone: the detail decodes, the words read right, and the view follows the events. */
class WorkflowsTest {
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

    private fun client() = ConclaveClient(server.url("/").toString(), "t")

    private val detailJson = """{
      "run":{"id":"r1","name":"review-changes","source":"builtin","status":"running","sessionId":"s1","device":"pc","cwd":"/home/kai/code/site",
        "phases":[{"title":"Scope"},{"title":"Find"},{"title":"Verify"},{"title":"Report"}],"phaseIndex":2,"phaseTitle":"Verify",
        "inputTokens":400000,"outputTokens":12000,"costUsd":3.1,
        "counts":{"agents":14,"queued":1,"running":2,"done":8,"cached":1,"failed":1,"skipped":0,"parked":1},"portable":false,"createdAt":1},
      "calls":[
        {"seq":1,"kind":"check","label":"scope the diff","phase":"Scope","state":"done","attempt":1,"inputTokens":0,"outputTokens":0,"costUsd":0},
        {"seq":2,"kind":"agent","label":"correctness","phase":"Find","model":"anthropic/claude-sonnet-5-5","state":"done","attempt":1,"inputTokens":9000,"outputTokens":1000,"costUsd":0.04},
        {"seq":3,"kind":"agent","label":"verify 1","phase":"Verify","state":"running","attempt":1,"lastTool":"Reading src/auth.ts","waiting":"approval","childSessionId":"c3","inputTokens":0,"outputTokens":0,"costUsd":0},
        {"seq":4,"kind":"workflow","label":"nested","phase":"Verify","state":"running","attempt":1,"inputTokens":0,"outputTokens":0,"costUsd":0},
        {"seq":5,"kind":"agent","label":"inner","phase":"Verify","parentSeq":4,"state":"running","attempt":2,"lastTool":"Running bun test","inputTokens":0,"outputTokens":0,"costUsd":0},
        {"seq":6,"kind":"agent","label":"odd","phase":"Unlisted","state":"teleporting","attempt":1,"inputTokens":0,"outputTokens":0,"costUsd":0}
      ],
      "logs":[{"n":1,"ts":5,"text":"Scoped 12 files."}],
      "result":null,
      "findings":[{"id":"f1","runId":"r1","workflow":"review-changes","findingKey":"k","title":"Null check missing","proven":true,"votes":{"a":1},"data":{"x":[1]},"createdAt":1}]
    }"""

    @Test
    fun runDetailDecodesWithUnknownValues() = runBlocking {
        server.enqueue(MockResponse(body = detailJson))
        val d = client().workflowRun("r1")
        assertEquals("/api/workflows/runs/r1", server.takeRequest().url.encodedPath)
        assertEquals(WorkflowRunStatus.RUNNING, d.run.status)
        assertEquals(6, d.calls.size)
        assertEquals(WorkflowCallState.QUEUED, d.calls.last().state)
        assertTrue(d.calls[2].waitingOnOwner)
        assertEquals("Null check missing", d.findings.single().title)
        assertNull(d.result)
    }

    private fun detail() = ConclaveJson.decodeFromString(WorkflowRunDetail.serializer(), detailJson)

    @Test
    fun statusSentenceCountsAnApprovalAsWaitingForYou() {
        val d = detail()
        assertEquals(
            "Running. Phase 3 of 4, Verify. 14 agents: 9 done, 1 running, 1 waiting for you, 1 failed, 1 waiting for a limit. 412k tokens, $3.10.",
            WorkflowWords.statusSentence(d.run, d.calls),
        )
        val one = d.run.copy(status = WorkflowRunStatus.DONE, phaseIndex = -1, counts = d.run.counts.copy(agents = 1, done = 1, cached = 0, running = 0, failed = 0, parked = 0))
        assertEquals("Done. 1 agent: 1 done. 412k tokens, $3.10.", WorkflowWords.statusSentence(one))
        assertEquals("Stopped at budget", WorkflowWords.statusSentence(one.copy(status = WorkflowRunStatus.BUDGET)).substringBefore('.'))
    }

    @Test
    fun wordsTonesAndKnot() {
        val d = detail()
        assertEquals("waiting for you", WorkflowWords.callWord(d.calls[2]))
        assertEquals(StateTone.WARN, WorkflowWords.callTone(d.calls[2]))
        val stopped = d.calls[1].copy(state = WorkflowCallState.FAILED, error = "the run was stopped")
        assertEquals("stopped", WorkflowWords.callWord(stopped))
        assertEquals(StateTone.DIM, WorkflowWords.callTone(stopped))
        assertEquals("waiting", WorkflowWords.callWord(d.calls[1].copy(state = WorkflowCallState.PARKED)))
        assertEquals(KnotState.TOOL, WorkflowWords.knot(d.run))
        assertEquals(KnotState.THINKING, WorkflowWords.knot(d.run.copy(counts = d.run.counts.copy(running = 0))))
        assertEquals(KnotState.PAUSED, WorkflowWords.knot(d.run.copy(status = WorkflowRunStatus.WAITING_RESET)))
        assertEquals(KnotState.WAITING, WorkflowWords.knot(d.run.copy(status = WorkflowRunStatus.INTERRUPTED)))
        assertEquals(KnotState.FAILED, WorkflowWords.knot(d.run.copy(status = WorkflowRunStatus.FAILED)))
        assertEquals(KnotState.DONE, WorkflowWords.knot(d.run.copy(status = WorkflowRunStatus.STOPPED)))
        assertTrue(WorkflowWords.isLive(WorkflowRunStatus.WAITING_RESET))
        assertFalse(WorkflowWords.isLive(WorkflowRunStatus.INTERRUPTED))
    }

    @Test
    fun phasesGroupInMetaOrderAndNestedCallsIndent() {
        val d = detail()
        val groups = WorkflowWords.byPhase(d.run, d.calls)
        assertEquals(listOf("Scope", "Find", "Verify", "Report", "Other calls"), groups.map { it.title })
        assertEquals(listOf(3, 4, 5), groups[2].calls.map { it.seq })
        assertEquals("no agents", WorkflowWords.phaseProgress(groups[3], 3, d.run.copy(status = WorkflowRunStatus.DONE)))
        assertEquals("not started", WorkflowWords.phaseProgress(groups[3], 3, d.run))
        assertEquals("1 of 1 done", WorkflowWords.phaseProgress(groups[1], 1, d.run))
        val rows = WorkflowWords.rows(groups[2].calls)
        assertEquals(listOf(3 to 0, 4 to 0, 5 to 1), rows.map { it.call.seq to it.depth })
        // a parent chain that loops still lists every call once
        val loop = listOf(call(7, parent = 8), call(8, parent = 7))
        assertEquals(listOf(7, 8), WorkflowWords.rows(loop).map { it.call.seq })
    }

    private fun call(seq: Int, parent: Int? = null, state: WorkflowCallState = WorkflowCallState.RUNNING) =
        WorkflowCall(seq = seq, kind = WorkflowCallKind.AGENT, parentSeq = parent, state = state)

    @Test
    fun skipAndRerunOnlyWhenTheyMeanSomething() {
        val d = detail()
        assertTrue(WorkflowWords.canSkip(d.run, d.calls[2]))
        assertFalse(WorkflowWords.canSkip(d.run, d.calls[1]))
        assertFalse(WorkflowWords.canSkip(d.run.copy(status = WorkflowRunStatus.DONE), d.calls[2]))
        assertFalse(WorkflowWords.canRerun(d.run))
        assertTrue(WorkflowWords.canRerun(d.run.copy(status = WorkflowRunStatus.FAILED)))
        assertEquals("Sonnet 5.5, 10k tokens, $0.04", WorkflowWords.callMeta(d.calls[1], null))
        assertEquals("check", WorkflowWords.callMeta(d.calls[0], null))
        assertEquals("Running bun test, attempt 2", WorkflowWords.callMeta(d.calls[4], d.calls[4].lastTool))
    }

    @Test
    fun theViewFollowsEvents() {
        var s = RunLive(detail())
        fun ev(json: String): EngineEvent = (Frame.parse(json) as Frame.Event).envelope.event

        // progress: callSeq names the call (the envelope's own seq is the event number), waiting false clears the approval
        var reload: Boolean
        s = RunReducer.apply(s, ev("""{"type":"workflow.progress","seq":900,"ts":1,"runId":"r1","callSeq":3,"lastTool":"Editing src/auth.ts","waiting":false}""")).first
        assertEquals("Editing src/auth.ts", s.progress[3])
        assertEquals(RunActivity(3, "Editing src/auth.ts"), s.activity)
        assertFalse(s.detail.calls.first { it.seq == 3 }.waitingOnOwner)
        s = RunReducer.apply(s, ev("""{"type":"workflow.progress","seq":901,"ts":1,"runId":"r1","callSeq":3,"lastTool":"Bash","waiting":"approval"}""")).first
        assertTrue(s.detail.calls.first { it.seq == 3 }.waitingOnOwner)
        // no waiting field: left as it is
        s = RunReducer.apply(s, ev("""{"type":"workflow.progress","seq":902,"ts":1,"runId":"r1","callSeq":3,"lastTool":"Bash again"}""")).first
        assertTrue(s.detail.calls.first { it.seq == 3 }.waitingOnOwner)

        // another run's events change nothing
        val before = s
        s = RunReducer.apply(s, ev("""{"type":"workflow.log","seq":903,"ts":7,"runId":"r2","text":"elsewhere"}""")).first
        assertEquals(before, s)

        s = RunReducer.apply(s, ev("""{"type":"workflow.log","seq":904,"ts":7,"runId":"r1","text":"Verified 3 findings."}""")).first
        assertEquals(listOf(1, 2), s.detail.logs.map { it.n })

        s = RunReducer.apply(s, ev("""{"type":"workflow.agent","seq":905,"ts":1,"runId":"r1","call":{"seq":9,"kind":"agent","label":"report","phase":"Report","state":"running","attempt":1,"lastTool":"Writing","inputTokens":0,"outputTokens":0,"costUsd":0}}""")).first
        assertEquals(9, s.detail.calls.last().seq)
        assertEquals(RunActivity(9, "Writing"), s.activity)

        // the call the step named ends: the step goes back to the newest running call with a tool
        s = RunReducer.apply(s, ev("""{"type":"workflow.agent","seq":905,"ts":1,"runId":"r1","call":{"seq":9,"kind":"agent","label":"report","phase":"Report","state":"done","attempt":1,"inputTokens":10,"outputTokens":5,"costUsd":0}}""")).first
        assertNull(s.activity)
        assertEquals(RunActivity(5, "Running bun test"), WorkflowWords.activity(s.detail, s.activity))

        s = RunReducer.apply(s, ev("""{"type":"workflow.phase","seq":906,"ts":1,"runId":"r1","index":3,"title":"Report"}""")).first
        assertEquals(3, s.detail.run.phaseIndex)

        // the run ends: load it again for the result and findings
        val ended = ConclaveJson.encodeToString(WorkflowRun.serializer(), s.detail.run.copy(status = WorkflowRunStatus.DONE))
        val r = RunReducer.apply(s, ev("""{"type":"workflow.run","seq":907,"ts":1,"run":$ended}"""))
        s = r.first
        reload = r.second
        assertTrue(reload)
        assertNull(s.activity)
        assertNull(WorkflowWords.activity(s.detail, s.activity))
        // a status change while it stays live does not reload
        val live = RunLive(detail())
        val paused = ConclaveJson.encodeToString(WorkflowRun.serializer(), live.detail.run.copy(status = WorkflowRunStatus.PAUSED))
        assertFalse(RunReducer.apply(live, ev("""{"type":"workflow.run","seq":908,"ts":1,"run":$paused}""")).second)
    }

    @Test
    fun logsStayBounded() {
        var s = RunLive(detail())
        repeat(RunReducer.MAX_LOGS + 50) { s = RunReducer.apply(s, EngineEvent.WorkflowLog("r1", it.toLong(), "line $it")).first }
        assertEquals(RunReducer.MAX_LOGS, s.detail.logs.size)
        assertEquals("line ${RunReducer.MAX_LOGS + 49}", s.detail.logs.last().text)
    }

    @Test
    fun runsListAndControls() = runBlocking {
        server.enqueue(MockResponse(body = """[{"id":"r2","name":"deep-research","status":"waiting_reset","resumeAt":99,"counts":{"agents":3},"createdAt":2}]"""))
        val runs = client().workflowRuns(sessionId = "s1", limit = 50)
        val req = server.takeRequest()
        assertEquals("s1", req.url.queryParameter("sessionId"))
        assertEquals("50", req.url.queryParameter("limit"))
        assertNull(req.url.queryParameter("status"))
        assertEquals(99L, runs.single().resumeAt)

        val updated = RunReducer.upsertRun(runs, runs.single().copy(status = WorkflowRunStatus.RUNNING))
        assertEquals(WorkflowRunStatus.RUNNING, updated.single().status)
        val added = RunReducer.upsertRun(updated, WorkflowRun(id = "r3", sessionId = "s1"))
        assertEquals(listOf("r3", "r2"), added.map { it.id })
        assertEquals(added, RunReducer.upsertRun(added, WorkflowRun(id = "r4", sessionId = "other"), sessionId = "s1"))

        for (path in listOf("pause", "resume", "stop")) server.enqueue(MockResponse(body = """{"id":"r2"}"""))
        client().pauseWorkflow("r2")
        client().resumeWorkflow("r2")
        client().stopWorkflow("r2")
        assertEquals(listOf("/api/workflows/runs/r2/pause", "/api/workflows/runs/r2/resume", "/api/workflows/runs/r2/stop"), List(3) { server.takeRequest().url.encodedPath })

        server.enqueue(MockResponse(body = """{"id":"r2"}"""))
        client().skipWorkflowCall("r2", 7)
        val skip = server.takeRequest()
        assertEquals("/api/workflows/runs/r2/calls/7/skip", skip.url.encodedPath)
        assertEquals("POST", skip.method)

        server.enqueue(MockResponse(body = """{"id":"r2"}"""))
        client().rerunWorkflow("r2", 3)
        assertEquals("""{"fromSeq":3}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun transcriptAndDeepLink() {
        val msgs = ConclaveJson.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(dev.conclave.client.model.Message.serializer()),
            """[
              {"id":"m1","role":"user","content":[{"type":"text","text":"<system-reminder>notes</system-reminder>"},{"type":"text","text":"Check the auth change."}]},
              {"id":"m2","role":"assistant","content":[{"type":"text","text":"Reading it."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/auth.ts"}}]},
              {"id":"m3","role":"assistant","kind":"notice","content":[{"type":"text","text":"limit"}]},
              {"id":"m4","role":"assistant","content":[{"type":"text","text":"${"x".repeat(50)}"}]},
              {"id":"m5","role":"assistant","content":[]}
            ]""",
        )
        val c = WorkflowCall(seq = 3, promptPreview = "preview")
        assertEquals("Check the auth change.", WorkflowWords.transcriptPrompt(msgs, c))
        assertEquals("preview", WorkflowWords.transcriptPrompt(null, c))
        val steps = WorkflowWords.transcriptSteps(msgs, cut = 20)
        assertEquals(listOf("m2", "m4"), steps.map { it.id })
        assertEquals(1, steps[0].tools.size)
        assertTrue(steps[0].tools.single().contains("auth.ts"))
        assertEquals("x".repeat(20) + "…", steps[1].text)
        val p = WorkflowWords.statusParts(detail().run, detail().calls)
        assertEquals("Running. Phase 3 of 4, Verify", p.head)
        assertEquals("412k tokens, $3.10", p.spend)

        assertEquals(dev.conclave.client.logic.DeepLink.WorkflowRun("r1"), dev.conclave.client.logic.DeepLink.parse("/workflows/runs/r1"))
        assertEquals(dev.conclave.client.logic.DeepLink.WorkflowRun("r 2"), dev.conclave.client.logic.DeepLink.parse("conclave://workflow-run/r%202"))
        assertNull(dev.conclave.client.logic.DeepLink.parse("/workflows/runs"))
    }

    @Test
    fun resultView() {
        assertEquals(WorkflowWords.ResultView(null, null), WorkflowWords.result(null))
        assertEquals("Safe to merge.", WorkflowWords.result(ConclaveJson.parseToJsonElement("\"Safe to merge.\"")).report)
        val obj = WorkflowWords.result(ConclaveJson.parseToJsonElement("""{"report":"# Verdict","proven":[1]}"""))
        assertEquals("# Verdict", obj.report)
        assertTrue(obj.json!!.contains("\"proven\""))
        assertNull(WorkflowWords.result(ConclaveJson.parseToJsonElement("""{"count":2}""")).report)
    }
}
