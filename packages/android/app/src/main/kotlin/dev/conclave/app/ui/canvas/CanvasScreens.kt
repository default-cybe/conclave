@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.canvas

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.EmptyState
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.StateWordText
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.toneColor
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.flowGraph
import dev.conclave.client.flowRun
import dev.conclave.client.flows
import dev.conclave.client.logic.BlockState
import dev.conclave.client.logic.Canvas
import dev.conclave.client.logic.CanvasBlock
import dev.conclave.client.logic.CanvasFile
import dev.conclave.client.logic.CanvasGroup
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.StateTone
import dev.conclave.client.logic.WorkflowWords
import dev.conclave.client.model.FlowRunStatus
import dev.conclave.client.model.FlowRunView
import dev.conclave.client.model.StartWorkflowInput
import dev.conclave.client.model.WorkflowGraph
import dev.conclave.client.model.WorkflowRunDetail
import dev.conclave.client.runFlow
import dev.conclave.client.startWorkflow
import dev.conclave.client.stopFlow
import dev.conclave.client.stopWorkflow
import dev.conclave.client.workflow
import dev.conclave.client.workflowGraph
import dev.conclave.client.workflowRun
import dev.conclave.client.workflowRunGraph
import dev.conclave.client.workflowRuns
import dev.conclave.client.workflows
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** How often a live run is read again (the web polls a program at 700 ms; the phone at 2 s). */
private const val POLL_MS = 2_000L

// ---------------------------------------------------------------------------
// The files: programs by folder, then your workflows, library workflows, recent runs
// ---------------------------------------------------------------------------

class CanvasListViewModel(hub: HubRepository) : HubViewModel(hub) {
    val groups = MutableStateFlow<List<CanvasGroup>?>(null)
    val error = MutableStateFlow<String?>(null)
    val refreshing = MutableStateFlow(false)

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                val folders = Canvas.folderSessions(hub.sessions.value)
                // a folder on a device that is offline answers an error: it lists nothing, the rest still do
                val programs = folders.map { s ->
                    async { runCatching { hub.api { it.flows(s.id) } }.getOrDefault(emptyList()).map { CanvasFile.Program(it.name, s.device, s.cwd, s.id) } }
                }
                // caught inside, so a failed list is this screen's error and does not cancel the scope
                val library = async { runCatching { hub.api { it.workflows() } } }
                val runs = async { runCatching { hub.api { it.workflowRuns(limit = 8) } }.getOrDefault(emptyList()) }
                val files = programs.awaitAll().flatten() + Canvas.workflowFiles(library.await().getOrThrow(), runs.await())
                val devices = hub.devices.value.associateBy { it.id }
                groups.value = Canvas.groups(files) { f -> "${Paths.folderName(f.cwd).ifBlank { f.cwd }}, ${devices[f.device]?.name?.ifBlank { null } ?: f.device}" }
                error.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = errorText(e)
            } finally {
                refreshing.value = false
            }
        }
    }
}

