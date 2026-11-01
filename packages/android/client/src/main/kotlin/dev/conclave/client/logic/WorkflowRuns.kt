package dev.conclave.client.logic

import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.plainText
import dev.conclave.client.model.string
import dev.conclave.client.model.visibleText
import dev.conclave.client.model.WorkflowCall
import dev.conclave.client.model.WorkflowCallKind
import dev.conclave.client.model.WorkflowCallState
import dev.conclave.client.model.WorkflowLogLine
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunDetail
import dev.conclave.client.model.WorkflowRunStatus
import dev.conclave.client.motion.KnotState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** One phase of a run with its calls, in meta.phases order. */
data class PhaseGroup(val title: String, val detail: String?, val calls: List<WorkflowCall>)

/** A call row and how far it is indented (a nested workflow()'s calls sit under it). */
data class CallRow(val call: WorkflowCall, val depth: Int)

/** The step the run view shows under its sentence: which call, doing what. */
data class RunActivity(val seq: Int, val text: String)

/**
 * The words of a workflow run (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 3.18 and the web's features/workflows/words.ts): a state word per run and
 * per call in a fixed place, the status sentence a run opens with, and calls
 * grouped by phase.
 */
object WorkflowWords {
    private val LIVE = setOf(WorkflowRunStatus.QUEUED, WorkflowRunStatus.RUNNING, WorkflowRunStatus.PAUSED, WorkflowRunStatus.WAITING_RESET)

    /** Queued, running, paused or waiting for a limit: it can still change. */
    fun isLive(s: WorkflowRunStatus): Boolean = s in LIVE

    fun runWord(s: WorkflowRunStatus): String = when (s) {
        WorkflowRunStatus.QUEUED -> "queued"
        WorkflowRunStatus.RUNNING -> "running"
        WorkflowRunStatus.PAUSED -> "paused"
        WorkflowRunStatus.WAITING_RESET -> "waiting for the limit"
        WorkflowRunStatus.INTERRUPTED -> "interrupted"
        WorkflowRunStatus.DONE -> "done"
        WorkflowRunStatus.FAILED -> "failed"
        WorkflowRunStatus.STOPPED -> "stopped"
        WorkflowRunStatus.BUDGET -> "stopped at budget"
    }

    fun runTone(s: WorkflowRunStatus): StateTone = when (s) {
        WorkflowRunStatus.RUNNING -> StateTone.SIGNAL
        WorkflowRunStatus.PAUSED, WorkflowRunStatus.WAITING_RESET, WorkflowRunStatus.INTERRUPTED, WorkflowRunStatus.BUDGET -> StateTone.WARN
        WorkflowRunStatus.FAILED -> StateTone.FAULT
        WorkflowRunStatus.QUEUED, WorkflowRunStatus.DONE, WorkflowRunStatus.STOPPED -> StateTone.DIM
    }

    /** The Knot next to a run's sentence. */
    fun knot(run: WorkflowRun): KnotState = when (run.status) {
        WorkflowRunStatus.RUNNING, WorkflowRunStatus.QUEUED -> if (run.counts.running > 0) KnotState.TOOL else KnotState.THINKING
        WorkflowRunStatus.PAUSED, WorkflowRunStatus.INTERRUPTED -> KnotState.WAITING
        WorkflowRunStatus.WAITING_RESET -> KnotState.PAUSED
        WorkflowRunStatus.FAILED -> KnotState.FAILED
        else -> KnotState.DONE
    }

    /** A call cut short because the owner stopped the run: not a failure of the call. */
    fun stoppedByRun(call: WorkflowCall): Boolean = call.state == WorkflowCallState.FAILED && call.error == "the run was stopped"

    fun callWord(call: WorkflowCall): String = when {
        call.waitingOnOwner -> "waiting for you"
        stoppedByRun(call) -> "stopped"
        else -> when (call.state) {
            WorkflowCallState.QUEUED -> "queued"
            WorkflowCallState.RUNNING -> "running"
            WorkflowCallState.DONE -> "done"
            WorkflowCallState.FAILED -> "failed"
            WorkflowCallState.SKIPPED -> "skipped"
            WorkflowCallState.CACHED -> "cached"
            WorkflowCallState.PARKED -> "waiting"
        }
    }

