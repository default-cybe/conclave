package dev.conclave.client

import dev.conclave.client.logic.BlockState
import dev.conclave.client.logic.Canvas
import dev.conclave.client.logic.CanvasFile
import dev.conclave.client.model.FlowNodeLive
import dev.conclave.client.model.FlowRunStatus
import dev.conclave.client.model.FlowView
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.WorkflowCall
import dev.conclave.client.model.WorkflowCallKind
import dev.conclave.client.model.WorkflowCallState
import dev.conclave.client.model.WorkflowGraphView
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunStatus
import dev.conclave.client.model.WorkflowSource
import dev.conclave.client.model.WorkflowSummary
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

/** Canvas on the phone: the graphs decode, the files group as the web's sidebar, and the cards light up from a run. */
class CanvasTest {
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

    private val workflowGraphJson = """{
      "graph":{"name":"review","phases":["Find","Verify"],"edges":[],"nodes":[
        {"id":"agent-1","kind":"agent","label":"scope","span":{"start":3,"end":5},"phase":"Find","declares":["s"],"calls":[],"opts":{"label":{"value":"scope","start":1,"end":2}},"source":"x"},
        {"id":"parallel-1","kind":"parallel","label":"reviewers","span":{"start":7,"end":12},"phase":"Find","declares":[],"calls":[{"name":"agent","line":8,"label":"review"}],"source":"x"},
        {"id":"code-1","kind":"code","label":"helper","span":{"start":14,"end":16},"fn":true,"declares":[],"calls":[{"name":"agent","line":15}],"source":"x"},
        {"id":"check-1","kind":"check","label":"tests","span":{"start":18,"end":18},"phase":"Verify","declares":[],"calls":[],"source":"x"},
        {"id":"return-1","kind":"return","label":"return","span":{"start":20,"end":20},"phase":"Verify","declares":[],"calls":[],"source":"x"}
      ]},
      "sha":"abc","source":"builtin","editable":false,"readOnly":"library","futureKey":1
    }"""

    private fun call(
        seq: Int,
        state: WorkflowCallState,
        kind: WorkflowCallKind = WorkflowCallKind.AGENT,
        at: List<Int>? = null,
        label: String? = null,
        result: String? = null,
        error: String? = null,
        startedAt: Long? = null,
        parentSeq: Int? = null,
    ) = WorkflowCall(seq = seq, kind = kind, state = state, at = at, label = label, resultPreview = result, error = error, startedAt = startedAt, parentSeq = parentSeq)

    @Test
    fun workflowGraphDecodesAndHitsTheRoute() = runBlocking {
        server.enqueue(MockResponse(body = workflowGraphJson))
        val v = client().workflowGraph("plugin:x y")
        assertEquals("/api/workflows/plugin:x%20y/graph", server.takeRequest().url.encodedPath)
        assertEquals(WorkflowSource.BUILTIN, v.source)
        assertEquals(5, v.graph.nodes.size)
        assertEquals(true, v.graph.nodes[2].fn)
        assertEquals(listOf("Find", "Verify"), v.graph.phases)
    }

    @Test
    fun flowRunNullIsNoRun() = runBlocking {
        server.enqueue(MockResponse(body = "null"))
        assertNull(client().flowRun("s1", "daily"))
        assertEquals("/api/sessions/s1/flows/daily/run", server.takeRequest().url.encodedPath)
        server.enqueue(MockResponse(body = """{"runId":"f1","flow":"daily","status":"approval","startedAt":5,"output":"","nodes":{}}"""))
        assertEquals(FlowRunStatus.APPROVAL, client().flowRun("s1", "daily")?.status)
    }

    @Test
    fun workflowCardsLightFromCalls() {
        val g = ConclaveJson.decodeFromString(WorkflowGraphView.serializer(), workflowGraphJson).graph
        val calls = listOf(
            // by label (no lines journaled)
            call(1, WorkflowCallState.DONE, label = "scope", result = "  12 files\nin scope  "),
            // by lines; one done and one running: running wins and counts from its start
            call(2, WorkflowCallState.DONE, at = listOf(8)),
            call(3, WorkflowCallState.RUNNING, at = listOf(8), startedAt = 1000),
            // a helper's line first, then the parallel node that called it: the parallel node, not the helper
            call(4, WorkflowCallState.FAILED, at = listOf(15, 9), error = "boom"),
            // no lines, no label: the next node that can make a check
            call(5, WorkflowCallState.CACHED, kind = WorkflowCallKind.CHECK, result = "ok"),
        )
        val blocks = Canvas.workflowBlocks(g, calls)
        assertEquals(listOf("agent-1", "parallel-1", "check-1", "return-1"), blocks.map { it.id })
        assertEquals(BlockState.DONE, blocks[0].state)
        assertEquals("12 files in scope", blocks[0].value)
        assertEquals(BlockState.FAILED, blocks[1].state)
        assertEquals("boom", blocks[1].error)
        assertEquals(BlockState.CACHED, blocks[2].state)
        assertEquals("ok", blocks[2].value)
        assertEquals(BlockState.IDLE, blocks[3].state)
        val running = Canvas.workflowBlocks(g, calls.take(3))
        assertEquals(BlockState.RUNNING, running[1].state)
        assertEquals(1000L, running[1].startedAt)
        // a call under a workflow() call belongs to its parent's node
        val nested = Canvas.nodeRuns(g, listOf(call(1, WorkflowCallState.RUNNING, kind = WorkflowCallKind.WORKFLOW, at = listOf(18)), call(2, WorkflowCallState.SKIPPED, at = listOf(3), parentSeq = 1)))
        assertEquals(listOf(1, 2), nested["check-1"]?.seqs)
        assertNull(nested["agent-1"])
        // phase headers in order
        assertEquals(listOf("Find", "Verify"), Canvas.sections(blocks).map { it.phase })
        val waiting = call(1, WorkflowCallState.RUNNING, label = "scope").copy(waiting = "approval")
        assertEquals(BlockState.WAITING, Canvas.workflowBlocks(g, listOf(waiting))[0].state)
    }

