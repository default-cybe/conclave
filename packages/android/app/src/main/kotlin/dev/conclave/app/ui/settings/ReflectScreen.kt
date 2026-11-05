@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.ReflectWords
import dev.conclave.client.model.MemoryEntry
import dev.conclave.client.model.ReflectInfo
import dev.conclave.client.model.ReflectPatch
import dev.conclave.client.model.ReflectReport
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * Settings > Reflect (docs/ASSISTANT.md, Nightly reflection), as on the web:
 * the switch (the same setting as the hub's Settings > Assistant), Reflect
 * now, what the last run did, and the notes it keeps, each with Delete. The
 * time and the model are set on the web. Above it, the report of your week,
 * month or last 3, 6 or 12 months (GET /api/reflect/report), with Refresh.
 */
class ReflectViewModel(hub: HubRepository) : HubViewModel(hub) {
    val info = MutableStateFlow<ReflectInfo?>(null)
    val refreshing = MutableStateFlow(false)
    val busy = MutableStateFlow(false)
    val range = MutableStateFlow("week")
    /** Reports kept per range, as the hub keeps them. */
    val reports = MutableStateFlow<Map<String, ReflectReport>>(emptyMap())
    val reportError = MutableStateFlow<String?>(null)
    val remaking = MutableStateFlow(false)

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                info.value = hub.api { it.reflect() }
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                refreshing.value = false
            }
        }
        loadReport()
    }

    fun setRange(r: String) {
        range.value = r
        if (reports.value[r] == null) loadReport()
    }

    private fun loadReport() {
        val r = range.value
        reportError.value = null
        viewModelScope.launch {
            try {
                val d = hub.api { it.reflectReport(r) }
                reports.value = reports.value + (r to d)
            } catch (e: Exception) {
                reportError.value = errorText(e)
            }
        }
    }

    /** Refresh: the hub makes the report again with one call on your small model. */
    fun remake() = action {
        val r = range.value
        remaking.value = true
        try {
            val d = hub.api { it.reflectRefresh(r) }
            reports.value = reports.value + (r to d)
        } finally {
            remaking.value = false
        }
    }

    fun setEnabled(on: Boolean) = action { info.value = hub.api { it.setReflect(ReflectPatch(enabled = on)) } }

    /** One reflection now; while it runs, read the page again every few seconds until it is done. */
    fun reflectNow() = action {
        busy.value = true
        try {
            val out = hub.api { it.reflectNow() }
            info.value = out.reflect
            val skipped = out.skipped
            if (skipped != null) {
                say("Nothing to reflect on. $skipped.")
                return@action
            }
            say("Reflecting now. The notes show up here when it is done.")
            repeat(40) {
                delay(3_000)
                val next = hub.api { it.reflect() }
                info.value = next
                if (next.last?.status != "running") return@action
            }
        } finally {
            busy.value = false
        }
    }

    fun delete(note: MemoryEntry) = action("Deleted.") {
        hub.api { it.deleteMemory(note.id) }
        info.value = info.value?.let { r -> r.copy(notes = r.notes.filter { it.id != note.id }) }
    }
}