    fun callTone(call: WorkflowCall): StateTone = when {
        call.waitingOnOwner -> StateTone.WARN
        stoppedByRun(call) -> StateTone.DIM
        else -> when (call.state) {
            WorkflowCallState.RUNNING -> StateTone.SIGNAL
            WorkflowCallState.FAILED -> StateTone.FAULT
            WorkflowCallState.PARKED -> StateTone.WARN
            else -> StateTone.DIM
        }
    }

    /** "Phase 2 of 4, Verify", or null before the first phase. */
    fun phaseLine(run: WorkflowRun): String? {
        if (run.phaseIndex < 0) return null
        val title = run.phases.getOrNull(run.phaseIndex)?.title ?: run.phaseTitle ?: return null
        return if (run.phases.isNotEmpty()) "Phase ${run.phaseIndex + 1} of ${run.phases.size}, $title" else title
    }

    fun agents(n: Int): String = if (n == 1) "1 agent" else "$n agents"

    /**
     * "Running. Phase 2 of 4, Verify. 14 agents: 9 done, 1 running, 1 waiting
     * for you, 1 failed. 412k tokens, $3.10." A running call whose agent waits
     * on a tool approval counts as waiting for you, not as running.
     */
    fun statusSentence(run: WorkflowRun, calls: List<WorkflowCall> = emptyList()): String {
        val p = statusParts(run, calls)
        return "${p.head}. ${p.agents}. ${p.spend}."
    }

    /**
     * The sentence in three parts, so the view can wrap the words and roll
     * the numbers: "Running. Phase 2 of 4, Verify", "14 agents: 9 done,
     * 1 running" and "412k tokens, $3.10".
     */
    data class StatusParts(val head: String, val agents: String, val spend: String)

    fun statusParts(run: WorkflowRun, calls: List<WorkflowCall> = emptyList()): StatusParts {
        val c = run.counts
        val waiting = calls.count { it.kind == WorkflowCallKind.AGENT && it.waitingOnOwner }
        val running = (c.running - waiting).coerceAtLeast(0)
        val bits = listOfNotNull(
            (c.done + c.cached).takeIf { it > 0 }?.let { "$it done" },
            running.takeIf { it > 0 }?.let { "$it running" },
            waiting.takeIf { it > 0 }?.let { "$it waiting for you" },
            c.failed.takeIf { it > 0 }?.let { "$it failed" },
            c.parked.takeIf { it > 0 }?.let { "$it waiting for a limit" },
            c.skipped.takeIf { it > 0 }?.let { "$it skipped" },
        )
        val lead = runWord(run.status).replaceFirstChar { it.uppercase() }
        val agents = agents(c.agents) + if (bits.isEmpty()) "" else ": " + bits.joinToString(", ")
        val spend = "${Format.tokens(run.inputTokens + run.outputTokens)} tokens, ${Format.usd(run.costUsd)}"
        return StatusParts(listOfNotNull(lead, phaseLine(run)).joinToString(". "), agents, spend)
    }

    /** One line for a run in a list: "done, 14 agents, 412k tokens, $3.10". */
    fun runMeta(run: WorkflowRun): String =
        listOf(agents(run.counts.agents), "${Format.tokens(run.inputTokens + run.outputTokens)} tokens", Format.usd(run.costUsd)).joinToString(", ")

    /** Calls grouped by phase in meta.phases order; calls in a phase meta does not name come last, under "Other calls". */
    fun byPhase(run: WorkflowRun, calls: List<WorkflowCall>): List<PhaseGroup> {
        val titles = run.phases.map { it.title }
        val groups = run.phases.map { p -> PhaseGroup(p.title, p.detail, calls.filter { it.phase == p.title }) }
        val other = calls.filter { it.phase == null || it.phase !in titles }
        return if (other.isEmpty()) groups else groups + PhaseGroup("Other calls", null, other)
    }

    /** "3 of 5 done", "not started" for a later phase of a live run, or "no agents". */
    fun phaseProgress(group: PhaseGroup, index: Int, run: WorkflowRun): String = when {
        group.calls.isNotEmpty() -> "${group.calls.count { it.state == WorkflowCallState.DONE || it.state == WorkflowCallState.CACHED }} of ${group.calls.size} done"
        index > run.phaseIndex && isLive(run.status) -> "not started"
        else -> "no agents"
    }

