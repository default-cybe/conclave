package dev.conclave.client.logic

import dev.conclave.client.model.FlowRunStatus
import dev.conclave.client.model.FlowRunView
import dev.conclave.client.model.GraphNode
import dev.conclave.client.model.Session
import dev.conclave.client.model.WorkflowCall
import dev.conclave.client.model.WorkflowCallKind
import dev.conclave.client.model.WorkflowCallState
import dev.conclave.client.model.WorkflowGraph
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowSource
import dev.conclave.client.model.WorkflowSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Canvas on the phone (docs/design/CANVAS-MODE.md), read only: the files as
 * the web's sidebar lists them (features/canvas/model.ts), and a graph as
 * block cards in run order, each lit by the last run (core client/graph.ts
 * nodeRuns for workflows, features/canvas/run.ts programStates for programs).
 */
sealed interface CanvasFile {
    val title: String

    /** flows/<name>.flow.ts in a folder on a device, read through [sessionId]. */
    data class Program(val name: String, val device: String, val cwd: String, val sessionId: String) : CanvasFile {
        override val title: String get() = "$name.flow.ts"
    }

    /** A workflow, yours or the library's, or one run of it ([runId]). */
    data class Workflow(val id: String, val name: String, val group: Group, val runId: String? = null, val live: Boolean = false, val failed: Boolean = false) : CanvasFile {
        override val title: String get() = name
    }

    enum class Group(val label: String) { YOURS("Your workflows"), LIBRARY("Library workflows"), RUNS("Recent runs") }
}

data class CanvasGroup(val label: String, val files: List<CanvasFile>)

/** What a block shows from its run. */
enum class BlockState(val word: String, val tone: StateTone) {
    IDLE("", StateTone.DIM),
    QUEUED("queued", StateTone.DIM),
    RUNNING("running", StateTone.SIGNAL),
    WAITING("waiting for you", StateTone.WARN),
    PARKED("waiting for the limit", StateTone.WARN),
    DONE("done", StateTone.OK),
    CACHED("cached", StateTone.DIM),
    FAILED("failed", StateTone.FAULT),
    SKIPPED("skipped", StateTone.DIM),
}

/** One card: [startedAt] counts up while it runs, [value] is the short output, [error] the failed block's reason. */
data class CanvasBlock(
    val id: String,
    val title: String,
    val kind: String,
    val phase: String?,
    val state: BlockState,
    val startedAt: Long? = null,
    val value: String? = null,
    val error: String? = null,
)

/** Cards under a phase header; [phase] null for blocks before the first phase(). */
data class CanvasSection(val phase: String?, val blocks: List<CanvasBlock>)

object Canvas {
    private val LIBRARY = setOf(WorkflowSource.BUILTIN, WorkflowSource.PLUGIN, WorkflowSource.CLAUDE_CODE)

    // ---- the files ----

    private fun codeSession(s: Session) = !s.archived && !Delegated.underParent(s) && Start.modeOf(s) == StartMode.CODE && s.cwd.isNotBlank()

    /** The newest Code session of each folder (device and cwd), newest folder first, at most [max]. */
    fun folderSessions(sessions: Iterable<Session>, max: Int = 12): List<Session> =
        sessions.filter(::codeSession)
            .groupBy { it.device to it.cwd }
            .values.map { g -> g.maxBy { it.updatedAt } }
            .sortedByDescending { it.updatedAt }
            .take(max)

    /** The session a program is read through: the newest Code session in that folder on that device. */
    fun sessionFor(sessions: Iterable<Session>, device: String, cwd: String): Session? =
        sessions.filter { codeSession(it) && it.device == device && it.cwd == cwd }.maxByOrNull { it.updatedAt }

    /** Yours then the library's, each by name; then the [maxRuns] newest runs. */
    fun workflowFiles(library: List<WorkflowSummary>, runs: List<WorkflowRun>, maxRuns: Int = 8): List<CanvasFile.Workflow> {
        val wf = library.map { CanvasFile.Workflow(it.id, it.name.ifBlank { it.id }, if (it.source in LIBRARY) CanvasFile.Group.LIBRARY else CanvasFile.Group.YOURS) }
            .sortedWith(compareBy<CanvasFile.Workflow> { it.group == CanvasFile.Group.LIBRARY }.thenBy { it.name })
        val rs = runs.sortedByDescending { it.createdAt }.take(maxRuns).map {
            CanvasFile.Workflow(it.name, it.name.ifBlank { it.id }, CanvasFile.Group.RUNS, runId = it.id, live = WorkflowWords.isLive(it.status), failed = it.status == dev.conclave.client.model.WorkflowRunStatus.FAILED)
        }
        return wf + rs
    }

    /** The list's groups in order of first appearance: each program folder, then Your workflows, Library workflows, Recent runs. */
    fun groups(files: List<CanvasFile>, folderLabel: (CanvasFile.Program) -> String): List<CanvasGroup> {
        val out = LinkedHashMap<String, MutableList<CanvasFile>>()
        for (f in files) {
            val label = when (f) {
                is CanvasFile.Program -> folderLabel(f)
                is CanvasFile.Workflow -> f.group.label
            }
            out.getOrPut(label) { ArrayList() }.add(f)
        }
        return out.map { (k, v) -> CanvasGroup(k, v) }
    }