@Composable
fun ReflectScreen(onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: ReflectViewModel = viewModel { ReflectViewModel(hub) }
    val info by vm.info.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    var deleting by remember { mutableStateOf<MemoryEntry?>(null) }
    val c = Conclave.colors

    Scaffold(topBar = { TopBar("Reflect", onBack = onBack) }, snackbarHost = { ToastHost(snackbar) }, containerColor = c.bg) { padding ->
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
                ReportSection(vm)
                SectionHeader("Nightly reflection", Modifier.padding(top = 12.dp))
                Text(ReflectWords.LINE, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
                val r = info ?: return@Column
                // the switch: the same setting as Settings, Assistant on the hub
                Row(
                    Modifier.fillMaxWidth().clickable { vm.setEnabled(!r.enabled) }.heightIn(min = 56.dp).padding(start = 20.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Reflect each night", style = ConclaveType.body, color = c.fg)
                        Text(ReflectWords.time(r), style = ConclaveType.meta, color = c.fg3)
                    }
                    Spacer(Modifier.width(12.dp))
                    Switch(checked = r.enabled, onCheckedChange = { vm.setEnabled(it) })
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Last run", style = ConclaveType.body, color = c.fg)
                        Text(ReflectWords.lastRun(r.last), style = ConclaveType.meta, color = c.fg3)
                    }
                    Spacer(Modifier.width(12.dp))
                    OutlinedButton(onClick = { vm.reflectNow() }, enabled = !busy && r.last?.status != "running") { Text("Reflect now") }
                }
                Text("${ReflectWords.model(r.model)}. Change the time and the model on the web, in Settings, Reflect.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))

                HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                Text("Notes on how to work with you", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 4.dp))
                if (r.notes.isEmpty()) {
                    Text("No notes yet. After a night with chats, up to 3 show up here.", style = ConclaveType.body, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                }
                r.notes.forEach { n ->
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.Top) {
                        Text(n.content, style = ConclaveType.body, color = c.fg, modifier = Modifier.weight(1f).padding(top = 10.dp))
                        TextButton(onClick = { deleting = n }) { Text("Delete", color = c.fg3) }
                    }
                }
            }
        }
    }

    deleting?.let { n ->
        ConfirmDialog(
            title = "Delete this note?",
            text = "\"${n.content}\" leaves memory. The assistant stops reading it.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                deleting = null
                vm.delete(n)
            },
            onDismiss = { deleting = null },
        )
    }
}

private val DAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