    /** Rows of one phase: calls in order, a nested workflow()'s calls right under it, indented. */
    fun rows(calls: List<WorkflowCall>): List<CallRow> {
        val seqs = calls.map { it.seq }.toSet()
        val children = calls.filter { it.parentSeq != null && it.parentSeq in seqs }.groupBy { it.parentSeq!! }
        val out = ArrayList<CallRow>(calls.size)
        val seen = HashSet<Int>()
        fun walk(c: WorkflowCall, depth: Int) {
            if (!seen.add(c.seq)) return
            out += CallRow(c, depth)
            // depth is capped: a broken parent chain cannot indent forever
            children[c.seq]?.forEach { walk(it, (depth + 1).coerceAtMost(3)) }
        }
        calls.filter { it.parentSeq == null || it.parentSeq !in seqs }.forEach { walk(it, 0) }
        // a cycle of parents has no top: list what is left flat
        calls.forEach { if (it.seq !in seen) walk(it, 0) }
        return out
    }

    /** Skip while the call can still run; it then returns null to the script. */
    fun canSkip(run: WorkflowRun, call: WorkflowCall): Boolean =
        isLive(run.status) && (call.state == WorkflowCallState.QUEUED || call.state == WorkflowCallState.RUNNING || call.state == WorkflowCallState.PARKED)

    /** Rerun from a call once the run ended: earlier calls replay from the journal. */
    fun canRerun(run: WorkflowRun): Boolean = !isLive(run.status)

    /** "Sonnet 5.5, Reading src/auth.ts, 12k tokens, $0.04" under a call's label. */
    fun callMeta(call: WorkflowCall, lastTool: String?): String = listOfNotNull(
        call.model?.let { ModelRefs.displayName(it) }?.ifBlank { null } ?: call.kind.takeIf { it != WorkflowCallKind.AGENT }?.wire,
        if (call.state == WorkflowCallState.FAILED && !stoppedByRun(call)) call.error else lastTool,
        call.tokens.takeIf { it > 0 }?.let { "${Format.tokens(it)} tokens" },
        call.costUsd.takeIf { it > 0 }?.let { Format.usd(it) },
        call.attempt.takeIf { it > 1 }?.let { "attempt $it" },
    ).filter { it.isNotBlank() }.joinToString(", ")

    fun callLabel(call: WorkflowCall): String = call.label?.ifBlank { null } ?: if (call.kind == WorkflowCallKind.WORKFLOW) "workflow" else "call ${call.seq}"

    /** What is happening now: the newest progress, else the newest running call with a tool. */
    fun activity(detail: WorkflowRunDetail, last: RunActivity?): RunActivity? {
        if (!isLive(detail.run.status)) return null
        if (last != null) return last
        val running = detail.calls.lastOrNull { it.state == WorkflowCallState.RUNNING && !it.lastTool.isNullOrBlank() } ?: return null
        return RunActivity(running.seq, running.lastTool!!)
    }

    /** One step of an agent's transcript: what it wrote (cut) and the tools it called. */
    data class TranscriptStep(val id: String, val text: String, val tools: List<String>)

    /** The prompt the agent got: its first user message, else the call's preview. */
    fun transcriptPrompt(messages: List<Message>?, call: WorkflowCall): String =
        messages?.firstOrNull { it.role == Role.USER }?.content?.visibleText()?.ifBlank { null } ?: call.promptPreview.orEmpty()

    /** The agent's steps, read only: each normal assistant message with its text cut to [cut] characters and its tool calls as one line each. */
    fun transcriptSteps(messages: List<Message>, cut: Int = 1200): List<TranscriptStep> =
        messages.filter { it.role == Role.ASSISTANT && it.kind == MessageKind.NORMAL }.mapNotNull { m ->
            val text = m.content.plainText().let { if (it.length > cut) it.take(cut).trimEnd() + "…" else it }
            val tools = m.content.filterIsInstance<ToolUseBlock>().map { ToolSummary.of(it.name, it.input) }
            if (text.isBlank() && tools.isEmpty()) null else TranscriptStep(m.id, text, tools)
        }

