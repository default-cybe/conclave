@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package dev.conclave.app.ui.memory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TriStateCheckbox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.StateWordText
import dev.conclave.app.ui.common.clockTime
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.KnotRopeLine
import dev.conclave.app.ui.motion.LiveState
import dev.conclave.app.ui.motion.LiveStatus
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.ImportWords
import dev.conclave.client.logic.PickState
import dev.conclave.client.model.ExternalSessionInfo
import dev.conclave.client.model.ImportBatch
import dev.conclave.client.model.ImportBatchStatus
import dev.conclave.client.model.ImportMode
import dev.conclave.client.model.ImportProjectGroup
import dev.conclave.client.motion.RopeMoment
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.delay

private val DAY = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)

/** Chats listed under an open project; the rest are counted. */
private const val SHOWN_ROWS = 300

private fun shortDate(ts: Long): String = if (ts <= 0) "" else Instant.ofEpochMilli(ts).atZone(ZoneId.systemDefault()).format(DAY)

private fun dateRange(a: Long, b: Long): String {
    val x = shortDate(a)
    val y = shortDate(b)
    return if (x == y) x else "$x to $y"
}

/**
 * Memory, Import past chats: pick a computer, tick projects or single chats,
 * choose what to do with them (Chats only, Chats and learn memory, Learn
 * memory only), read the cost line, Start. Recent imports below show their
 * progress with Pause, Resume, Cancel and Undo.
 */