    /** The web's address of a file, for Open on web (editing): /canvas/program/<name>?device=&cwd= or /canvas/workflow/<id or run>. */
    fun webPath(f: CanvasFile): String = when (f) {
        is CanvasFile.Program -> "/canvas/program/${enc(f.name)}?device=${enc(f.device)}&cwd=${enc(f.cwd)}"
        is CanvasFile.Workflow -> "/canvas/workflow/${enc(f.runId ?: f.id)}"
    }

    /** The hub's queue key for a file (core canvas/queue.ts, web queueFile): a workflow by id, a program by its session and name. */
    fun queueFile(f: CanvasFile, sessionId: String?): String = when (f) {
        is CanvasFile.Program -> "program:${sessionId ?: f.sessionId}:${f.name}"
        is CanvasFile.Workflow -> "workflow:${f.id}"
    }

    // URLSearchParams and encodeURIComponent agree on everything a name or path holds except the space
    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    // ---- a program's blocks ----

    fun flowLive(r: FlowRunView?): Boolean = r?.status == FlowRunStatus.RUNNING || r?.status == FlowRunStatus.APPROVAL

    /**
     * A program's cards: the trace reports a block when it ends, so while it
     * runs the first block with no value yet is running and the rest queued.
     * The running one counts from the run's start plus the blocks done.
     */
    fun programBlocks(graph: WorkflowGraph, run: FlowRunView?): List<CanvasBlock> {
        var first = run?.status == FlowRunStatus.RUNNING
        val live = flowLive(run)
        val doneMs = run?.nodes?.values?.sumOf { it.ms ?: 0L } ?: 0L
        return graph.nodes.map { n ->
            val v = run?.nodes?.get(n.id)
            val state = when {
                v != null -> if (v.ok) BlockState.DONE else BlockState.FAILED
                live && first -> BlockState.RUNNING.also { first = false }
                live -> BlockState.QUEUED
                else -> BlockState.IDLE
            }
            CanvasBlock(
                id = n.id,
                title = n.label.ifBlank { n.id },
                kind = n.block ?: n.kind,
                phase = n.phase,
                state = state,
                startedAt = if (state == BlockState.RUNNING) run?.startedAt?.plus(doneMs) else null,
                value = if (v?.ok == true) shortValue(v.summary ?: v.value) else null,
                error = if (v != null && !v.ok) v.error ?: run.error ?: "failed" else null,
            )
        }
    }

    // ---- a workflow's blocks ----

    /** A node's calls rolled up (core client/graph.ts NodeRun, the parts a card shows). */
    data class NodeRun(val state: BlockState, val seqs: List<Int>, val startedAt: Long?, val error: String?, val value: String?)

    // the worst state wins the card
    private val RANK = listOf(BlockState.FAILED, BlockState.WAITING, BlockState.RUNNING, BlockState.PARKED, BlockState.QUEUED, BlockState.DONE, BlockState.CACHED, BlockState.SKIPPED, BlockState.IDLE)

    private fun stateOf(c: WorkflowCall): BlockState = when {
        c.waiting != null || (c.kind == WorkflowCallKind.ASK && c.state == WorkflowCallState.RUNNING) -> BlockState.WAITING
        else -> when (c.state) {
            WorkflowCallState.QUEUED -> BlockState.QUEUED
            WorkflowCallState.RUNNING -> BlockState.RUNNING
            WorkflowCallState.DONE -> BlockState.DONE
            WorkflowCallState.FAILED -> BlockState.FAILED
            WorkflowCallState.SKIPPED -> BlockState.SKIPPED
            WorkflowCallState.CACHED -> BlockState.CACHED
            WorkflowCallState.PARKED -> BlockState.PARKED
        }
    }

    private fun optLabel(n: GraphNode): String? = (n.opts?.get("label")?.value as? JsonPrimitive)?.contentOrNull

    /** The node a call belongs to: its parent workflow()'s, by call-site lines, else by label. */
    fun nodeOf(call: WorkflowCall, graph: WorkflowGraph, bySeq: Map<Int, WorkflowCall> = emptyMap(), depth: Int = 0): GraphNode? {
        val parent = call.parentSeq?.let { bySeq[it] }
        if (parent != null && parent.seq != call.seq && depth < 32) return nodeOf(parent, graph, bySeq, depth + 1)
        val at = call.at
        if (!at.isNullOrEmpty()) {
            for (fn in listOf(false, true)) for (line in at) {
                graph.nodes.firstOrNull { (it.fn == true) == fn && line >= it.span.start && line <= it.span.end }?.let { return it }
            }
        }
        val label = call.label ?: return null
        return graph.nodes.firstOrNull { optLabel(it) == label }
            ?: graph.nodes.firstOrNull { n -> n.calls.any { c -> c.label != null && label.startsWith(c.label) } }
    }