    // -----------------------------------------------------------------------
    // A Workflow call in a session (Tasks.kt): its row, and its run live
    // -----------------------------------------------------------------------

    private val SCRIPT_NAME = Regex("""name:\s*['"]([^'"]+)""")

    /** The workflow a call runs: its library name, else the name in its script's meta, else "workflow". */
    fun workflowName(input: JsonObject?): String =
        input?.string("name")?.trim()?.ifEmpty { null }
            ?: input?.string("script")?.let { SCRIPT_NAME.find(it)?.groupValues?.get(1)?.trim()?.ifEmpty { null } }
            ?: "workflow"

    /** The name the call gives, when it gives one: a library workflow or a script's meta. */
    private fun namedIn(input: JsonObject?): String? =
        input?.string("name")?.trim()?.ifEmpty { null } ?: input?.string("script")?.let { SCRIPT_NAME.find(it)?.groupValues?.get(1) }

    /**
     * Whether [run] is the one a Workflow call [use] started. The run names
     * its call (toolUseId) on hubs that send it, and then only that call
     * matches. On a hub that does not, a live run of the session with the
     * call's workflow name (any live run when the call names none) is it.
     */
    fun startedBy(run: WorkflowRun, use: ToolUseBlock, sessionId: String?): Boolean {
        run.toolUseId?.let { return it == use.id }
        if (sessionId == null || run.sessionId != sessionId || !isLive(run.status)) return false
        val name = namedIn(use.input)
        return name == null || run.name == name
    }

    /** The run of a Workflow call: the one its result names, else the newest one it started. */
    fun runOf(use: ToolUseBlock, runId: String?, runs: List<WorkflowRun>, sessionId: String?): WorkflowRun? {
        if (runId != null) return runs.firstOrNull { it.id == runId }
        return runs.filter { startedBy(it, use, sessionId) }.maxByOrNull { it.createdAt }
    }

    /** "3 of 6 agents running". */
    fun agentsRunning(run: WorkflowRun): String = "${run.counts.running} of ${agents(run.counts.agents)} running"

    /**
     * A Workflow call's compact row: "Workflow deep-research, running, 3 of
     * 6 agents" while it runs, "Workflow deep-research, done, 6 agents" once
     * it ended. Without a run: "starting" while the call runs, "did not
     * start" when it failed before one, "done" after.
     */
    fun rowWords(name: String, run: WorkflowRun?, callLive: Boolean, failedToStart: Boolean = false): String {
        val state = when {
            run != null && isLive(run.status) -> "${runWord(run.status)}, ${run.counts.running} of ${agents(run.counts.agents)}"
            run != null -> "${runWord(run.status)}, ${agents(run.counts.agents)}"
            failedToStart -> "did not start"
            callLive -> "starting"
            else -> "done"
        }
        return "Workflow $name, $state"
    }

    /** A phase on a run's card: its calls and where the run is. */
    data class CardPhase(
        val title: String,
        /** DONE: the run is past it. CURRENT: the run is in it. NEXT: not reached. */
        val state: PhaseState,
        val calls: List<WorkflowCall>,
        val done: Int,
        val running: Int,
        val waiting: Int,
        val failed: Int,
    )

    enum class PhaseState { DONE, CURRENT, NEXT }

    private fun settled(c: WorkflowCall) = c.state == WorkflowCallState.DONE || c.state == WorkflowCallState.CACHED || c.state == WorkflowCallState.SKIPPED

    /**
     * The run's phases with their top level calls (a nested workflow's own
     * calls are in the run view), in meta.phases order, then calls in phases
     * meta does not name. A finished run has no current phase.
     */
    fun cardPhases(run: WorkflowRun, calls: List<WorkflowCall>): List<CardPhase> {
        val seqs = calls.map { it.seq }.toSet()
        val top = calls.filter { it.parentSeq == null || it.parentSeq !in seqs }
        val live = isLive(run.status)
        return byPhase(run, top).mapIndexed { i, g ->
            val state = when {
                i >= run.phases.size -> if (live && g.calls.any { !settled(it) && it.state != WorkflowCallState.FAILED }) PhaseState.CURRENT else PhaseState.DONE
                i < run.phaseIndex -> PhaseState.DONE
                i == run.phaseIndex -> if (live) PhaseState.CURRENT else PhaseState.DONE
                else -> if (!live && g.calls.isNotEmpty()) PhaseState.DONE else PhaseState.NEXT
            }
            CardPhase(
                title = g.title,
                state = state,
                calls = g.calls,
                done = g.calls.count { settled(it) },
                running = g.calls.count { it.state == WorkflowCallState.RUNNING && !it.waitingOnOwner },
                waiting = g.calls.count { it.state == WorkflowCallState.PARKED || it.waitingOnOwner },
                failed = g.calls.count { it.state == WorkflowCallState.FAILED && !stoppedByRun(it) },
            )
        }
    }

