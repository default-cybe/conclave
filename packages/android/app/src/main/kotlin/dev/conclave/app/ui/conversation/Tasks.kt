@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Science
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.CodeBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.StateWordText
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.toneColor
import dev.conclave.app.ui.motion.Knot
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.workflows.LocalOpenWorkflowRun
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.RunLive
import dev.conclave.client.logic.RunReducer
import dev.conclave.client.logic.RunningTask
import dev.conclave.client.logic.StateTone
import dev.conclave.client.logic.SubagentNow
import dev.conclave.client.logic.TaskGlyph
import dev.conclave.client.logic.TaskKind
import dev.conclave.client.logic.TaskKinds
import dev.conclave.client.logic.Tasks
import dev.conclave.client.logic.Transcript
import dev.conclave.client.logic.TranscriptReducer
import dev.conclave.client.logic.WorkflowWords
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.WorkflowCall
import dev.conclave.client.model.WorkflowCallState
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunStatus
import dev.conclave.client.motion.KnotState
import dev.conclave.client.pauseWorkflow
import dev.conclave.client.resumeWorkflow
import dev.conclave.client.workflowRun
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

/*
 * Workflows and subagents in a session, as the Claude app shows them
 * (logic/Tasks.kt). A Workflow or Task call is one compact row of its own in
 * the transcript, outside the group of thoughts and calls around it: a tap
 * opens its detail in a sheet. While any of them runs, "2 running tasks"
 * sits above the composer and opens a sheet with each one. Everything is
 * kept live from the hub's events (workflow.*, the subagent's own messages);
 * nothing polls.
 */

/** What the rows of a session's work need from its screen: the session, its workflow runs and the progress of its calls, live. */
@Immutable
data class SessionWork(
    val session: Session? = null,
    val runs: List<WorkflowRun> = emptyList(),
    val progress: Map<String, String> = emptyMap(),
)

val LocalSessionWork = compositionLocalOf { SessionWork() }

/** Opens a session (a subagent's) from anywhere in the app. Null where nothing provides it. */
val LocalOpenSession = staticCompositionLocalOf<((String) -> Unit)?> { null }

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

/**
 * One run kept live while a detail shows it: the run from the hub, then its
 * workflow.* events (RunReducer, as the run view). Loaded again when the run
 * ends or starts again, and after a reconnect. Null until it loads.
 */
@Composable
fun rememberRunLive(runId: String?): RunLive? {
    val hub = LocalAppContainer.current.hub
    val state = produceState<RunLive?>(null, runId) {
        if (runId == null) return@produceState
        val load = Channel<Unit>(Channel.CONFLATED)
        // subscribe first, so nothing that happens during the load is lost
        launch {
            hub.events.collect { e ->
                if (e is EngineEvent.ConfigUpdated) {
                    load.trySend(Unit)
                    return@collect
                }
                val s = value ?: return@collect
                val (next, again) = RunReducer.apply(s, e)
                if (next !== s) value = next
                if (again) load.trySend(Unit)
            }
        }
        load.trySend(Unit)
        for (x in load) {
            try {
                val d = hub.api { it.workflowRun(runId) }
                value = value?.copy(detail = d) ?: RunLive(d)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // the next event or reconnect tries again
            }
        }
    }
    return state.value
}

/**
 * The run a Workflow call started: from the session's runs when the screen
 * keeps them, else its own (the run its result names, loaded once, then
 * every workflow.run event of it). Null until one is known.
 */
@Composable
private fun rememberCallRun(use: ToolUseBlock, result: ToolResultBlock?): WorkflowRun? {
    val hub = LocalAppContainer.current.hub
    val work = LocalSessionWork.current
    val sid = work.session?.id
    val runId = result?.meta?.workflowRunId
    val listed = WorkflowWords.runOf(use, runId, work.runs, sid)
    val own by produceState<WorkflowRun?>(null, use.id, runId, listed == null) {
        if (listed != null) return@produceState
        launch {
            hub.events.collect { e ->
                if (e is EngineEvent.WorkflowRunUpdated && (e.run.id == runId || (runId == null && WorkflowWords.startedBy(e.run, use, sid)))) value = e.run
            }
        }
        if (runId != null) {
            try {
                val run = hub.api { it.workflowRun(runId) }.run
                if (value == null) value = run
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // the row says what the call says
            }
        }
    }
    return listed ?: own
}