    private fun holds(n: GraphNode, kind: WorkflowCallKind): Boolean {
        if (n.fn == true) return false
        fun inner(vararg names: String) = n.calls.any { it.name in names }
        return when (kind) {
            WorkflowCallKind.AGENT -> n.kind in setOf("agent", "parallel", "pipeline") || inner("agent", "parallel", "pipeline", "lib.panel", "lib.judgePanel", "lib.loopUntilDry")
            WorkflowCallKind.CHECK -> n.kind == "check" || inner("lib.runCheck", "lib.exec")
            WorkflowCallKind.ASK -> n.kind == "ask" || n.kind == "approve" || inner("lib.ask", "lib.approve")
            WorkflowCallKind.WORKFLOW -> n.kind == "workflow" || inner("workflow")
            else -> false
        }
    }

    /** Each node's calls rolled up, as core client/graph.ts nodeRuns: a call with no lines and no static label goes to the next node that can make it. */
    fun nodeRuns(graph: WorkflowGraph, calls: List<WorkflowCall>): Map<String, NodeRun> {
        val bySeq = calls.associateBy { it.seq }
        val acc = LinkedHashMap<String, MutableList<WorkflowCall>>()
        var cursor = 0
        for (c in calls) {
            var n = nodeOf(c, graph, bySeq)
            if (n == null && c.at.isNullOrEmpty() && c.parentSeq == null) {
                val fits = { x: GraphNode -> holds(x, c.kind) && (c.phase == null || x.phase == null || x.phase == c.phase) && !(x.kind == "agent" && acc.containsKey(x.id)) }
                n = graph.nodes.drop(cursor).firstOrNull(fits) ?: graph.nodes.firstOrNull(fits)
            }
            if (n == null) continue
            if (n.fn != true) cursor = maxOf(cursor, graph.nodes.indexOf(n))
            acc.getOrPut(n.id) { ArrayList() }.add(c)
        }
        return acc.mapValues { (_, list) ->
            val states = list.map(::stateOf)
            var state = states.minBy { RANK.indexOf(it) }
            // all cached stays cached; cached next to live answers reads as done
            if (state == BlockState.CACHED && BlockState.DONE in states) state = BlockState.DONE
            NodeRun(
                state = state,
                seqs = list.map { it.seq },
                startedAt = list.filter { stateOf(it) == BlockState.RUNNING || stateOf(it) == BlockState.WAITING }.mapNotNull { it.startedAt }.minOrNull(),
                error = list.firstOrNull { it.state == WorkflowCallState.FAILED }?.error,
                value = list.lastOrNull { (it.state == WorkflowCallState.DONE || it.state == WorkflowCallState.CACHED) && !it.resultPreview.isNullOrBlank() }?.resultPreview?.let(::shortValue),
            )
        }
    }

    /** A workflow's cards in statement order; helpers (fn) are left out, their calls light the node that called them. */
    fun workflowBlocks(graph: WorkflowGraph, calls: List<WorkflowCall>?, runError: String? = null): List<CanvasBlock> {
        val runs = calls?.let { nodeRuns(graph, it) }.orEmpty()
        return graph.nodes.filter { it.fn != true }.map { n ->
            val r = runs[n.id]
            val state = r?.state ?: BlockState.IDLE
            CanvasBlock(
                id = n.id,
                title = n.label.ifBlank { n.id },
                kind = n.kind,
                phase = n.phase,
                state = state,
                startedAt = if (state == BlockState.RUNNING || state == BlockState.WAITING) r?.startedAt else null,
                value = if (state == BlockState.DONE || state == BlockState.CACHED) r?.value else null,
                error = if (state == BlockState.FAILED) r?.error ?: runError ?: "failed" else null,
            )
        }
    }

    /** Consecutive cards of one phase under one header. */
    fun sections(blocks: List<CanvasBlock>): List<CanvasSection> {
        val out = ArrayList<CanvasSection>()
        for (b in blocks) {
            val last = out.lastOrNull()
            if (last != null && last.phase == b.phase) out[out.size - 1] = last.copy(blocks = last.blocks + b)
            else out.add(CanvasSection(b.phase, listOf(b)))
        }
        return out
    }

    /**
     * Read a live run again every [intervalMs] while [live]. It waits while
     * nobody [watched] it (a StateFlow's subscriptionCount: the screen is in
     * the background or covered), so a run that never ends does not poll
     * from a hidden screen. A failed read is skipped, the next one tries again.
     */
    suspend fun pollLive(intervalMs: Long, live: () -> Boolean, watched: StateFlow<Int>, read: suspend () -> Unit) {
        while (live()) {
            delay(intervalMs)
            watched.first { it > 0 }
            try {
                read()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    /** A value as a card's line: one line, at most 60 characters. */
    fun shortValue(text: String?): String? {
        val t = text?.replace(Regex("\\s+"), " ")?.trim()
        if (t.isNullOrEmpty()) return null
        return if (t.length > 60) t.take(59) + "…" else t
    }
}