    /** "3 of 8 done, 2 running, 1 failed"; "" for a phase with no calls. */
    fun phaseWords(p: CardPhase): String {
        if (p.calls.isEmpty()) return ""
        return listOfNotNull(
            "${p.done} of ${p.calls.size} done",
            p.running.takeIf { it > 0 }?.let { "$it running" },
            p.waiting.takeIf { it > 0 }?.let { "$it waiting" },
            p.failed.takeIf { it > 0 }?.let { "$it failed" },
        ).joinToString(", ")
    }

    /** A phase lists its agents while the run is in it, or when one of them failed or waits on you. */
    fun phaseOpen(p: CardPhase): Boolean = p.calls.isNotEmpty() && (p.state == PhaseState.CURRENT || p.failed > 0 || p.waiting > 0)

    /**
     * The calls a phase shows: all of them up to [max]; past that the ones
     * still to finish and the failed ones, in their order, and how many more
     * the run view has.
     */
    fun shownCalls(calls: List<WorkflowCall>, max: Int = 8): Pair<List<WorkflowCall>, Int> {
        if (calls.size <= max) return calls to 0
        val shown = calls.filter { !settled(it) }.take(max)
        return shown to calls.size - shown.size
    }

    /** What an agent does now while it runs (its last tool), or why it failed. Null otherwise. */
    fun agentNow(call: WorkflowCall, lastTool: String?): String? = when {
        call.state == WorkflowCallState.RUNNING -> (lastTool ?: call.lastTool)?.ifBlank { null }?.removePrefix("needs approval: ")
        call.state == WorkflowCallState.FAILED && !stoppedByRun(call) -> call.error?.ifBlank { null }
        else -> null
    }

    private fun pickText(v: JsonElement?): String? = when (v) {
        is JsonPrimitive -> if (v.isString) v.content.trim().ifEmpty { null } else null
        is JsonObject -> listOf("summary", "report", "answer", "result", "text", "message", "verdict").firstNotNullOfOrNull { pickText(v[it]) }
        else -> null
    }

    private val BREAK = Regex("""\n\s*\n""")
    private val MARK = Regex("""^\s*(#+\s+|[-*]\s+|>\s+)""")

    /**
     * A finished run's result in one line: the first line of its report (a
     * string result, or the summary, report or text of an object), else of
     * the body of the Workflow tool's text, else the error. Markdown marks at
     * the start go; a long line is cut at 200 characters.
     */
    fun resultLine(result: JsonElement?, toolText: String? = null, error: String? = null): String? {
        var text = pickText(result)
        if (text == null && toolText != null) {
            // the tool's text: a head ("Workflow x done. Run wfr_1 ..."), a blank line, then the result
            val body = toolText.split(BREAK).drop(1).joinToString("\n\n").trim()
            if (body.isNotEmpty() && body != "(no result)") {
                text = runCatching { pickText(Json.parseToJsonElement(body)) }.getOrNull() ?: body
            }
        }
        val line = (text ?: error)?.lineSequence()?.map { it.replace(MARK, "").replace("**", "").trim() }?.firstOrNull { it.isNotEmpty() } ?: return null
        return ToolLines.cut(line, 200)
    }

    private val Pretty = Json { prettyPrint = true }

    /**
     * The run's result as the view shows it: [report] is text to render as
     * Markdown (a string result, or an object's "report"), [json] the whole
     * object pretty printed. Both null when the run returned nothing.
     */
    data class ResultView(val report: String?, val json: String?)