/**
 * What a running subagent is doing now, from its own session's messages:
 * loaded once while [on], then kept live from its events. Null while off.
 */
@Composable
private fun rememberSubagentNow(child: Session?, on: Boolean, progress: String?): SubagentNow? {
    val hub = LocalAppContainer.current.hub
    val childId = child?.id
    val transcript by produceState<Transcript?>(null, childId, on) {
        if (!on || childId == null) return@produceState
        value = Transcript(childId)
        launch {
            hub.events.collect { e ->
                if (e.sessionKey == childId) value = value?.let { TranscriptReducer.apply(it, e) }
            }
        }
        try {
            val msgs = hub.api { it.messages(childId) }
            value = value?.let { TranscriptReducer.merge(it, msgs) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // its events still come
        }
    }
    // an approval or a question of its own, or of a subagent under it, waits on you (Asks.kt)
    val approvals by hub.approvals.collectAsStateWithLifecycle()
    val questions by hub.questions.collectAsStateWithLifecycle()
    if (!on) return null
    val t = transcript
    return Tasks.now(child, t?.messages.orEmpty(), t?.toolResults.orEmpty(), t?.runningTools.orEmpty(), progress, asks = approvals + questions)
}

/** The subagent's session, and whether it still works. */
@Composable
private fun rememberSubagent(use: ToolUseBlock, result: ToolResultBlock?, callLive: Boolean): Pair<Session?, Boolean> {
    val hub = LocalAppContainer.current.hub
    val work = LocalSessionWork.current
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val parent = work.session
    val child = remember(sessions, use, result, parent?.id) { Tasks.child(use, result, parent?.id, sessions) }
    // with no session to go by (a chat), the call runs while it has no result and the reply goes on
    val running = if (parent != null) Tasks.running(use, result, child, parent) else callLive || (child != null && result?.meta?.background == true && Tasks.busy(child))
    return child to running
}

// ---------------------------------------------------------------------------
// Rows in the transcript
// ---------------------------------------------------------------------------

/**
 * A Workflow call as one compact row: "Workflow deep-research, running, 3
 * of 6 agents" with its time; once the run ended, the first line of its
 * result under it. A tap opens its detail: the phases, the agents of the
 * phase it is in and Open run.
 */
@Composable
fun WorkflowRow(use: ToolUseBlock, result: ToolResultBlock?, callLive: Boolean, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val run = rememberCallRun(use, result)
    val name = remember(use) { WorkflowWords.workflowName(use.input) }
    val runLive = run != null && WorkflowWords.isLive(run.status)
    val live = runLive || (run == null && callLive)
    val failedToStart = result?.isError == true && result.meta?.workflowRunId == null
    var open by remember { mutableStateOf(false) }
    val now by rememberNow(if (live) 1_000 else 60_000)
    val tone = when {
        run != null -> WorkflowWords.runTone(run.status)
        failedToStart -> StateTone.FAULT
        else -> StateTone.DIM
    }
    val time = run?.let { r ->
        val since = r.startedAt ?: r.createdAt
        val end = r.finishedAt
        when {
            runLive -> Format.durationShort(now - since)
            end != null -> Format.durationShort(end - since)
            else -> null
        }
    }
    val line = if (live) null else rememberResultLine(run, result)
    Column(modifier.fillMaxWidth()) {
        TaskRowHead(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = c.fg2)) { append("Workflow ") }
                withStyle(SpanStyle(color = c.fg, fontWeight = FontWeight.Medium)) { append(name) }
                val state = WorkflowWords.rowWords(name, run, callLive, failedToStart).removePrefix("Workflow $name")
                withStyle(SpanStyle(color = toneColor(tone))) { append(state) }
            },
            glyph = TaskGlyph.FLOW,
            time = time,
            live = live,
            paused = run?.status == WorkflowRunStatus.PAUSED,
            label = "Open the workflow",
            onClick = { open = true },
        )
        if (line != null) {
            Text(line, style = ConclaveType.meta, color = if (failedToStart) c.fault else c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 4.dp))
        }
    }
    if (open) {
        DetailSheet(onDismiss = { open = false }) {
            WorkflowDetail(name, run, result, callLive, onLeave = { open = false })
        }
    }
}

