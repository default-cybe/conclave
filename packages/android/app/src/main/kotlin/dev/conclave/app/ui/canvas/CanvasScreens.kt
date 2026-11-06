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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.CodeDefaults
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.conversation.CodeWhereSheet
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
import dev.conclave.app.ui.workflows.LaunchDialog
import dev.conclave.client.cancelCanvasRun
import dev.conclave.client.canvasQueue
import dev.conclave.client.deleteWorkflowPreset
import dev.conclave.client.flowGraph
import dev.conclave.client.flowRun
import dev.conclave.client.flows
import dev.conclave.client.newCanvasProgram
import dev.conclave.client.logic.BlockState
import dev.conclave.client.logic.Canvas
import dev.conclave.client.logic.CanvasBlock
import dev.conclave.client.logic.CanvasFile
import dev.conclave.client.logic.CanvasGroup
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.StateTone
import dev.conclave.client.logic.WorkflowWords
import dev.conclave.client.model.CanvasQueuedRun
import dev.conclave.client.model.FlowRunStatus
import dev.conclave.client.model.FlowRunView
import dev.conclave.client.model.StartWorkflowInput
import dev.conclave.client.model.WorkflowGraph
import dev.conclave.client.model.WorkflowPreset
import dev.conclave.client.model.WorkflowRunDetail
import dev.conclave.client.model.WorkflowSummary
import dev.conclave.client.queueFlowRun
import dev.conclave.client.queueWorkflowRun
import dev.conclave.client.runFlow
import dev.conclave.client.saveWorkflowPreset
import dev.conclave.client.startWorkflow
import dev.conclave.client.stopFlow
import dev.conclave.client.stopWorkflow
import dev.conclave.client.workflow
import dev.conclave.client.workflowGraph
import dev.conclave.client.workflowPresets
import dev.conclave.client.workflowRun
import dev.conclave.client.workflowRunGraph
import dev.conclave.client.workflowRuns
import dev.conclave.client.workflows
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/** How often a live run is read again (the web polls a program at 700 ms; the phone at 2 s). */
private const val POLL_MS = 2_000L

// ---------------------------------------------------------------------------
// The files: programs by folder, then your workflows, library workflows, recent runs
// ---------------------------------------------------------------------------

class CanvasListViewModel(hub: HubRepository) : HubViewModel(hub) {
    val groups = MutableStateFlow<List<CanvasGroup>?>(null)
    val error = MutableStateFlow<String?>(null)
    val refreshing = MutableStateFlow(false)

    /** New was refused with no folder (a member's 400): Code's folder sheet asks for a device and folder. */
    val askFolder = MutableStateFlow(false)
    val creating = MutableStateFlow(false)

    init {
        load()
    }