    fun result(r: JsonElement?): ResultView {
        if (r == null || r is JsonNull) return ResultView(null, null)
        if (r is JsonPrimitive) return ResultView(r.contentOrNull?.ifBlank { null }, null)
        val report = ((r as? JsonObject)?.get("report") as? JsonPrimitive)?.takeIf { it.isString }?.content?.ifBlank { null }
        return ResultView(report, Pretty.encodeToString(JsonElement.serializer(), r))
    }
}

/** A run view's state: the detail, the last tool per call from progress events, and the current step. */
data class RunLive(
    val detail: WorkflowRunDetail,
    val progress: Map<Int, String> = emptyMap(),
    val activity: RunActivity? = null,
)

/**
 * Keeps one run's detail live from the hub's workflow.* events, as the web's
 * useRunDetail does. [apply] returns the new state and whether to load the
 * run again: when it ends (the result and findings come with the end) and
 * when it starts again after a resume (its calls start over).
 */
object RunReducer {
    /** Logs kept in memory for one run view. */
    const val MAX_LOGS = 1000

    fun apply(s: RunLive, e: EngineEvent): Pair<RunLive, Boolean> {
        val id = s.detail.run.id
        return when (e) {
            is EngineEvent.WorkflowRunUpdated -> {
                if (e.run.id != id) return s to false
                val wasLive = WorkflowWords.isLive(s.detail.run.status)
                val live = WorkflowWords.isLive(e.run.status)
                s.copy(detail = s.detail.copy(run = e.run), activity = if (live) s.activity else null) to (wasLive != live)
            }
            is EngineEvent.WorkflowCallUpdated -> {
                if (e.runId != id) return s to false
                val call = e.call
                val activity = when {
                    call.state == WorkflowCallState.RUNNING && !call.lastTool.isNullOrBlank() -> RunActivity(call.seq, call.lastTool)
                    // the call the step named ended: the newest running call speaks again
                    s.activity?.seq == call.seq && call.state != WorkflowCallState.RUNNING -> null
                    else -> s.activity
                }
                s.copy(detail = s.detail.copy(calls = upsertCall(s.detail.calls, call)), activity = activity) to false
            }
            is EngineEvent.WorkflowLog -> {
                if (e.runId != id) return s to false
                val logs = s.detail.logs
                val next = logs + WorkflowLogLine(n = (logs.lastOrNull()?.n ?: 0) + 1, ts = e.ts, text = e.text)
                s.copy(detail = s.detail.copy(logs = if (next.size > MAX_LOGS) next.takeLast(MAX_LOGS) else next)) to false
            }
            is EngineEvent.WorkflowProgress -> {
                if (e.runId != id) return s to false
                val seq = e.callSeq
                val waiting = e.waitingOnOwner
                val calls = if (waiting == null) {
                    s.detail.calls
                } else {
                    s.detail.calls.map { if (it.seq == seq) it.copy(waiting = if (waiting) "approval" else null) else it }
                }
                s.copy(
                    detail = s.detail.copy(calls = calls),
                    progress = s.progress + (seq to e.lastTool),
                    activity = RunActivity(seq, e.lastTool),
                ) to false
            }
            is EngineEvent.WorkflowPhaseStarted -> {
                if (e.runId != id) return s to false
                s.copy(detail = s.detail.copy(run = s.detail.run.copy(phaseIndex = e.index, phaseTitle = e.title))) to false
            }
            else -> s to false
        }
    }

    /** Put one call in its place by number. */
    fun upsertCall(list: List<WorkflowCall>, c: WorkflowCall): List<WorkflowCall> {
        val i = list.indexOfFirst { it.seq == c.seq }
        if (i < 0) return (list + c).sortedBy { it.seq }
        return list.toMutableList().also { it[i] = c }
    }

    /** A runs list kept live: a new run goes on top, a known one is replaced in place. */
    fun upsertRun(list: List<WorkflowRun>, run: WorkflowRun, sessionId: String? = null): List<WorkflowRun> {
        if (sessionId != null && run.sessionId != sessionId) return list
        val i = list.indexOfFirst { it.id == run.id }
        if (i < 0) return listOf(run) + list
        return list.toMutableList().also { it[i] = run }
    }
}