/** Canvas's start: every file, grouped as the web's sidebar. A row opens its canvas. */
@Composable
fun CanvasListScreen(onOpen: (CanvasFile) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: CanvasListViewModel = viewModel(key = "canvas-list") { CanvasListViewModel(hub) }
    val groups by vm.groups.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val c = Conclave.colors
    Scaffold(topBar = { TopBar("Canvas") }) { padding ->
        PullToRefreshBox(isRefreshing = refreshing && groups != null, onRefresh = { vm.load() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            val list = groups
            when {
                list == null && error != null -> Column { ErrorBanner(error.orEmpty(), onRetry = { vm.load() }) }
                list == null -> LoadingBox()
                list.isEmpty() -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        EmptyState(
                            Icons.Outlined.AccountTree,
                            "No programs or workflows yet",
                            "A program is flows/<name>.flow.ts in a Code session's folder; ask the agent there for one.",
                        )
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    for (g in list) {
                        item(key = "h:${g.label}") { SectionHeader(g.label) }
                        items(g.files, key = { f -> "${g.label}:${Canvas.webPath(f)}" }) { f ->
                            Row(
                                Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { onOpen(f) }.padding(horizontal = 16.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    f.title,
                                    modifier = Modifier.weight(1f),
                                    style = if (f is CanvasFile.Program) CodeStyle else ConclaveType.rowTitle,
                                    color = c.fg,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                if (f is CanvasFile.Workflow && f.live) StateWordText("running", StateTone.SIGNAL)
                                else if (f is CanvasFile.Workflow && f.failed) StateWordText("failed", StateTone.FAULT)
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// One file, read only: its blocks in run order, lit by the last run
// ---------------------------------------------------------------------------

/** What the canvas shows. [canRun] false with [runHint] says why Run is off. */
data class CanvasView(
    val title: String,
    val meta: String,
    val blocks: List<CanvasBlock>,
    val word: String,
    val tone: StateTone,
    val since: Long? = null,
    val live: Boolean = false,
    val canRun: Boolean = false,
    val runHint: String? = null,
    val graphError: String? = null,
)

/**
 * One file: a program (read through the newest Code session in its folder),
 * a workflow with its latest run, or one run of a workflow (a wfr_ id). While
 * a run goes on it is read again every [POLL_MS].
 */
class CanvasViewModel(hub: HubRepository, private val file: CanvasFile) : HubViewModel(hub) {
    val view = MutableStateFlow<CanvasView?>(null)
    val error = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)

    private var graph = WorkflowGraph()
    private var flowRun: FlowRunView? = null
    private var detail: WorkflowRunDetail? = null
    private var runId: String? = (file as? CanvasFile.Workflow)?.runId
    private var declaresArgs = false
    private var sessionId: String? = null
    private var poll: Job? = null

    /** A wfr_ file: that run's own graph, read only. */
    private val runOnly: String? = (file as? CanvasFile.Workflow)?.runId

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            try {
                when (file) {
                    is CanvasFile.Program -> {
                        val sid = Canvas.sessionFor(hub.sessions.value, file.device, file.cwd)?.id ?: file.sessionId.ifBlank { null }
                            ?: throw IllegalStateException("No Code session works in ${file.cwd} on ${file.device}, so the hub cannot read its flows. Start one there, then open the file again.")
                        sessionId = sid
                        val v = hub.api { it.flowGraph(sid, file.name) }
                        graph = v.graph
                        if (!Canvas.flowLive(flowRun)) flowRun = v.lastRun
                    }
                    is CanvasFile.Workflow -> if (runOnly != null) {
                        graph = hub.api { it.workflowRunGraph(runOnly) }.graph
                    } else {
                        graph = hub.api { it.workflowGraph(file.id) }.graph
                        val w = hub.api { it.workflow(file.id) }
                        declaresArgs = !w.argsSchema.isNullOrEmpty()
                        if (runId == null) runId = w.lastRun?.id
                    }
                }
                readRun()
                error.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (view.value == null) error.value = errorText(e) else say(errorText(e))
            }
        }
    }

    private suspend fun readRun() {
        when (file) {
            is CanvasFile.Program -> sessionId?.let { sid -> hub.api { it.flowRun(sid, file.name) }?.let { flowRun = it } }
            is CanvasFile.Workflow -> runId?.let { id -> detail = hub.api { it.workflowRun(id) } }
        }
        publish()
    }

    private fun publish() {
        val v = when (file) {
            is CanvasFile.Program -> {
                val r = flowRun
                CanvasView(
                    title = file.title,
                    meta = listOf("Program", Paths.shortPath(file.cwd), file.device).filter { it.isNotBlank() }.joinToString(", "),
                    blocks = Canvas.programBlocks(graph, r),
                    word = r?.let { programWord(it.status) } ?: "not run yet",
                    tone = r?.let { programTone(it.status) } ?: StateTone.DIM,
                    since = r?.startedAt?.takeIf { r.status == FlowRunStatus.RUNNING },
                    live = Canvas.flowLive(r),
                    canRun = true,
                    graphError = graph.error,
                )
            }
            is CanvasFile.Workflow -> {
                val r = detail?.run
                val live = r != null && WorkflowWords.isLive(r.status)
                CanvasView(
                    title = graph.name.ifBlank { file.name },
                    meta = if (file.runId != null) "Run of ${file.name}, read only" else "Workflow, ${if (file.group == CanvasFile.Group.LIBRARY) "library" else "yours"}",
                    blocks = Canvas.workflowBlocks(graph, detail?.calls, r?.error),
                    word = r?.let { WorkflowWords.runWord(it.status) + (it.phaseTitle?.takeIf { live }?.let { p -> ", in $p" } ?: "") } ?: "not run yet",
                    tone = r?.let { WorkflowWords.runTone(it.status) } ?: StateTone.DIM,
                    since = if (live) r?.startedAt ?: r?.createdAt else null,
                    live = live,
                    canRun = file.runId == null && !declaresArgs,
                    runHint = if (file.runId == null && declaresArgs) "This workflow takes args: run it from Open on web." else null,
                )
            }
        }
        view.value = v
        if (v.live && poll?.isActive != true) {
            poll = viewModelScope.launch {
                while (view.value?.live == true) {
                    delay(POLL_MS)
                    runCatching { readRun() }.onFailure { if (it is CancellationException) throw it }
                }
            }
        }
    }

    fun run() {
        if (busy.value) return
        busy.value = true
        action {
            try {
                when (file) {
                    is CanvasFile.Program -> {
                        val sid = sessionId ?: return@action
                        flowRun = hub.api { it.runFlow(sid, file.name) }
                        publish()
                    }
                    is CanvasFile.Workflow -> {
                        runId = hub.api { it.startWorkflow(StartWorkflowInput(name = file.id)) }.id
                        readRun()
                    }
                }
            } finally {
                busy.value = false
            }
        }
    }

    fun stop() = action("Stopped") {
        when (file) {
            is CanvasFile.Program -> sessionId?.let { sid -> hub.api { it.stopFlow(sid, file.name) }?.let { flowRun = it } }
            is CanvasFile.Workflow -> runId?.let { id -> hub.api { it.stopWorkflow(id) } }
        }
        readRun()
    }

    private fun programWord(s: FlowRunStatus) = if (s == FlowRunStatus.APPROVAL) "waiting for approval" else s.wire

    private fun programTone(s: FlowRunStatus) = when (s) {
        FlowRunStatus.RUNNING -> StateTone.SIGNAL
        FlowRunStatus.APPROVAL -> StateTone.WARN
        FlowRunStatus.DONE -> StateTone.OK
        FlowRunStatus.FAILED, FlowRunStatus.REFUSED -> StateTone.FAULT
        FlowRunStatus.STOPPED -> StateTone.DIM
    }
}

/** The read-only canvas: Run, Stop and Open on web on top; the status, then the blocks under their phases. */
@Composable
fun CanvasScreen(file: CanvasFile, onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: CanvasViewModel = viewModel(key = "canvas:${Canvas.webPath(file)}") { CanvasViewModel(hub, file) }
    val view by vm.view.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val toasts = rememberToasts()
    MessagesEffect(vm.messages, toasts)
    val context = LocalContext.current
    val c = Conclave.colors
    val v = view
    Scaffold(
        topBar = {
            TopBar(
                v?.title ?: file.title,
                onBack = onBack,
                newChat = false,
                actions = {
                    if (v != null && v.live) TextButton(onClick = { vm.stop() }) { Text("Stop", color = c.fault) }
                    else if (v != null && v.canRun) TextButton(onClick = { vm.run() }, enabled = !busy) { Text("Run") }
                    val base = hub.currentUrl
                    if (base != null) {
                        IconButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(base.trimEnd('/') + Canvas.webPath(file)))) } }) {
                            Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Open on web")
                        }
                    }
                },
            )
        },
        snackbarHost = { ToastHost(toasts) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OfflineBanner(connection)
            when {
                v == null && error != null -> ErrorBanner(error.orEmpty(), onRetry = { vm.load() })
                v == null -> LoadingBox()
                else -> {
                    val now by rememberNow(if (v.live) 1_000 else 60_000)
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                        item(key = "status") {
                            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(v.meta, style = ConclaveType.meta, color = c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    StateWordText(v.word, v.tone, style = ConclaveType.rowTitle)
                                    v.since?.let {
                                        Spacer(Modifier.width(8.dp))
                                        Text(Format.elapsed(now - it), style = ConclaveType.metaNum, color = c.fg3)
                                    }
                                }
                                v.runHint?.let { Text(it, style = ConclaveType.meta, color = c.fg3) }
                                v.graphError?.let { Text(it, style = CodeStyle, color = c.fault) }
                            }
                        }
                        if (v.blocks.isEmpty()) {
                            item(key = "empty") { EmptyState(Icons.Outlined.AccountTree, "No blocks", "This file has no statements the canvas can show yet.") }
                        }
                        for (section in Canvas.sections(v.blocks)) {
                            section.phase?.let { p -> item(key = "p:$p:${section.blocks.first().id}") { SectionHeader(p) } }
                            items(section.blocks, key = { it.id }) { b -> BlockCard(b, now) }
                        }
                    }
                }
            }
        }
    }
}

/** One block: title and state word on top, its kind, then the short value when done or the whole error when failed. */
@Composable
private fun BlockCard(b: CanvasBlock, now: Long) {
    val c = Conclave.colors
    val failed = b.state == BlockState.FAILED
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .border(1.dp, if (failed) c.fault else if (b.state == BlockState.RUNNING) c.signal else c.rule, RoundedCornerShape(8.dp))
            .background(c.bgRaise, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(b.title, Modifier.weight(1f), style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (b.state != BlockState.IDLE) {
                Spacer(Modifier.width(8.dp))
                val elapsed = b.startedAt?.let { " ${Format.elapsed(now - it)}" }.orEmpty()
                Text(b.state.word + elapsed, style = ConclaveType.metaNum, color = toneColor(b.state.tone), maxLines = 1)
            }
        }
        Text(b.kind, style = ConclaveType.micro, color = c.fg3, maxLines = 1)
        b.value?.let { Text(it, style = ConclaveType.meta, color = c.fg2, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        b.error?.let { Text(it, style = CodeStyle, color = c.fault) }
    }
}