/** A call's result in one line when the hub has no run for it (a harness's own workflow): the body of its text, else its first line. */
private fun endLine(run: WorkflowRun?, result: ToolResultBlock?): String? {
    val text = result?.text
    return WorkflowWords.resultLine(null, text, run?.error) ?: text?.let { WorkflowWords.resultLine(JsonPrimitive(it)) }
}

/** Ended runs' result lines by run id: an ended run does not change, so each is loaded once. */
private object EndedRuns {
    private val lines = object : LinkedHashMap<String, String>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 64
    }

    @Synchronized fun get(id: String): String? = lines[id]

    @Synchronized fun put(id: String, line: String) {
        lines[id] = line
    }
}

/**
 * The one line an ended run closes to: the first line of the run's own
 * result (loaded once), else of the call's text, else its error. Without a
 * run, what the call's text says. Null while the run goes.
 */
@Composable
private fun rememberResultLine(run: WorkflowRun?, result: ToolResultBlock?): String? {
    val hub = LocalAppContainer.current.hub
    val id = run?.id
    val ended = run != null && !WorkflowWords.isLive(run.status)
    val loaded by produceState(id?.let { EndedRuns.get(it) }, id, ended) {
        if (!ended || id == null || value != null) return@produceState
        try {
            val d = hub.api { it.workflowRun(id) }
            WorkflowWords.resultLine(d.result, result?.text, d.run.error)?.let {
                EndedRuns.put(id, it)
                value = it
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // the call's own words stand in
        }
    }
    return when {
        run == null -> endLine(null, result)
        !ended -> null
        else -> loaded ?: WorkflowWords.resultLine(null, result?.text, run.error)
    }
}

/**
 * A Task call as one compact row: "Subagent explore: Find the auth code,
 * searching for jwt" with its time while the subagent works, the
 * description and how long it took after. A tap opens its detail.
 */
@Composable
fun SubagentRow(use: ToolUseBlock, result: ToolResultBlock?, callLive: Boolean, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val work = LocalSessionWork.current
    val (child, running) = rememberSubagent(use, result, callLive)
    val now = rememberSubagentNow(child, running, work.progress[use.id])
    val agent = Tasks.agentOf(use, result, child)
    val handedTo = Tasks.handedTo(use, result, child)
    var open by remember { mutableStateOf(false) }
    val clock by rememberNow(if (running) 1_000 else 60_000)
    val failed = result?.isError == true
    val time = when {
        running -> child?.createdAt?.takeIf { it > 0 }?.let { Format.durationShort(clock - it) }
        else -> result?.meta?.durationMs?.let { Format.durationShort(it) }
    }
    Column(modifier.fillMaxWidth()) {
        TaskRowHead(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = c.fg2)) { append(Tasks.lead(agent, handedTo)) }
                withStyle(SpanStyle(color = c.fg)) { append(Tasks.description(use)) }
                if (running && now != null) {
                    withStyle(SpanStyle(color = if (now.waiting) c.warn else c.fg3)) { append(", " + now.text.replaceFirstChar { it.lowercaseChar() }) }
                } else if (failed) {
                    withStyle(SpanStyle(color = c.fault)) { append(", failed") }
                }
            },
            glyph = TaskKinds.glyph(if (handedTo != null) TaskKind.DELEGATE else TaskKind.SUBAGENT, agent),
            time = time,
            live = running,
            paused = child?.status == SessionStatus.PAUSED,
            label = "Open the subagent",
            onClick = { open = true },
        )
    }
    if (open) {
        DetailSheet(onDismiss = { open = false }) {
            SubagentDetail(use, result, child, running, now, onLeave = { open = false })
        }
    }
}

/**
 * The icon a task row leads with, by its glyph (TaskKinds.glyph): one place,
 * so a later motion pack can swap the icons.
 */
fun taskIcon(glyph: TaskGlyph): ImageVector = when (glyph) {
    TaskGlyph.FLOW -> Icons.Outlined.AccountTree
    TaskGlyph.DEVICE -> Icons.Outlined.Computer
    TaskGlyph.SEARCH -> Icons.Outlined.Search
    TaskGlyph.BUILD -> Icons.Outlined.Build
    TaskGlyph.TEST -> Icons.Outlined.Science
    TaskGlyph.REVIEW -> Icons.Outlined.Visibility
    TaskGlyph.DEBUG -> Icons.Outlined.BugReport
    TaskGlyph.RESEARCH -> Icons.Outlined.Public
    TaskGlyph.DESIGN -> Icons.Outlined.Palette
    TaskGlyph.VERIFY -> Icons.Outlined.Shield
    TaskGlyph.BOT -> Icons.Outlined.SmartToy
}