@Composable
fun ImportScreen(onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: ImportViewModel = viewModel { ImportViewModel(hub) }
    val devices by hub.devices.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val picked by vm.device.collectAsStateWithLifecycle()
    val source by vm.source.collectAsStateWithLifecycle()
    val since by vm.since.collectAsStateWithLifecycle()
    val hideImported by vm.hideImported.collectAsStateWithLifecycle()
    val showSkipped by vm.showSkipped.collectAsStateWithLifecycle()
    val page by vm.page.collectAsStateWithLifecycle()
    val scanning by vm.scanning.collectAsStateWithLifecycle()
    val scanError by vm.scanError.collectAsStateWithLifecycle()
    val rows by vm.rows.collectAsStateWithLifecycle()
    val open by vm.open.collectAsStateWithLifecycle()
    val pick by vm.pick.collectAsStateWithLifecycle()
    val mode by vm.mode.collectAsStateWithLifecycle()
    val memoryOn by vm.memoryOn.collectAsStateWithLifecycle()
    val estimate by vm.estimate.collectAsStateWithLifecycle()
    val starting by vm.starting.collectAsStateWithLifecycle()
    val fixing by vm.fixing.collectAsStateWithLifecycle()
    val batches by vm.batches.collectAsStateWithLifecycle()
    val notLearned by vm.notLearned.collectAsStateWithLifecycle()
    val acting by vm.acting.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    var undoing by remember { mutableStateOf<ImportBatch?>(null) }
    val c = Conclave.colors

    val scanDevices = ImportWords.scanDevices(devices)
    val dev = picked ?: ImportWords.defaultDevice(scanDevices)
    val names = devices.associate { it.id to (it.name.ifBlank { if (it.id == "local") "the hub" else it.id }) }
    LaunchedEffect(dev, source, since, hideImported, showSkipped) { vm.scan(dev) }

    val p = page
    val groups = p?.groups.orEmpty()
    val total = groups.sumOf { it.sessions }
    val sources = groups.flatMap { it.sources }.distinct()
    // until the estimate answers: the ticked chats, or the whole list minus the ones left out
    val chosen = estimate?.sessions ?: vm.request(dev)?.keys?.size ?: if (pick.all) (total - pick.exclude.size).coerceAtLeast(0) else 0

    Scaffold(
        topBar = {
            TopBar("Import past chats", onBack = onBack)
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
            item(key = "head") {
                Column(Modifier.fillMaxWidth()) {
                    OfflineBanner(connection)
                    Text(
                        "Past Claude Code, Codex and Gemini CLI chats on a computer. Import them as sessions, learn memory from them, or both. Every chat comes in once; a chat that grew gets its new messages. Exports from claude.ai and ChatGPT go up on the web.",
                        style = ConclaveType.body,
                        color = c.fg2,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                    DevicePick(dev, scanDevices.map { it.id }.ifEmpty { listOf("local") }, names, devices.associate { it.id to it.online }) { vm.device.value = it }
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) {
                            when {
                                scanning -> LiveStatus(LiveState.TOOL, label = "Reading the chats")
                                p != null && p.offline == true -> Text("Offline, last read ${p.scannedAt?.let { Format.relative(it) } ?: "never"}", style = ConclaveType.meta, color = c.fg3)
                                p != null && p.scannedAt != null -> Text("Read ${Format.relative(p.scannedAt ?: 0)}", style = ConclaveType.meta, color = c.fg3)
                            }
                        }
                        if (!scanning) TextButton(onClick = { vm.scan(dev, refresh = true) }) { Text("Read again") }
                    }
                    p?.retention.orEmpty().filter { it.risk == "high" }.forEach { r ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(r.text, style = ConclaveType.meta, color = c.warn, modifier = Modifier.weight(1f))
                            if (r.fixable) TextButton(onClick = { vm.fix(r) }, enabled = fixing == null) { Text(if (fixing == r.tool) "Saving" else "Keep 10 years") }
                        }
                    }
                    scanError?.let { ErrorBanner("Failed. $it", onRetry = { vm.scan(dev, refresh = true) }) }
                    p?.failed.orEmpty().forEach { f ->
                        Text("${ImportWords.sourceName(f.source)} chats could not be read. ${f.error}", style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                    }
                }
            }

            if (p != null) {
                item(key = "filters") {
                    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (sources.size > 1 || source != null) {
                                FilterChip(selected = source == null, onClick = { vm.source.value = null }, label = { Text("All") })
                                (sources + listOfNotNull(source)).distinct().forEach { s ->
                                    FilterChip(selected = source == s, onClick = { vm.source.value = s }, label = { Text(ImportWords.sourceName(s)) })
                                }
                            }
                            SincePick(since) { vm.since.value = it }
                            FilterChip(selected = hideImported, onClick = { vm.hideImported.value = !hideImported }, label = { Text("Hide imported") })
                            FilterChip(selected = showSkipped, onClick = { vm.showSkipped.value = !showSkipped }, label = { Text("Show skipped") })
                        }
                        val counts = p.counts
                        val summary = if (total == 0) {
                            "No past chats here with these filters."
                        } else {
                            buildList {
                                add("${ImportWords.plural(total, "chat")} in ${ImportWords.plural(groups.size, "project")}")
                                if (counts.imported > 0) add("${counts.imported} imported")
                                if (counts.behind > 0) add("${counts.behind} with new messages")
                                if (counts.diverged > 0) add("${counts.diverged} continued in both places")
                                if (counts.skipped > 0) add("${counts.skipped} skipped")
                            }.joinToString(", ") + "."
                        }
                        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(summary, style = ConclaveType.metaNum, color = c.fg2, modifier = Modifier.weight(1f))
                            if (total > 0) {
                                TextButton(onClick = { vm.selectAll(dev, !pick.all) }) { Text(if (pick.all) "Clear" else "Select all") }
                                if (!pick.all && !pick.nothing) TextButton(onClick = { vm.selectAll(dev, false) }) { Text("Clear") }
                            }
                        }
                        HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 16.dp))
                    }
                }

                items(groups, key = { "g:${it.key}" }) { g ->
                    GroupRow(
                        group = g,
                        state = pick.groupState(g.key, rows[g.key]),
                        open = g.key in open,
                        rows = rows[g.key],
                        picked = { pick.picked(it, g.key) },
                        pickable = { pick.pickable(it, showSkipped) },
                        onPick = { on -> vm.pickGroup(dev, g, on) },
                        onPickRow = { x, on -> vm.pickRow(dev, x, g.key, on) },
                        onOpen = { vm.toggleOpen(dev, g) },
                    )
                }

                if (total > 0) {
                    item(key = "start") {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                                ImportMode.entries.forEachIndexed { i, m ->
                                    SegmentedButton(
                                        selected = mode == m,
                                        onClick = { vm.setMode(dev, m) },
                                        shape = SegmentedButtonDefaults.itemShape(index = i, count = ImportMode.entries.size),
                                        label = { Text(ImportWords.modeShort(m), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                    )
                                }
                            }
                            Text(
                                ImportWords.modeHelp(mode) + if (mode != ImportMode.CHATS && !memoryOn) " Memory is off on this hub, so turn it on in Memory first." else "",
                                style = ConclaveType.meta,
                                color = c.fg3,
                            )
                            Button(
                                onClick = { vm.start(dev) },
                                enabled = !pick.nothing && !starting && chosen > 0,
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            ) { Text(if (starting) "Starting" else ImportWords.startLabel(pick.nothing, mode, chosen)) }
                            val e = estimate
                            if (e != null) {
                                val (lead, rest) = ImportWords.estimateLine(e, mode)
                                Text(lead, style = ConclaveType.body, color = c.fg2)
                                rest?.let { Text(it, style = ConclaveType.meta, color = c.fg3) }
                                ImportWords.skippedLine(e).ifBlank { null }?.let { Text(it, style = ConclaveType.meta, color = c.fg3) }
                            } else {
                                Text(if (pick.nothing) "Tick a project or a chat, or Select all." else "Working out the cost.", style = ConclaveType.meta, color = c.fg3)
                            }
                        }
                    }
                }
            }

            val learningNow = batches.any { ImportWords.isLive(it) && it.mode == ImportMode.LEARN }
            if (notLearned > 0 && !learningNow) {
                item(key = "not-learned") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("${ImportWords.plural(notLearned, "imported chat")} ${if (notLearned == 1) "is" else "are"} not learned from yet.", style = ConclaveType.body, color = c.fg2)
                        OutlinedButton(onClick = { vm.learnNotLearned() }, enabled = memoryOn) { Text("Learn from ${ImportWords.plural(notLearned, "chat")}") }
                    }
                }
            }

            if (batches.isNotEmpty()) {
                item(key = "batches") { SectionHeader("Recent imports") }
                items(batches, key = { "b:${it.id}" }) { b ->
                    BatchRow(
                        batch = b,
                        names = names,
                        acting = acting[b.id],
                        onPause = { vm.pause(b) },
                        onResume = { vm.resume(b) },
                        onCancel = { vm.cancel(b) },
                        onUndo = { undoing = b },
                    )
                }
            }
        }
    }

    undoing?.let { b ->
        ConfirmDialog(
            title = "Undo this import?",
            text = "It deletes the ${ImportWords.plural(b.imported + b.forked, "session")} it made, the messages it added and the ${ImportWords.plural(b.memoriesAdded + b.memoriesReview, "memory", "memories")} it learned. Memories you edited since, and sessions you kept going in, are kept.",
            confirmLabel = "Undo",
            destructive = true,
            onConfirm = {
                undoing = null
                vm.undo(b)
            },
            onDismiss = { undoing = null },
        )
    }
}

