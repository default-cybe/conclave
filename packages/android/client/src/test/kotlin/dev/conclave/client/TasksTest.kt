package dev.conclave.client

import dev.conclave.client.logic.RunningTask
import dev.conclave.client.logic.SubagentNow
import dev.conclave.client.logic.Tasks
import dev.conclave.client.logic.WorkflowWords
import dev.conclave.client.model.Message
import dev.conclave.client.model.Role
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolResultMeta
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.WorkflowCall
import dev.conclave.client.model.WorkflowCallState
import dev.conclave.client.model.WorkflowCounts
import dev.conclave.client.model.WorkflowPhase
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunStatus
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Workflows and subagents as the Claude app shows them: compact rows, "2 running tasks", what a subagent does now. */
class TasksTest {
    private fun use(id: String, name: String, vararg pairs: Pair<String, String>) =
        ToolUseBlock(id, name, JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) }))

    private val flow = use("w1", "Workflow", "name" to "deep-research")
    private val task = use("t1", "Task", "description" to "Find the auth code", "subagent_type" to "explore", "prompt" to "Find where auth happens")
    private val parent = Session("s1", agent = "coder", status = SessionStatus.RUNNING)

    private fun run(id: String, status: WorkflowRunStatus = WorkflowRunStatus.RUNNING, toolUseId: String? = null, name: String = "deep-research", createdAt: Long = 1, running: Int = 3, agents: Int = 6) =
        WorkflowRun(
            id,
            name = name,
            status = status,
            sessionId = "s1",
            toolUseId = toolUseId,
            createdAt = createdAt,
            phases = listOf(WorkflowPhase("Plan"), WorkflowPhase("Search"), WorkflowPhase("Write")),
            phaseIndex = 1,
            counts = WorkflowCounts(agents = agents, running = running, done = agents - running),
        )

    private fun turn(vararg blocks: dev.conclave.client.model.ContentBlock) = listOf(Message("a1", "s1", 1, Role.ASSISTANT, content = blocks.toList()))

    @Test
    fun aFanOutCardSaysHowManySubagentsRunAndFailed() {
        assertEquals("4 subagents, 2 running, 1 failed", Tasks.fanOutWords(4, 2, 1))
        assertEquals("3 subagents", Tasks.fanOutWords(3, 0, 0))
        assertEquals("1 subagent, 1 running", Tasks.fanOutWords(1, 1, 0))
    }

    @Test
    fun theRunningTasksAreTheLiveRunsAndTheSubagentsStillAtWork() {
        val child = Session("c1", title = "Find the auth code", agent = "explore", model = "anthropic/claude-haiku-5-5", status = SessionStatus.RUNNING, parentId = "s1", createdAt = 5)
        val runs = listOf(run("r1", toolUseId = "w1"), run("r0", WorkflowRunStatus.DONE, toolUseId = "w0"))
        val tasks = Tasks.running(parent, turn(TextBlock("On it."), flow, task), emptyMap(), runs, listOf(parent, child))
        assertEquals(listOf("run:r1", "task:t1"), tasks.map { it.key })
        assertEquals("w1", (tasks[0] as RunningTask.Flow).use?.id)
        assertEquals("c1", (tasks[1] as RunningTask.Agent).child?.id)
        assertEquals("2 running tasks", Tasks.pill(tasks.size))
        assertEquals("1 running task", Tasks.pill(1))

        // the subagent answered: it is done
        val answered = mapOf("t1" to ToolResultBlock("t1", JsonPrimitive("auth.ts"), meta = ToolResultMeta(sessionId = "c1", agent = "explore")))
        val idle = child.copy(status = SessionStatus.IDLE)
        assertEquals(listOf("run:r1"), Tasks.running(parent, turn(flow, task), answered, runs, listOf(parent, idle)).map { it.key })
        // in the background it answers at once and keeps working while its session does
        val background = mapOf("t1" to ToolResultBlock("t1", JsonPrimitive("Started."), meta = ToolResultMeta(sessionId = "c1", background = true)))
        assertEquals(listOf("task:t1"), Tasks.running(parent.copy(status = SessionStatus.IDLE), turn(task), background, emptyList(), listOf(child)).map { it.key })
        assertEquals(emptyList(), Tasks.running(parent.copy(status = SessionStatus.IDLE), turn(task), background, emptyList(), listOf(idle)).map { it.key })
        // another session's runs are not this one's
        assertEquals(emptyList(), Tasks.running(parent, turn(flow), emptyMap(), listOf(run("r9").copy(sessionId = "other")), emptyList()))
        // a harness's subagent has no session here: it runs while the turn does
        assertTrue(Tasks.running(task, null, null, parent))
        assertFalse(Tasks.running(task, null, null, parent.copy(status = SessionStatus.IDLE)))
    }

    @Test
    fun theSubagentsSessionIsTheOneItsResultNamesElseItsTitledChild() {
        val a = Session("c1", title = "Find the auth code", parentId = "s1", createdAt = 1)
        val b = Session("c2", title = "Find the auth code", parentId = "s1", createdAt = 2)
        val other = Session("c3", title = "Find the auth code", parentId = "s9", createdAt = 3)
        assertEquals("c2", Tasks.child(task, null, "s1", listOf(a, b, other))?.id)
        assertEquals("c1", Tasks.child(task, ToolResultBlock("t1", meta = ToolResultMeta(sessionId = "c1")), "s1", listOf(a, b))?.id)
        // the hub cuts a title at 60 characters
        val long = use("t2", "Task", "description" to "x".repeat(80))
        assertEquals("c4", Tasks.child(long, null, "s1", listOf(Session("c4", title = "x".repeat(60), parentId = "s1")))?.id)
        assertNull(Tasks.child(task, null, "s1", listOf(other)))
    }

    @Test
    fun aSubagentsRowSaysWhoItIsAndWhatItDoesNow() {
        val child = Session("c1", agent = "explore", model = "anthropic/claude-haiku-5-5", status = SessionStatus.RUNNING)
        assertEquals("explore", Tasks.agentOf(task, null, null))
        assertEquals("Subagent explore: Find the auth code, searching for jwt", Tasks.subagentRow(task, "explore", "Searching for jwt"))
        assertEquals("Subagent explore: Find the auth code", Tasks.subagentRow(task, "explore", null))
        assertEquals("Subagent Find the auth code", Tasks.subagentRow(task, null, null))
        assertTrue(Tasks.who(task, null, child).startsWith("explore, "))

        // from its own session: the call running now, in the present
        val grep = use("g1", "Grep", "pattern" to "jwt")
        val msgs = listOf(Message("m1", "c1", 1, Role.ASSISTANT, content = listOf(TextBlock("Looking."), grep)))
        assertEquals(SubagentNow("Searching for jwt"), Tasks.now(child, msgs, emptyMap()))
        // its last call once it has a result, in the past
        val read = use("r1", "Read", "file_path" to "/repo/src/auth.ts")
        val after = listOf(Message("m1", "c1", 1, Role.ASSISTANT, content = listOf(read)))
        assertEquals(SubagentNow("Read auth.ts"), Tasks.now(child, after, mapOf("r1" to ToolResultBlock("r1"))))
        assertEquals(SubagentNow("Reading auth.ts"), Tasks.now(child, after, emptyMap()))
        // writing, thinking, waiting on you, starting
        assertEquals(SubagentNow("Writing"), Tasks.now(child, listOf(Message("m2", "c1", 2, Role.ASSISTANT, content = listOf(TextBlock("Found it")))), emptyMap()))
        assertEquals(SubagentNow("Thinking"), Tasks.now(child, listOf(Message("m2", "c1", 2, Role.ASSISTANT, content = listOf(ThinkingBlock("hmm")))), emptyMap()))
        assertEquals(SubagentNow("Waiting on you", waiting = true), Tasks.now(child.copy(status = SessionStatus.WAITING_APPROVAL), msgs, emptyMap()))
        assertEquals(SubagentNow("Starting"), Tasks.now(null, emptyList(), emptyMap()))
        assertEquals(SubagentNow("Starting"), Tasks.now(child, emptyList(), emptyMap()))
        // a harness's subagent: the call's own progress line
        assertEquals(SubagentNow("Reading the router"), Tasks.now(null, emptyList(), emptyMap(), progress = "Started\nReading the router\n"))
    }

    @Test
    fun aWorkflowCallFindsItsRun() {
        val mine = run("r2", toolUseId = "w1", createdAt = 2)
        val another = run("r3", toolUseId = "w9", createdAt = 3)
        assertEquals("r2", WorkflowWords.runOf(flow, null, listOf(mine, another), "s1")?.id)
        // the run its result names
        assertEquals("r3", WorkflowWords.runOf(flow, "r3", listOf(mine, another), "s1")?.id)
        // a hub that does not name the call: the newest live run of the session with the call's workflow
        val old = run("r4", createdAt = 4)
        val otherName = run("r5", name = "review-changes", createdAt = 5)
        assertEquals("r4", WorkflowWords.runOf(flow, null, listOf(old, otherName), "s1")?.id)
        assertFalse(WorkflowWords.startedBy(run("r6", WorkflowRunStatus.DONE), flow, "s1"))
        // a script names its workflow in its meta
        val script = ToolUseBlock("w2", "Workflow", buildJsonObject { put("script", "export const meta = { name: 'sweep' }") })
        assertEquals("sweep", WorkflowWords.workflowName(script.input))
        assertEquals("workflow", WorkflowWords.workflowName(JsonObject(emptyMap())))
    }

    @Test
    fun aWorkflowsRowAndItsDetailReadPlainly() {
        val live = run("r1")
        assertEquals("Workflow deep-research, running, 3 of 6 agents", WorkflowWords.rowWords("deep-research", live, callLive = true))
        assertEquals("3 of 6 agents running", WorkflowWords.agentsRunning(live))
        assertEquals("Phase 2 of 3, Search", WorkflowWords.phaseLine(live))
        assertEquals("Workflow deep-research, done, 6 agents", WorkflowWords.rowWords("deep-research", run("r1", WorkflowRunStatus.DONE, running = 0), callLive = false))
        assertEquals("Workflow deep-research, starting", WorkflowWords.rowWords("deep-research", null, callLive = true))
        assertEquals("Workflow deep-research, did not start", WorkflowWords.rowWords("deep-research", null, callLive = false, failedToStart = true))

        val calls = listOf(
            WorkflowCall(1, label = "plan", phase = "Plan", state = WorkflowCallState.DONE),
            WorkflowCall(2, label = "jwt", phase = "Search", state = WorkflowCallState.RUNNING, lastTool = "Grep jwt", startedAt = 10),
            WorkflowCall(3, label = "sessions", phase = "Search", state = WorkflowCallState.FAILED, error = "timed out"),
            WorkflowCall(4, label = "cookies", phase = "Search", state = WorkflowCallState.QUEUED),
            WorkflowCall(5, label = "inner", phase = "Search", state = WorkflowCallState.RUNNING, parentSeq = 4),
        )
        val phases = WorkflowWords.cardPhases(live, calls)
        assertEquals(listOf(WorkflowWords.PhaseState.DONE, WorkflowWords.PhaseState.CURRENT, WorkflowWords.PhaseState.NEXT), phases.map { it.state })
        // a nested workflow's own calls are in the run view
        assertEquals(listOf(2, 3, 4), phases[1].calls.map { it.seq })
        assertEquals("0 of 3 done, 1 running, 1 failed", WorkflowWords.phaseWords(phases[1]))
        assertEquals("1 of 1 done", WorkflowWords.phaseWords(phases[0]))
        assertEquals("", WorkflowWords.phaseWords(phases[2]))
        assertTrue(WorkflowWords.phaseOpen(phases[1]))
        assertFalse(WorkflowWords.phaseOpen(phases[0]))
        // what an agent does now, or why it failed
        assertEquals("Grep jwt", WorkflowWords.agentNow(calls[1], null))
        assertEquals("Read auth.ts", WorkflowWords.agentNow(calls[1], "Read auth.ts"))
        assertEquals("timed out", WorkflowWords.agentNow(calls[2], null))
        assertNull(WorkflowWords.agentNow(calls[0], null))
        // an ended run has no current phase
        assertTrue(WorkflowWords.cardPhases(run("r1", WorkflowRunStatus.DONE), calls).none { it.state == WorkflowWords.PhaseState.CURRENT })
        // past eight, the ones still at work, and how many more
        val many = (1..12).map { WorkflowCall(it, state = if (it <= 9) WorkflowCallState.DONE else WorkflowCallState.RUNNING) }
        val (shown, more) = WorkflowWords.shownCalls(many)
        assertEquals(listOf(10, 11, 12), shown.map { it.seq })
        assertEquals(9, more)
    }

    @Test
    fun aDelegateCallIsASubagentNamedByWhoDoesItAndWhere() {
        val call = use("d1", "Delegate", "to" to "code", "device" to "madx arch", "description" to "Find names in the capstone PDFs", "prompt" to "List every person named in the PDFs.\nOne per line.")
        assertTrue(dev.conclave.client.logic.Work.isTask(call))
        assertTrue(dev.conclave.client.logic.Work.standsAlone(call))
        // before its session shows up: the device as the call wrote it
        assertEquals("Code on madx arch: Find names in the capstone PDFs", Tasks.subagentRow(call, null, null, Tasks.handedTo(call, null, null)))
        // its session carries the call's id and the device's name
        val place = buildJsonObject { put("deviceName", "MadX Arch"); put("toolUseId", "d1") }
        val child = Session("c9", title = "Find names in the capstone PDFs", agent = "explore", status = SessionStatus.RUNNING, parentId = "s1", meta = buildJsonObject { put("delegate", place) })
        assertEquals("c9", Tasks.child(call, null, "s1", listOf(parent, child))?.id)
        assertEquals("Code on MadX Arch", Tasks.handedTo(call, null, child))
        assertEquals("explore", Tasks.agentOf(call, null, child))
        assertEquals("Code on MadX Arch: Find names in the capstone PDFs, reading notes.pdf", Tasks.subagentRow(call, "explore", "Reading notes.pdf", Tasks.handedTo(call, null, child)))
        assertEquals(listOf("task:d1"), Tasks.running(parent, turn(call), emptyMap(), emptyList(), listOf(parent, child)).map { it.key })
        // answered: the result names the device
        val result = ToolResultBlock("d1", JsonPrimitive("Ada Lovelace"), meta = ToolResultMeta(sessionId = "c9", agent = "explore", delegate = place))
        assertEquals("Code on MadX Arch", Tasks.handedTo(call, result, null))
        // no description: the brief's first line, as the hub titles the session; the assistant is named so
        val bare = use("d2", "Delegate", "to" to "assistant", "prompt" to "Check Friday for a free hour.\nReturn the times.")
        assertEquals("Check Friday for a free hour.", Tasks.description(bare))
        assertEquals("Assistant", Tasks.handedTo(bare, null, null))
        // a Task call keeps its words
        assertNull(Tasks.handedTo(task, null, null))
        assertEquals("Subagent explore: Find the auth code", Tasks.subagentRow(task, "explore", null))
    }

    @Test
    fun aFinishedRunClosesToOneLineOfItsResult() {
        assertEquals("Caddy wins for a homelab.", WorkflowWords.resultLine(JsonPrimitive("# Caddy wins for a homelab.\n\nMore here.")))
        assertEquals("Three findings, one proven.", WorkflowWords.resultLine(buildJsonObject { put("summary", "**Three findings**, one proven.") }))
        // the tool's text: a head, a blank line, the result
        assertEquals("Use Caddy.", WorkflowWords.resultLine(null, "Workflow deep-research done. Run wfr_1.\n\n- Use Caddy.\n- Then Tailscale."))
        assertEquals("the run was stopped", WorkflowWords.resultLine(null, "Workflow x stopped.", "the run was stopped"))
        assertNull(WorkflowWords.resultLine(null, "Workflow x done.\n\n(no result)"))
        assertEquals(200, WorkflowWords.resultLine(JsonPrimitive("y".repeat(300)))?.length)
    }
}
