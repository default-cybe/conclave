@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.workflows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.common.CodeBox
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MarkdownText
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.StateWordText
import dev.conclave.app.ui.common.clockTime
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.Knot
import dev.conclave.app.ui.motion.RollText
import dev.conclave.app.ui.motion.Step
import dev.conclave.app.ui.motion.Steps
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.ModelRefs
import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.StateTone
import dev.conclave.client.logic.WorkflowWords
import dev.conclave.client.model.Message
import dev.conclave.client.model.WorkflowCall
import dev.conclave.client.model.WorkflowCallState
import dev.conclave.client.model.WorkflowRunStatus
import kotlinx.coroutines.CancellationException

/**
 * One workflow run (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.18 and 5):
 * the sentence on top with the Knot while it works and the current step in
 * Steps under it, the phases in order with one row per call (label, state
 * word, tokens), the result, findings and the narrator log. Pause, Resume
 * and Stop sit in the top bar; Skip and Rerun from here in a row's menu. A
 * row opens the agent's transcript, read only.
 */
@Composable
fun WorkflowRunScreen(runId: String, onBack: () -> Unit, onOpenSession: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: RunViewModel = viewModel(key = "run:$runId") { RunViewModel(hub, runId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    var stopping by remember { mutableStateOf(false) }
    var openCall by remember { mutableStateOf<WorkflowCall?>(null) }
    val run = state?.detail?.run
    val live = run != null && WorkflowWords.isLive(run.status)

    Scaffold(
        topBar = {
            TopBar(
                run?.name?.ifBlank { null } ?: "Run",
                onBack = onBack,
                newChat = false,
                actions = {
                    if (run != null) {
                        when (run.status) {
                            WorkflowRunStatus.RUNNING -> TextButton(onClick = { vm.pause() }) { Text("Pause") }
                            WorkflowRunStatus.PAUSED, WorkflowRunStatus.INTERRUPTED, WorkflowRunStatus.WAITING_RESET -> TextButton(onClick = { vm.resume() }) { Text("Resume") }
                            else -> Unit
                        }
                        if (live) TextButton(onClick = { stopping = true }) { Text("Stop", color = Conclave.colors.fault) }
                    }
                },
            )
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OfflineBanner(connection)
            val s = state
            when {
                s == null && error != null -> ErrorBanner(error.orEmpty(), onRetry = { vm.load() })
                s == null -> LoadingBox()
                else -> {
                    val detail = s.detail
                    val r = detail.run
                    val groups = WorkflowWords.byPhase(r, detail.calls)
                    val activity = WorkflowWords.activity(detail, s.activity)
                    val result = remember(detail.result) { WorkflowWords.result(detail.result) }
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                        item(key = "status") {
                            StatusBlock(
                                detail = detail,
                                activityLabel = activity?.let { a -> detail.calls.firstOrNull { it.seq == a.seq }?.let(WorkflowWords::callLabel) ?: "Call ${a.seq}" },
                                activityText = activity?.text,
                                deviceName = devices.firstOrNull { it.id == r.device }?.name?.ifBlank { null } ?: if (r.device == "local") "the hub" else r.device,
                                onOpenSession = onOpenSession,
                            )
                        }
                        groups.forEachIndexed { i, g ->
                            item(key = "phase:$i:${g.title}") {
                                val current = i == r.phaseIndex && WorkflowWords.isLive(r.status)
                                Column {
                                    SectionHeader(g.title, trailing = { Text(WorkflowWords.phaseProgress(g, i, r), style = ConclaveType.metaNum, color = if (current) Conclave.colors.signal else Conclave.colors.fg3) })
                                    g.detail?.ifBlank { null }?.let { Text(it, style = ConclaveType.meta, color = Conclave.colors.fg3, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
                                }
                            }
                            items(WorkflowWords.rows(g.calls), key = { "call:${it.call.seq}" }) { row ->
                                CallRowItem(
                                    call = row.call,
                                    depth = row.depth,
                                    lastTool = s.progress[row.call.seq] ?: row.call.lastTool,
                                    canSkip = WorkflowWords.canSkip(r, row.call),
                                    canRerun = WorkflowWords.canRerun(r),
                                    onOpen = { openCall = row.call },
                                    onSkip = { vm.skip(row.call) },
                                    onRerun = { vm.rerun(row.call) },
                                )
                            }
                        }
                        if (result.report != null || result.json != null) {
                            item(key = "result") {
                                Column {
                                    SectionHeader("Result")
                                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        result.report?.let { MarkdownText(it) }
                                        result.json?.let { json ->
                                            var all by remember { mutableStateOf(result.report == null) }
                                            if (all) {
                                                CodeBox(json, maxLines = 80)
                                            } else {
                                                TextButton(onClick = { all = true }) { Text("The whole result") }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (detail.findings.isNotEmpty()) {
                            item(key = "findings") {
                                SectionHeader("Findings", trailing = {
                                    val rate = detail.refutedRate
                                    if (rate != null) Text("${Format.percent(rate)} refuted", style = ConclaveType.metaNum, color = Conclave.colors.fg3)
                                })
                            }
                            items(detail.findings, key = { "f:${it.id}" }) { f ->
                                val c = Conclave.colors
                                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(listOfNotNull(f.priority, f.title).joinToString("  "), style = ConclaveType.body, color = c.fg)
                                        val where = f.file?.let { file -> f.line?.let { "$file:$it" } ?: file }
                                        if (where != null) Text(where, style = CodeStyle, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                    Spacer(Modifier.width(8.dp))
                                    val verdict = f.verdict?.wire
                                    StateWordText(verdict ?: if (f.proven) "proven" else "confirmed", if (verdict != null) StateTone.DIM else if (f.proven) StateTone.OK else StateTone.NEUTRAL)
                                }
                            }
                        }
                        if (detail.logs.isNotEmpty()) {
                            item(key = "log") { SectionHeader("Log", trailing = { Text(detail.logs.size.toString(), style = ConclaveType.metaNum, color = Conclave.colors.fg3) }) }
                            items(detail.logs, key = { "log:${it.n}" }) { l ->
                                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp)) {
                                    Text(clockTime(l.ts), style = ConclaveType.metaNum, color = Conclave.colors.fg3, modifier = Modifier.width(64.dp))
                                    Text(l.text, style = ConclaveType.meta, color = Conclave.colors.fg2, modifier = Modifier.weight(1f))
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (stopping && run != null) {
        ConfirmDialog(
            title = "Stop ${run.name}?",
            text = "Running agents are stopped and the script ends. Finished calls stay in the journal, so Resume replays them.",
            confirmLabel = "Stop",
            destructive = true,
            onConfirm = {
                stopping = false
                vm.stop()
            },
            onDismiss = { stopping = false },
        )
    }

    openCall?.let { call ->
        // follow the call's latest state while its sheet is open
        val latest = state?.detail?.calls?.firstOrNull { it.seq == call.seq } ?: call
        TranscriptSheet(latest, vm, onDismiss = { openCall = null })
    }
}

@Composable
private fun StatusBlock(
    detail: dev.conclave.client.model.WorkflowRunDetail,
    activityLabel: String?,
    activityText: String?,
    deviceName: String,
    onOpenSession: (String) -> Unit,
) {
    val c = Conclave.colors
    val run = detail.run
    val live = WorkflowWords.isLive(run.status)
    val parts = WorkflowWords.statusParts(run, detail.calls)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.padding(top = 3.dp).size(16.dp), contentAlignment = Alignment.Center) {
                Knot(WorkflowWords.knot(run), size = 16.dp, still = !live, label = if (live) "Working" else null)
            }
            Spacer(Modifier.width(10.dp))
            Column {
                Text("${parts.head}. ${parts.agents}.", style = ConclaveType.title, color = c.fg)
                RollText(parts.spend, ConclaveType.metaNum, c.fg2)
            }
        }
        if (live && activityText != null) {
            Steps(Step(verb = activityLabel ?: "Working", target = activityText), modifier = Modifier.padding(start = 26.dp))
        }
        val meta = listOfNotNull(
            run.description?.trimEnd('.')?.ifBlank { null },
            // the project by its folder's name, as the session headers say it
            "On $deviceName, in ${Paths.folderName(run.cwd).ifEmpty { "the home folder" }}",
            if (run.sessionId == null) "Started from the app" else null,
            if (!run.portable) "Uses the Conclave layer" else null,
        ).joinToString(". ") + "."
        Text(meta, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(start = 26.dp))
        run.sessionId?.let { sid ->
            TextButton(onClick = { onOpenSession(sid) }, modifier = Modifier.padding(start = 14.dp)) { Text("Open the session") }
        }
        val budget = run.budget?.tokens
        if (budget != null && budget > 0) {
            val used = run.outputTokens.toFloat() / budget
            val tone = when {
                used >= 0.9f -> c.fault
                used >= 0.7f -> c.warn
                else -> c.fg2
            }
            Column(Modifier.padding(start = 26.dp)) {
                Box(Modifier.fillMaxWidth().height(4.dp).background(c.meterOff, RoundedCornerShape(2.dp))) {
                    Box(Modifier.fillMaxWidth(used.coerceIn(0f, 1f)).height(4.dp).background(tone, RoundedCornerShape(2.dp)))
                }
                Text("Budget, ${Format.tokens(run.outputTokens)} of ${Format.tokens(budget)} output tokens", style = ConclaveType.metaNum, color = c.fg3, modifier = Modifier.padding(top = 4.dp))
            }
        }
        val err = run.error
        if (err != null && run.status != WorkflowRunStatus.STOPPED) {
            Text(err, style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(start = 26.dp))
        }
        val at = run.resumeAt
        if (run.status == WorkflowRunStatus.WAITING_RESET && at != null && at > 0) {
            Text("The parked calls run again at ${clockTime(at)}.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(start = 26.dp))
        }
    }
}

@Composable
private fun CallRowItem(
    call: WorkflowCall,
    depth: Int,
    lastTool: String?,
    canSkip: Boolean,
    canRerun: Boolean,
    onOpen: () -> Unit,
    onSkip: () -> Unit,
    onRerun: () -> Unit,
) {
    val c = Conclave.colors
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(onClick = onOpen).padding(start = 16.dp + (depth * 16).dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(WorkflowWords.callLabel(call), style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val meta = WorkflowWords.callMeta(call, lastTool)
            if (meta.isNotEmpty()) {
                Text(
                    meta,
                    style = ConclaveType.meta,
                    color = if (call.state == WorkflowCallState.FAILED && !WorkflowWords.stoppedByRun(call)) c.fault else c.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.width(8.dp))
        StateWordText(WorkflowWords.callWord(call), WorkflowWords.callTone(call))
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "Actions for ${WorkflowWords.callLabel(call)}") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(if (call.childSessionId != null) "Open transcript" else "Open details") }, onClick = { menu = false; onOpen() })
                if (canSkip) DropdownMenuItem(text = { Text("Skip, it returns null") }, onClick = { menu = false; onSkip() })
                if (canRerun) DropdownMenuItem(text = { Text("Rerun from here") }, onClick = { menu = false; onRerun() })
            }
        }
    }
}

/** The agent's session, read only: the prompt on top, its steps, the result at the bottom. */
@Composable
private fun TranscriptSheet(call: WorkflowCall, vm: RunViewModel, onDismiss: () -> Unit) {
    val c = Conclave.colors
    var messages by remember(call.childSessionId) { mutableStateOf<List<Message>?>(null) }
    LaunchedEffect(call.childSessionId, call.state) {
        val id = call.childSessionId ?: return@LaunchedEffect
        messages = try {
            vm.transcript(id)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.bgRaise) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(WorkflowWords.callLabel(call), style = ConclaveType.title, color = c.fg)
            val sub = listOfNotNull(
                call.agentType,
                call.model?.let { ModelRefs.displayName(it) }?.ifBlank { null },
                "${Format.tokens(call.tokens)} tokens",
                Format.usd(call.costUsd),
            ).joinToString(", ")
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(sub, style = ConclaveType.metaNum, color = c.fg3, modifier = Modifier.weight(1f))
                StateWordText(WorkflowWords.callWord(call), WorkflowWords.callTone(call))
            }
            Text("Prompt", style = ConclaveType.section, color = c.fg)
            val prompt = WorkflowWords.transcriptPrompt(messages, call)
            Text(
                prompt.ifBlank { "No prompt recorded." },
                style = ConclaveType.meta,
                color = c.fg2,
                maxLines = 14,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().background(c.bgSunk, RoundedCornerShape(5.dp)).padding(10.dp),
            )
            when {
                call.childSessionId == null -> Text("This call ran on the hub (a check or a question), so it has no transcript.", style = ConclaveType.meta, color = c.fg3)
                messages == null -> Text("Reading the transcript", style = ConclaveType.meta, color = c.fg3)
                else -> {
                    val steps = WorkflowWords.transcriptSteps(messages.orEmpty())
                    if (steps.isNotEmpty()) {
                        Text("Steps", style = ConclaveType.section, color = c.fg)
                        steps.forEach { st ->
                            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                                if (st.text.isNotBlank()) Text(st.text, style = ConclaveType.body, color = c.fg)
                                st.tools.forEach { t -> Text(t, style = CodeStyle, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            }
                        }
                    }
                }
            }
            Text("Result", style = ConclaveType.section, color = c.fg)
            val err = call.error
            when {
                call.state == WorkflowCallState.FAILED && err != null -> Text(err, style = ConclaveType.meta, color = if (WorkflowWords.stoppedByRun(call)) c.fg3 else c.fault)
                !call.resultPreview.isNullOrBlank() -> CodeBox(call.resultPreview.orEmpty(), maxLines = 30)
                else -> Text(if (call.state == WorkflowCallState.RUNNING || call.state == WorkflowCallState.QUEUED) "Still working." else "No result.", style = ConclaveType.meta, color = c.fg3)
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}