@Composable
private fun DevicePick(current: String, ids: List<String>, names: Map<String, String>, online: Map<String, Boolean>, onPick: (String) -> Unit) {
    val c = Conclave.colors
    var openMenu by remember { mutableStateOf(false) }
    Box(Modifier.padding(horizontal = 16.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { openMenu = true },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Device", style = ConclaveType.body, color = c.fg3, modifier = Modifier.width(96.dp))
            Text(names[current] ?: current, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            val on = online[current] ?: (current == "local")
            Text(if (on) "online" else "offline, last scan kept", style = ConclaveType.meta, color = if (on) c.ok else c.fg3)
        }
        DropdownMenu(expanded = openMenu, onDismissRequest = { openMenu = false }) {
            ids.forEach { id ->
                val on = online[id] ?: (id == "local")
                DropdownMenuItem(
                    text = { Text(names[id] ?: id) },
                    trailingIcon = { Text(if (on) "online" else "offline", style = ConclaveType.meta, color = if (on) c.ok else c.fg3) },
                    onClick = {
                        openMenu = false
                        onPick(id)
                    },
                )
            }
        }
    }
}

@Composable
private fun SincePick(current: ImportSince, onPick: (ImportSince) -> Unit) {
    var openMenu by remember { mutableStateOf(false) }
    Box {
        FilterChip(selected = current != ImportSince.ANY, onClick = { openMenu = true }, label = { Text("Since ${current.label}") })
        DropdownMenu(expanded = openMenu, onDismissRequest = { openMenu = false }) {
            ImportSince.entries.forEach { s ->
                DropdownMenuItem(text = { Text(s.label) }, onClick = {
                    openMenu = false
                    onPick(s)
                })
            }
        }
    }
}

@Composable
private fun GroupRow(
    group: ImportProjectGroup,
    state: PickState,
    open: Boolean,
    rows: List<ExternalSessionInfo>?,
    picked: (ExternalSessionInfo) -> Boolean,
    pickable: (ExternalSessionInfo) -> Boolean,
    onPick: (Boolean) -> Unit,
    onPickRow: (ExternalSessionInfo, Boolean) -> Unit,
    onOpen: () -> Unit,
) {
    val c = Conclave.colors
    val g = group
    val where = g.repo ?: g.cwd
    val meta = listOfNotNull(
        g.sources.joinToString(", ") { ImportWords.sourceName(it) }.ifBlank { null },
        ImportWords.plural(g.sessions, "chat"),
        g.imported.takeIf { it > 0 }?.let { "$it imported" },
        g.skipped.takeIf { it > 0 }?.let { "$it skipped" },
        dateRange(g.first, g.last).ifBlank { null },
    ).joinToString(", ")
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TriStateCheckbox(
                state = when (state) {
                    PickState.ALL -> ToggleableState.On
                    PickState.SOME -> ToggleableState.Indeterminate
                    PickState.NONE -> ToggleableState.Off
                },
                onClick = { onPick(state != PickState.ALL) },
            )
            Column(Modifier.weight(1f).clickable(onClick = onOpen).padding(vertical = 6.dp)) {
                Text(g.name.ifBlank { where ?: "Other chats" }, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (where != null && where != g.name) Text(where, style = CodeStyle, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(meta, style = ConclaveType.meta, color = c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            TextButton(onClick = onOpen) { Text(if (open) "Hide" else "Show") }
        }
        if (open) {
            Column(Modifier.fillMaxWidth().padding(start = 28.dp)) {
                when {
                    rows == null -> Text("Loading the chats.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(12.dp))
                    rows.isEmpty() -> Text("No chats in this project with these filters.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(12.dp))
                    else -> {
                        // a long project shows its newest chats; ticking the project still takes all of them
                        rows.take(SHOWN_ROWS).forEach { x -> ChatRow(x, picked(x), pickable(x)) { on -> onPickRow(x, on) } }
                        if (rows.size > SHOWN_ROWS) {
                            Text("Showing $SHOWN_ROWS of ${rows.size} chats. Tick the project to take all of them.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(12.dp))
                        }
                    }
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 16.dp))
    }
}

@Composable
private fun ChatRow(x: ExternalSessionInfo, picked: Boolean, pickable: Boolean, onPick: (Boolean) -> Unit) {
    val c = Conclave.colors
    val st = ImportWords.rowState(x)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = if (x.parentKey != null) 20.dp else 0.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = pickable && picked, onCheckedChange = if (pickable) onPick else null, enabled = pickable)
        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
            Text(x.title.ifBlank { "Untitled chat" }, style = ConclaveType.body, color = if (x.skip != null) c.fg2 else c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val prompts = ImportWords.plural(x.humanPrompts, "prompt")
            Text(listOf(ImportWords.sourceName(x.source), shortDate(x.updatedAt), prompts).filter { it.isNotBlank() }.joinToString(", "), style = ConclaveType.meta, color = c.fg3, maxLines = 1)
        }
        Spacer(Modifier.width(8.dp))
        StateWordText(st.word, st.tone)
    }
}

@Composable
private fun BatchRow(
    batch: ImportBatch,
    names: Map<String, String>,
    acting: String?,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onCancel: () -> Unit,
    onUndo: () -> Unit,
) {
    val c = Conclave.colors
    val b = batch
    val st = ImportWords.batchState(b)
    val working = ImportWords.isWorking(b)
    val counts = ImportWords.batchCounts(b)
    val dropped = ImportWords.droppedWords(b.dropped)
    val canUndo = ImportWords.canUndo(b, System.currentTimeMillis())
    // an import that finishes while you watch: the knot plays success where it ran
    var finished by remember(b.id) { mutableStateOf(false) }
    var wasWorking by remember(b.id) { mutableStateOf(working) }
    var finishPlayed by remember(b.id) { mutableStateOf(false) }
    LaunchedEffect(working, b.status) {
        if (wasWorking && !working && b.status == ImportBatchStatus.DONE) finished = true
        wasWorking = working
    }
    LaunchedEffect(finishPlayed) {
        if (!finishPlayed) return@LaunchedEffect
        delay(1200)
        finished = false
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Text(ImportWords.batchTitle(b, names), style = ConclaveType.rowTitle, color = c.fg, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                val at = st.resumeAt
                StateWordText(if (at != null && at > 0) "resumes ${clockTime(at)}" else st.word, st.tone)
                Text(Format.relative(b.updatedAt), style = ConclaveType.metaNum, color = c.fg3)
            }
        }
        Text(if (counts.isEmpty()) "Nothing done yet" else counts.joinToString(", "), style = ConclaveType.metaNum, color = c.fg3)
        if (dropped.isNotEmpty() && b.mode != ImportMode.CHATS) Text("Left out: $dropped.", style = ConclaveType.meta, color = c.fg3)
        b.error?.let { Text(it, style = ConclaveType.meta, color = c.fault) }
        if (finished) KnotRopeLine(RopeMoment.SUCCESS, "Finished", Modifier.padding(top = 4.dp), color = c.ok, onDone = { finishPlayed = true })
        if (working) {
            val p = ImportWords.batchProgress(b)
            LiveStatus(LiveState.TOOL, label = p.verb, detail = "${p.done} of ${p.total}", startedAt = b.createdAt, modifier = Modifier.padding(top = 4.dp))
        }
        val resumeAt = b.resumeAt
        if (b.status == ImportBatchStatus.WAITING_RESET && resumeAt != null) {
            LiveStatus(LiveState.RESUMING, resumeAt = resumeAt, detail = "the model's limit", modifier = Modifier.padding(top = 4.dp))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            val busy = acting != null
            if (working) TextButton(onClick = onPause, enabled = !busy) { Text(if (acting == "Pausing") "Pausing" else "Pause") }
            if (b.status == ImportBatchStatus.PAUSED || b.status == ImportBatchStatus.FAILED || b.status == ImportBatchStatus.WAITING_RESET) {
                TextButton(onClick = onResume, enabled = !busy) { Text(if (acting == "Resuming") "Resuming" else "Resume") }
            }
            if (ImportWords.isLive(b) || b.status == ImportBatchStatus.PAUSED) {
                TextButton(onClick = onCancel, enabled = !busy) { Text(if (acting == "Cancelling") "Cancelling" else "Cancel") }
            }
            if (canUndo) TextButton(onClick = onUndo, enabled = !busy) { Text(if (acting == "Undoing") "Undoing" else "Undo this import", color = c.fault) }
        }
    }
}