/** The report, as on the web's Settings > Reflect: each section hidden when there is too little to say. */
@Composable
private fun ReportSection(vm: ReflectViewModel) {
    val range by vm.range.collectAsStateWithLifecycle()
    val reports by vm.reports.collectAsStateWithLifecycle()
    val error by vm.reportError.collectAsStateWithLifecycle()
    val remaking by vm.remaking.collectAsStateWithLifecycle()
    val c = Conclave.colors
    val r = reports[range]
    val pad = Modifier.padding(horizontal = 20.dp)

    SectionHeader(if (r != null) "Your report, ${ReflectWords.range(r)}" else "Your report")
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
        ReflectWords.RANGES.forEachIndexed { i, (value, label) ->
            SegmentedButton(
                selected = range == value,
                onClick = { vm.setRange(value) },
                shape = SegmentedButtonDefaults.itemShape(index = i, count = ReflectWords.RANGES.size),
                label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            )
        }
    }
    if (error != null && r == null) {
        Text("Could not load the report. $error", style = ConclaveType.meta, color = c.fault, modifier = pad)
        return
    }
    if (r == null) {
        Text("Making your report.", style = ConclaveType.meta, color = c.fg3, modifier = pad)
        return
    }
    val empty = r.totals.chats == 0 && r.totals.sessions == 0
    Text(r.headline, style = ConclaveType.title, color = c.fg, modifier = pad.padding(top = 4.dp))
    Row(pad.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(ReflectWords.made(r), style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
        if (!empty) {
            Spacer(Modifier.width(12.dp))
            OutlinedButton(onClick = { vm.remake() }, enabled = !remaking) { Text(if (remaking) "Making it" else "Refresh") }
        }
    }
    r.insightsNote?.let { Text(it, style = ConclaveType.meta, color = c.warn, modifier = pad.padding(top = 4.dp)) }
    if (empty) return

    // big numbers
    Row(pad.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        ReflectWords.bigNumbers(r.totals).forEach { (value, label) ->
            Column(Modifier.weight(1f)) {
                Text(value, style = ConclaveType.stat, color = c.fg)
                Text(label, style = ConclaveType.micro, color = c.fg3)
            }
        }
    }

    val w = r.work
    if (w.topics.isNotEmpty() || w.projects.isNotEmpty()) {
        SectionHeader("What you worked on")
        val rows = if (w.topics.isNotEmpty()) w.topics.map { Triple(it.name, it.example, "") } else w.projects.map { Triple(it.name, it.example, if (it.sessions == 1) "1 session" else "${it.sessions} sessions") }
        rows.forEach { (name, line, meta) ->
            Column(pad.fillMaxWidth().padding(vertical = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, style = ConclaveType.rowTitle, color = c.fg, modifier = Modifier.weight(1f))
                    if (meta.isNotEmpty()) Text(meta, style = ConclaveType.metaNum, color = c.fg3)
                }
                if (line.isNotEmpty()) Text(line, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (w.topics.isNotEmpty() && w.projects.isNotEmpty()) {
            Text("Projects: ${w.projects.joinToString(", ") { "${it.name} ${it.sessions}" }}.", style = ConclaveType.body, color = c.fg2, modifier = pad.padding(top = 4.dp))
        }
        if (w.newThisPeriod.isNotEmpty()) Text("New this period: ${w.newThisPeriod.joinToString(", ")}.", style = ConclaveType.body, color = c.fg2, modifier = pad.padding(top = 4.dp))
    }

    val rh = r.rhythm
    if (rh.messages >= 5) {
        SectionHeader("When you work")
        val max = rh.heatmap.flatten().maxOrNull() ?: 0
        Column(pad.fillMaxWidth().padding(top = 10.dp).horizontalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            rh.heatmap.forEachIndexed { d, row ->
                Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(DAYS.getOrElse(d) { "" }, style = ConclaveType.micro, color = c.fg3, modifier = Modifier.width(30.dp))
                    row.forEach { v ->
                        val level = ReflectWords.heatLevel(v, max)
                        Box(Modifier.width(10.dp).height(12.dp).background(if (level == 0) c.bgSunk else c.fg.copy(alpha = 0.15f + 0.2f * (level - 1)), RoundedCornerShape(2.dp)))
                    }
                }
            }
        }
        Text(ReflectWords.rhythm(rh), style = ConclaveType.body, color = c.fg2, modifier = pad.padding(top = 10.dp))
        ReflectWords.lateLine(rh.lateNightShare, rh.messages)?.let { Text(it, style = ConclaveType.body, color = c.fg, modifier = pad.padding(top = 4.dp)) }
    }

    if (r.habits.isNotEmpty()) {
        SectionHeader("How you work with AI")
        r.habits.forEach { h ->
            val (title, what) = ReflectWords.HABITS[h.key] ?: (h.key to "")
            Column(pad.fillMaxWidth().padding(vertical = 8.dp)) {
                Text(title, style = ConclaveType.rowTitle, color = c.fg)
                if (what.isNotEmpty()) Text(what, style = ConclaveType.micro, color = c.fg3)
                Text(h.observation, style = ConclaveType.body, color = c.fg2, modifier = Modifier.padding(top = 2.dp))
                h.example?.let { Text(it, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 2.dp)) }
            }
        }
    }

    val m = r.models
    if (m.models.isNotEmpty()) {
        SectionHeader("Your models and agents")
        m.models.take(5).forEach { u ->
            Row(pad.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(ReflectWords.modelLine(u.name), style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(12.dp))
                Text(Format.tokens(u.tokens), style = ConclaveType.metaNum, color = c.fg2)
                Text(if (u.costUsd > 0) Format.usd(u.costUsd) else "plan", style = ConclaveType.metaNum, color = c.fg3, modifier = Modifier.width(64.dp).padding(start = 12.dp))
            }
        }
        ReflectWords.modelsLine(m).takeIf { it.isNotEmpty() }?.let { Text(it, style = ConclaveType.body, color = c.fg2, modifier = pad.padding(top = 4.dp)) }
    }

    val fun_ = ReflectWords.funRows(r)
    if (fun_.size >= 2) {
        SectionHeader("Fun stats")
        fun_.forEach { (k, v) ->
            Column(pad.fillMaxWidth().padding(vertical = 6.dp)) {
                Text(k, style = ConclaveType.meta, color = c.fg3)
                Text(v, style = ConclaveType.body, color = c.fg)
            }
        }
    }

    if (r.suggestions.isNotEmpty()) {
        SectionHeader("Suggestions")
        r.suggestions.forEachIndexed { i, s ->
            Column(pad.fillMaxWidth().padding(vertical = 6.dp)) {
                Text("${i + 1}. ${s.text}", style = ConclaveType.rowTitle, color = c.fg)
                if (s.why.isNotEmpty()) Text(s.why, style = ConclaveType.meta, color = c.fg3)
            }
        }
    }

    if (r.question.isNotEmpty()) {
        SectionHeader("A question for you")
        Text(r.question, style = ConclaveType.prose, color = c.fg, modifier = pad.padding(top = 8.dp))
    }

    ReflectWords.excluded(r.excluded)?.let { Text(it, style = ConclaveType.meta, color = c.fg3, modifier = pad.padding(top = 16.dp)) }
}