    @Test
    fun programCardsFollowTheTrace() {
        val v = ConclaveJson.decodeFromString(
            FlowView.serializer(),
            """{"name":"daily","path":"flows/daily.flow.ts","sha":"s","graph":{"name":"daily","phases":[],"edges":[],"nodes":[
              {"id":"page","kind":"block","block":"fetchUrl","label":"page","span":{"start":1,"end":1},"declares":["page"],"calls":[],"source":"x"},
              {"id":"sum","kind":"block","block":"callAi","label":"sum","span":{"start":2,"end":2},"declares":["sum"],"calls":[],"source":"x"},
              {"id":"out","kind":"block","block":"log","label":"out","span":{"start":3,"end":3},"declares":[],"calls":[],"source":"x"}]},
              "lastRun":{"runId":"r","flow":"daily","status":"running","startedAt":100,"output":"","nodes":{"page":{"ok":true,"ms":40,"summary":"200 chars"}}}}""",
        )
        val run = v.lastRun!!
        val live = Canvas.programBlocks(v.graph, run)
        assertEquals(listOf(BlockState.DONE, BlockState.RUNNING, BlockState.QUEUED), live.map { it.state })
        assertEquals("fetchUrl", live[0].kind)
        assertEquals("200 chars", live[0].value)
        assertEquals(140L, live[1].startedAt)
        val failed = run.copy(status = FlowRunStatus.FAILED, error = "exit 1", nodes = run.nodes + ("sum" to FlowNodeLive(ok = false)))
        val f = Canvas.programBlocks(v.graph, failed)
        assertEquals(listOf(BlockState.DONE, BlockState.FAILED, BlockState.IDLE), f.map { it.state })
        assertEquals("exit 1", f[1].error)
        assertTrue(Canvas.programBlocks(v.graph, null).all { it.state == BlockState.IDLE })
        assertTrue(Canvas.flowLive(run))
        assertFalse(Canvas.flowLive(failed))
    }

    @Test
    fun filesGroupAsTheWebSidebar() {
        fun s(id: String, cwd: String, at: Long, kind: SessionKind? = null, agent: String = "coder", parent: String? = null, archived: Boolean = false) =
            Session(id = id, cwd = cwd, device = "pc", updatedAt = at, kind = kind, agent = agent, parentId = parent, archived = archived)
        val sessions = listOf(
            s("a", "/code/site", 1), s("b", "/code/site", 5), s("c", "/code/api", 3),
            s("chat", "/code/x", 9, kind = SessionKind.CHAT), s("home", "/code/y", 9, agent = "assistant"),
            s("sub", "/code/z", 9, parent = "b"), s("old", "/code/w", 9, archived = true), s("nocwd", "", 9),
        )
        assertEquals(listOf("b", "c"), Canvas.folderSessions(sessions).map { it.id })
        assertEquals("b", Canvas.sessionFor(sessions, "pc", "/code/site")?.id)
        assertNull(Canvas.sessionFor(sessions, "laptop", "/code/site"))

        val wf = Canvas.workflowFiles(
            listOf(WorkflowSummary("review", "review", source = WorkflowSource.BUILTIN), WorkflowSummary("mine", "mine", source = WorkflowSource.USER), WorkflowSummary("alpha", "alpha", source = WorkflowSource.PROJECT)),
            listOf(
                WorkflowRun("wfr_1", "review", status = WorkflowRunStatus.DONE, createdAt = 1),
                WorkflowRun("wfr_2", "mine", status = WorkflowRunStatus.RUNNING, createdAt = 2),
                WorkflowRun("wfr_3", "mine", status = WorkflowRunStatus.FAILED, createdAt = 0),
            ),
        )
        assertEquals(listOf("alpha", "mine", "review", "mine", "review", "mine"), wf.map { it.name })
        assertEquals(listOf("wfr_2", "wfr_1", "wfr_3"), wf.mapNotNull { it.runId })
        assertTrue(wf[3].live)
        assertTrue(wf[5].failed)

        val prog = CanvasFile.Program("daily news", "pc", "/code/my site", "b")
        val groups = Canvas.groups(listOf(prog) + wf) { "${it.cwd}, ${it.device}" }
        assertEquals(listOf("/code/my site, pc", "Your workflows", "Library workflows", "Recent runs"), groups.map { it.label })
        assertEquals("daily news.flow.ts", prog.title)
        assertEquals("/canvas/program/daily%20news?device=pc&cwd=%2Fcode%2Fmy%20site", Canvas.webPath(prog))
        assertEquals("/canvas/workflow/wfr_2", Canvas.webPath(wf[3]))
        assertEquals("/canvas/workflow/review", Canvas.webPath(wf[2]))
    }
}