/** A task row: its kind's icon (signal while it runs), the words, its time at the right ("paused" in fg3 when [paused]), a chevron. */
@Composable
private fun TaskRowHead(text: androidx.compose.ui.text.AnnotatedString, glyph: TaskGlyph, time: String?, live: Boolean, label: String, paused: Boolean = false, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).clip(RoundedCornerShape(5.dp)).clickable(onClickLabel = label, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(taskIcon(glyph), contentDescription = null, modifier = Modifier.size(16.dp), tint = if (live && !paused) c.signal else c.fg3)
        Spacer(Modifier.width(8.dp))
        Text(text, style = ConclaveType.body.copy(fontSize = 14.sp), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (paused) {
            Spacer(Modifier.width(8.dp))
            Icon(Icons.Outlined.Pause, contentDescription = null, modifier = Modifier.size(12.dp), tint = c.fg3)
            Spacer(Modifier.width(4.dp))
            Text("paused", style = ConclaveType.meta, color = c.fg3, maxLines = 1)
        } else if (time != null) {
            Spacer(Modifier.width(8.dp))
            Text(time, style = ConclaveType.metaNum, color = if (live) c.signal else c.fg3, maxLines = 1)
        }
        Spacer(Modifier.width(4.dp))
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.fg4)
    }
}

@Composable
private fun DetailSheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val c = Conclave.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) { content() }
    }
}

// ---------------------------------------------------------------------------
// Details: the same in the row's sheet and in the running tasks sheet
// ---------------------------------------------------------------------------

/**
 * A workflow as it stands: the name, its state and time, where it is
 * ("Phase 2 of 5, Search", "3 of 6 agents running") or the first line of
 * its result, each phase with its counts, and the agents of the phase it
 * is in (label, what it does now, state and time). Open run goes to the
 * run view. [onLeave] closes the sheet before it opens another screen.
 */
@Composable
fun WorkflowDetail(name: String, known: WorkflowRun?, result: ToolResultBlock?, callLive: Boolean, onLeave: () -> Unit) {
    val c = Conclave.colors
    val live = rememberRunLive(known?.id)
    val run = live?.detail?.run ?: known
    val openRun = LocalOpenWorkflowRun.current
    val runLive = run != null && WorkflowWords.isLive(run.status)
    val now by rememberNow(if (runLive) 1_000 else 60_000)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Workflow $name", style = ConclaveType.title, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (run != null) {
            Spacer(Modifier.width(8.dp))
            StateWordText(WorkflowWords.runWord(run.status), WorkflowWords.runTone(run.status))
            val since = run.startedAt ?: run.createdAt
            val took = if (runLive) now - since else run.finishedAt?.let { it - since }
            if (took != null) {
                Spacer(Modifier.width(6.dp))
                Text(Format.durationShort(took), style = ConclaveType.metaNum, color = if (runLive) c.signal else c.fg3)
            }
        }
    }
    when {
        run == null -> Text(
            if (callLive) "Waiting for approval or starting." else endLine(null, result) ?: "Finished.",
            style = ConclaveType.body,
            color = c.fg2,
        )
        runLive -> {
            WorkflowWords.phaseLine(run)?.let { Text(it, style = ConclaveType.body, color = c.fg2) }
            Text(WorkflowWords.agentsRunning(run), style = ConclaveType.meta, color = c.fg3)
        }
        else -> WorkflowWords.resultLine(live?.detail?.result, result?.text, run.error)?.let {
            Text(it, style = ConclaveType.body, color = if (run.status == WorkflowRunStatus.FAILED) c.fault else c.fg2)
        }
    }
    if (run != null) {
        if (live != null) {
            HorizontalDivider(thickness = 1.dp, color = c.rule)
            val more: (() -> Unit)? = openRun?.let { o ->
                {
                    onLeave()
                    o(run.id)
                }
            }
            WorkflowPhases(run, live.detail.calls, live.progress, now, onMore = more)
        }
        HorizontalDivider(thickness = 1.dp, color = c.rule)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(WorkflowWords.runMeta(run), style = ConclaveType.metaNum, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (run.status == WorkflowRunStatus.RUNNING || run.status == WorkflowRunStatus.PAUSED) {
                PauseResume(run.status == WorkflowRunStatus.PAUSED, pause = { it.pauseWorkflow(run.id) }, resume = { it.resumeWorkflow(run.id) })
            }
            if (openRun != null) {
                TextButton(onClick = {
                    onLeave()
                    openRun(run.id)
                }) { Text("Open run") }
            }
        }
    }
}