    /**
     * Canvas's New (POST /api/canvas/programs): the owner's blank program goes to their Canvas
     * folder on the hub; a member names a device and folder of their own, then [onMade] opens it.
     */
    fun newProgram(device: String? = null, cwd: String? = null, onMade: (CanvasFile.Program) -> Unit) {
        if (creating.value) return
        creating.value = true
        viewModelScope.launch {
            try {
                val made = hub.api { it.newCanvasProgram(device, cwd) }
                askFolder.value = false
                load()
                onMade(Canvas.newFile(made))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (device == null && Canvas.asksFolder(e)) askFolder.value = true else say(errorText(e))
            } finally {
                creating.value = false
            }
        }
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
    val askFolder by vm.askFolder.collectAsStateWithLifecycle()
    val creating by vm.creating.collectAsStateWithLifecycle()
    val toasts = rememberToasts()
    MessagesEffect(vm.messages, toasts)
    var where by remember { mutableStateOf(CodeDefaults()) }
    val c = Conclave.colors
    Scaffold(
        topBar = {
            TopBar("Canvas", actions = { TextButton(onClick = { vm.newProgram(onMade = onOpen) }, enabled = !creating) { Text("New") } })
        },
        snackbarHost = { ToastHost(toasts) },
    ) { padding ->
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
                            "New makes a blank program. Add its blocks on the web, or ask the agent in a Code session for one.",
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
    if (askFolder) {
        // Code's own device and folder sheet; the hub refuses its own computer to a member in plain words
        CodeWhereSheet(
            d = where,
            onChange = { where = it },
            onDone = { vm.newProgram(where.device, where.cwd, onOpen) },
            onDismiss = { vm.askFolder.value = false },
            done = if (creating) "Creating" else "Create",
        )
    }
}

// ---------------------------------------------------------------------------
// One file, read only: its blocks in run order, lit by the last run
// ---------------------------------------------------------------------------

/** What the canvas shows. [canRun] false: a run's own canvas (read only), no Run. */
data class CanvasView(
    val title: String,
    val meta: String,
    val blocks: List<CanvasBlock>,
    val word: String,
    val tone: StateTone,
    val since: Long? = null,
    val live: Boolean = false,
    val canRun: Boolean = false,
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

    /** This file's runs waiting on the hub (GET /api/canvas/queue), oldest first. */
    val queue = MutableStateFlow<List<CanvasQueuedRun>>(emptyList())

    /** A workflow that declares args: Run and Queue run ask for them first (the library's launch form). */
    val askArgs = MutableStateFlow<WorkflowSummary?>(null)
    val presets = MutableStateFlow<List<WorkflowPreset>>(emptyList())

    private var graph = WorkflowGraph()
    private var flowRun: FlowRunView? = null
    private var detail: WorkflowRunDetail? = null
    private var runId: String? = (file as? CanvasFile.Workflow)?.runId
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
                        if (!w.argsSchema.isNullOrEmpty()) {
                            askArgs.value = w
                            presets.value = runCatching { hub.api { it.workflowPresets(file.id) } }.getOrDefault(emptyList())
                        }
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
        readQueue()
        when (file) {
            is CanvasFile.Program -> sessionId?.let { sid -> hub.api { it.flowRun(sid, file.name) }?.let { flowRun = it } }
            is CanvasFile.Workflow -> runId?.let { id -> detail = hub.api { it.workflowRun(id) } }
        }
        publish()
    }

    /**
     * The queue on the hub. When its oldest run left, the hub started it: a
     * workflow's newest run is that one (a program's run is read by name).
     */
    private suspend fun readQueue() {
        if (runOnly != null) return
        val before = queue.value
        // a hub without the queue route keeps the list as it was; the next read tries again
        queue.value = try {
            hub.api { it.canvasQueue(Canvas.queueFile(file, sessionId)) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            before
        }
        if (before.isNotEmpty() && queue.value.none { it.id == before[0].id }) latest()
    }

    private suspend fun latest() {
        if (file is CanvasFile.Workflow && runOnly == null) hub.api { it.workflow(file.id) }.lastRun?.id?.let { runId = it }
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
                    since = if (live) r.startedAt ?: r.createdAt else null,
                    live = live,
                    canRun = file.runId == null,
                )
            }
        }
        view.value = v
        if ((v.live || queue.value.isNotEmpty()) && poll?.isActive != true) {
            // collectAsStateWithLifecycle drops its subscription when the screen stops or is covered, so the poll waits then
            poll = viewModelScope.launch { Canvas.pollLive(POLL_MS, { view.value?.live == true || queue.value.isNotEmpty() }, view.subscriptionCount) { readRun() } }
        }
    }

    /** Start now; [args] from the launch form when the workflow declares any. */
    fun run(args: JsonElement? = null) {
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
                        runId = hub.api { it.startWorkflow(StartWorkflowInput(name = file.id, args = args)) }.id
                        readRun()
                    }
                }
            } finally {
                busy.value = false
            }
        }
    }

    /** Queue run while one goes on: the hub starts it when this file's run ends, with no app open. */
    fun queueRun(args: JsonElement? = null) = action("Queued") {
        val q = when (file) {
            is CanvasFile.Program -> {
                val sid = sessionId ?: return@action
                hub.api { it.queueFlowRun(sid, file.name) }
            }
            is CanvasFile.Workflow -> hub.api { it.queueWorkflowRun(file.id, args) }
        }
        readQueue()
        // the run ended meanwhile and the hub started this one at once
        if (queue.value.none { it.id == q.id }) latest()
        readRun()
    }

    fun cancelQueued(id: String) = action("Cancelled") {
        hub.api { it.cancelCanvasRun(id) }
        readRun()
    }

    fun savePreset(name: String, args: JsonElement?) = action("Preset saved") {
        val w = askArgs.value ?: return@action
        hub.api { it.saveWorkflowPreset(w.id, name, args) }
        presets.value = hub.api { it.workflowPresets(w.id) }
    }

    fun removePreset(p: WorkflowPreset) = action {
        val w = askArgs.value ?: return@action
        hub.api { it.deleteWorkflowPreset(w.id, p.id) }
        presets.value = hub.api { it.workflowPresets(w.id) }
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

/** The read-only canvas: Run (Stop and Queue while live) and Open on web on top; the status, the queued runs, then the blocks under their phases. */
@Composable
fun CanvasScreen(file: CanvasFile, onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: CanvasViewModel = viewModel(key = "canvas:${Canvas.webPath(file)}") { CanvasViewModel(hub, file) }
    val view by vm.view.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val queue by vm.queue.collectAsStateWithLifecycle()
    val askArgs by vm.askArgs.collectAsStateWithLifecycle()
    val presets by vm.presets.collectAsStateWithLifecycle()
    // the launch form is open: for Queue run (true) or Run (false)
    var argsFor by remember { mutableStateOf<Boolean?>(null) }
    fun go(queued: Boolean) {
        when {
            askArgs != null -> argsFor = queued
            queued -> vm.queueRun()
            else -> vm.run()
        }
    }
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
                    if (v != null && v.live) {
                        TextButton(onClick = { vm.stop() }) { Text("Stop", color = c.fault) }
                        if (v.canRun) TextButton(onClick = { go(true) }) { Text("Queue") }
                    } else if (v != null && v.canRun) {
                        TextButton(onClick = { go(false) }, enabled = !busy) { Text("Run") }
                    }
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
                                v.graphError?.let { Text(it, style = CodeStyle, color = c.fault) }
                            }
                        }
                        if (queue.isNotEmpty()) {
                            item(key = "q:head") { SectionHeader("Queued") }
                            items(queue, key = { "q:${it.id}" }) { q -> QueuedRow(q, now) { vm.cancelQueued(q.id) } }
                        }
                        if (v.blocks.isEmpty()) {
                            item(key = "empty") {
                                val base = hub.currentUrl
                                val openWeb: (@Composable () -> Unit)? = if (base == null) {
                                    null
                                } else {
                                    {
                                        TextButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(base.trimEnd('/') + Canvas.webPath(file)))) } }) {
                                            Text("Open on web to edit")
                                        }
                                    }
                                }
                                EmptyState(
                                    Icons.Outlined.AccountTree,
                                    "No blocks",
                                    "This file has no statements the canvas can show yet. Blocks are added on the web.",
                                    action = openWeb,
                                )
                            }
                        }
                        for (section in Canvas.sections(v.blocks)) {
                            section.phase?.let { p -> item(key = "p:$p:${section.blocks.first().id}") { SectionHeader(p) } }
                            // a program's block ids are its variable names: a block called status or empty must not reuse those keys
                            items(section.blocks, key = { "b:${it.id}" }) { b -> BlockCard(b, now) }
                        }
                    }
                }
            }
        }
    }
    val w = askArgs
    val queued = argsFor
    if (w != null && queued != null) {
        LaunchDialog(
            workflow = w,
            presets = presets,
            starting = busy,
            onDismiss = { argsFor = null },
            onSavePreset = { name, args -> vm.savePreset(name, args) },
            onRemovePreset = { p -> vm.removePreset(p) },
            onStart = { args ->
                argsFor = null
                if (queued) vm.queueRun(args) else vm.run(args)
            },
            confirm = if (queued) "Queue" else "Start",
        )
    }
}

/** A queued run: how long it waits, its args when it has any, and Cancel. */
@Composable
private fun QueuedRow(q: CanvasQueuedRun, now: Long, onCancel: () -> Unit) {
    val c = Conclave.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Waiting ${Format.elapsed(now - q.createdAt)}", style = ConclaveType.rowTitle, color = c.fg)
            Canvas.shortValue(q.args?.toString())?.let { Text(it, style = CodeStyle, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        TextButton(onClick = onCancel) { Text("Cancel") }
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