/** Each phase, numbered, with its counts; the one the run is in (or one that failed or waits on you) lists its agents. A tap on another lists its agents too. */
@Composable
private fun WorkflowPhases(run: WorkflowRun, calls: List<WorkflowCall>, progress: Map<Int, String>, now: Long, onMore: (() -> Unit)?) {
    val c = Conclave.colors
    val phases = remember(run, calls) { WorkflowWords.cardPhases(run, calls) }
    if (phases.isEmpty()) {
        Text("No phases yet.", style = ConclaveType.meta, color = c.fg3)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        phases.forEachIndexed { i, p ->
            var chosen by rememberSaveable(run.id, i) { mutableStateOf<Boolean?>(null) }
            val open = p.calls.isNotEmpty() && (chosen ?: WorkflowWords.phaseOpen(p))
            Row(
                Modifier.fillMaxWidth().heightIn(min = 36.dp).clip(RoundedCornerShape(5.dp)).clickable(enabled = p.calls.isNotEmpty()) { chosen = !open },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val current = p.state == WorkflowWords.PhaseState.CURRENT
                if (i < run.phases.size) {
                    Text("${i + 1}", style = ConclaveType.metaNum, color = c.fg3)
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    p.title,
                    style = ConclaveType.body.copy(fontSize = 14.sp, fontWeight = if (current) FontWeight.Medium else FontWeight.Normal),
                    color = when (p.state) {
                        WorkflowWords.PhaseState.CURRENT -> c.signal
                        WorkflowWords.PhaseState.DONE -> c.fg2
                        WorkflowWords.PhaseState.NEXT -> c.fg3
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(WorkflowWords.phaseWords(p), style = ConclaveType.metaNum, color = if (p.failed > 0) c.fault else c.fg3, maxLines = 1)
            }
            if (open) {
                val (shown, more) = WorkflowWords.shownCalls(p.calls)
                Column(Modifier.padding(start = 16.dp, bottom = 4.dp)) {
                    shown.forEach { call -> AgentLine(call, progress[call.seq], now) }
                    if (more > 0) {
                        Text(
                            "and $more more in the run",
                            style = ConclaveType.meta,
                            color = c.fg3,
                            modifier = Modifier.heightIn(min = 32.dp).clip(RoundedCornerShape(5.dp)).clickable(enabled = onMore != null) { onMore?.invoke() }.padding(vertical = 6.dp),
                        )
                    }
                }
            }
        }
    }
}

/** An agent of a run: its label, what it does now (or why it failed), its state word and its time. */
@Composable
private fun AgentLine(call: WorkflowCall, lastTool: String?, now: Long) {
    val c = Conclave.colors
    val running = call.state == WorkflowCallState.RUNNING
    val doing = WorkflowWords.agentNow(call, lastTool)
    val started = call.startedAt
    val time = when {
        running && started != null -> Format.durationShort(now - started)
        started != null && call.finishedAt != null -> Format.durationShort(call.finishedAt!! - started)
        else -> null
    }
    Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(WorkflowWords.callLabel(call), style = ConclaveType.body.copy(fontSize = 14.sp), color = if (running) c.fg else c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (doing != null) {
                Text(doing, style = ConclaveType.meta, color = if (call.state == WorkflowCallState.FAILED) c.fault else c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(8.dp))
        StateWordText(WorkflowWords.callWord(call), WorkflowWords.callTone(call))
        if (time != null) {
            Spacer(Modifier.width(6.dp))
            Text(time, style = ConclaveType.metaNum, color = if (running) c.signal else c.fg3, maxLines = 1)
        }
    }
}

/**
 * A subagent as it stands: what it was asked ("Find the auth code"), its
 * agent and model, and while it works what it is doing now with its time;
 * after, its answer. Open the subagent's session goes to its own session.
 */
@Composable
fun SubagentDetail(use: ToolUseBlock, result: ToolResultBlock?, child: Session?, running: Boolean, now: SubagentNow?, onLeave: () -> Unit) {
    val c = Conclave.colors
    val openSession = LocalOpenSession.current
    val clock by rememberNow(if (running) 1_000 else 60_000)
    Text(Tasks.description(use), style = ConclaveType.title, color = c.fg)
    Tasks.who(use, result, child).ifEmpty { null }?.let { Text(it, style = ConclaveType.meta, color = c.fg3) }
    if (running) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(now?.text ?: "Starting", style = ConclaveType.body, color = if (now?.waiting == true) c.warn else c.fg2, modifier = Modifier.weight(1f))
            child?.createdAt?.takeIf { it > 0 }?.let {
                Text(Format.durationShort(clock - it), style = ConclaveType.metaNum, color = c.signal)
            }
        }
    } else if (result != null) {
        if (result.isError) Text("It failed.", style = ConclaveType.body, color = c.fault)
        val text = remember(result) { result.text.trim() }
        if (text.isNotEmpty()) {
            val lines = text.lines()
            CodeBox(if (lines.size > 40) lines.take(40).joinToString("\n") + "\n…" else text)
        }
    }
    if (child != null && running && child.status != SessionStatus.WAITING_RESET) {
        PauseResume(child.status == SessionStatus.PAUSED, pause = { it.pauseSession(child.id) }, resume = { it.resumeSession(child.id) })
    }
    if (child != null && openSession != null) {
        TextButton(onClick = {
            onLeave()
            openSession(child.id)
        }) { Text("Open the subagent's session") }
    }
}

/** Pause or Resume: paused work waits, kept across hub restarts, until Resume. A failed call shows nothing; the next event tells the state. */
@Composable
private fun PauseResume(paused: Boolean, pause: suspend (dev.conclave.client.ConclaveClient) -> Unit, resume: suspend (dev.conclave.client.ConclaveClient) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val scope = rememberCoroutineScope()
    TextButton(onClick = {
        scope.launch { runCatching { hub.api { if (paused) resume(it) else pause(it) } } }
    }) { Text(if (paused) "Resume" else "Pause") }
}

// ---------------------------------------------------------------------------
// Running tasks, above the composer
// ---------------------------------------------------------------------------

/**
 * "2 running tasks" above the composer while the session's workflows or
 * subagents work; a tap opens them in a sheet. Nothing when none runs.
 */
@Composable
fun RunningTasksLine(tasks: List<RunningTask>, work: SessionWork, results: Map<String, ToolResultBlock>, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    var open by remember { mutableStateOf(false) }
    // nothing runs any more: the sheet goes with the line
    LaunchedEffect(tasks.isEmpty()) { if (tasks.isEmpty()) open = false }
    if (tasks.isEmpty()) return
    Row(
        modifier
            .padding(horizontal = 16.dp)
            .heightIn(min = 36.dp)
            .clip(RoundedCornerShape(18.dp))
            .clickable(onClickLabel = "Show the running tasks") { open = true }
            .semantics { stateDescription = Tasks.pill(tasks.size) }
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Knot(KnotState.TOOL, size = 12.dp, still = true)
        Spacer(Modifier.width(8.dp))
        Text(Tasks.pill(tasks.size), style = ConclaveType.meta, color = c.fg2)
        Spacer(Modifier.width(2.dp))
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(14.dp), tint = c.fg4)
    }
    if (open) {
        CompositionLocalProvider(LocalSessionWork provides work) {
            DetailSheet(onDismiss = { open = false }) {
                Text(Tasks.pill(tasks.size).replaceFirstChar { it.uppercaseChar() }, style = ConclaveType.title, color = c.fg)
                // by kind, workflows first; a heading per kind when there are several
                val groups = TaskKinds.grouped(tasks)
                groups.forEach { (kind, items) ->
                    if (groups.size > 1) Text(kind.group, style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium), color = c.fg3, modifier = Modifier.padding(top = 4.dp))
                    items.forEachIndexed { i, t ->
                        if (i > 0) HorizontalDivider(thickness = 1.dp, color = c.rule)
                        androidx.compose.runtime.key(t.key) {
                            when (t) {
                                is RunningTask.Flow -> FlowItem(t, results[t.use?.id], onLeave = { open = false })
                                is RunningTask.Agent -> AgentItem(t, results[t.use.id], work.progress[t.use.id], onLeave = { open = false })
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A running workflow in the sheet: its name, where it is and "3 of 6 agents running"; a tap shows its phases and agents. */
@Composable
private fun FlowItem(t: RunningTask.Flow, result: ToolResultBlock?, onLeave: () -> Unit) {
    var open by rememberSaveable(t.key) { mutableStateOf(false) }
    val name = t.use?.let { WorkflowWords.workflowName(it.input) } ?: t.run.name.ifBlank { "workflow" }
    val clock by rememberNow(1_000)
    // a workflow's agents each pick their own model: no model word
    val time = Format.durationShort(clock - (t.run.startedAt ?: t.run.createdAt))
    if (open) {
        ItemHead(TaskKind.WORKFLOW, TaskGlyph.FLOW, name, null, null, time, open = true) { open = false }
        WorkflowDetail(name, t.run, result, callLive = true, onLeave = onLeave)
        return
    }
    val where = listOfNotNull(WorkflowWords.phaseLine(t.run), WorkflowWords.agentsRunning(t.run)).joinToString(". ")
    ItemHead(TaskKind.WORKFLOW, TaskGlyph.FLOW, name, where, null, time, open = false) { open = true }
}

/** A running subagent in the sheet: what it was asked, its agent and what it is doing now; a tap shows the rest. */
@Composable
private fun AgentItem(t: RunningTask.Agent, result: ToolResultBlock?, progress: String?, onLeave: () -> Unit) {
    var open by rememberSaveable(t.key) { mutableStateOf(false) }
    val now = rememberSubagentNow(t.child, on = true, progress = progress)
    val agent = Tasks.agentOf(t.use, result, t.child)
    val handedTo = Tasks.handedTo(t.use, result, t.child)
    val kind = TaskKinds.kind(t)
    val glyph = TaskKinds.glyph(kind, agent)
    val model = Tasks.model(t.use, t.child)
    val clock by rememberNow(1_000)
    val time = t.child?.createdAt?.takeIf { it > 0 }?.let { Format.durationShort(clock - it) }
    // "explore: Find the auth code", a delegated job "Code on MadX Arch: Find names"
    val who = handedTo ?: agent
    if (open) {
        ItemHead(kind, glyph, who ?: Tasks.description(t.use), null, model, time, open = true) { open = false }
        SubagentDetail(t.use, result, t.child, running = true, now = now, onLeave = onLeave)
        return
    }
    val head = (who?.let { "$it: " } ?: "") + Tasks.description(t.use)
    ItemHead(kind, glyph, head, now?.text ?: "Starting", model, time, open = false, warn = now?.waiting == true) { open = true }
}

/**
 * An item's first lines: its kind's icon, "Workflow · deep-research" (or
 * "Subagent · explore: Find the auth code"), what it does now, then its model
 * and time at the right and its chevron; a tap opens or closes it.
 */
@Composable
private fun ItemHead(kind: TaskKind, glyph: TaskGlyph, title: String, detail: String?, model: String?, time: String?, open: Boolean, warn: Boolean = false, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(5.dp)).clickable(onClick = onClick).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(taskIcon(glyph), contentDescription = null, modifier = Modifier.size(18.dp), tint = c.fg3)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = c.fg2)) { append(kind.label) }
                    withStyle(SpanStyle(color = c.fg4)) { append(" · ") }
                    append(title)
                },
                style = ConclaveType.rowTitle,
                color = c.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (detail != null) Text(detail, style = ConclaveType.meta, color = if (warn) c.warn else c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (model != null || time != null) {
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                if (time != null) Text(time, style = ConclaveType.metaNum, color = c.signal, maxLines = 1)
                if (model != null) Text(model, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 96.dp))
            }
        }
        Spacer(Modifier.width(8.dp))
        Icon(
            Icons.AutoMirrored.Outlined.KeyboardArrowRight,
            contentDescription = if (open) "Fold" else "Show",
            modifier = Modifier.size(16.dp).graphicsLayer { rotationZ = if (open) 90f else 0f },
            tint = c.fg4,
        )
    }
}
