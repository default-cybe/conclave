@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.meetings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.KeyValue
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MarkdownText
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.StateWordText
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.cancelPrep
import dev.conclave.client.deleteMeeting
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Meetings
import dev.conclave.client.meeting
import dev.conclave.client.meetingNotes
import dev.conclave.client.meetingPrep
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Meeting
import dev.conclave.client.model.MeetingInput
import dev.conclave.client.model.PrepView
import dev.conclave.client.model.SteeringPreset
import dev.conclave.client.revertPrep
import dev.conclave.client.savePrep
import dev.conclave.client.startPrep
import dev.conclave.client.steeringPresets
import dev.conclave.client.updateMeeting
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

class MeetingDetailViewModel(hub: HubRepository, private val id: String) : HubViewModel(hub) {
    val meeting = MutableStateFlow<Meeting?>(null)
    val prep = MutableStateFlow<PrepView?>(null)
    val notes = MutableStateFlow<String?>(null)
    val presets = MutableStateFlow<List<SteeringPreset>>(emptyList())
    val error = MutableStateFlow<String?>(null)

    init {
        load()
        viewModelScope.launch { presets.value = runCatching { hub.api { it.steeringPresets() } }.getOrElse { emptyList() } }
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.MeetingUpdated -> if (e.meeting.id == id) meeting.value = e.meeting
                    is EngineEvent.MeetingPrep -> if (e.meetingId == id) {
                        val was = prep.value?.state
                        prep.value = (prep.value ?: PrepView()).copy(state = e.state, progress = e.progress)
                        // finished, failed or paused for an OK: the draft, the error or the estimate come with GET
                        if (was != e.state && !Meetings.prepRunning(e.state)) loadPrep()
                    }
                    is EngineEvent.ConfigUpdated -> load()
                    else -> Unit
                }
            }
        }
    }

    fun load() {
        viewModelScope.launch {
            try {
                val m = hub.api { it.meeting(id) }
                meeting.value = m
                error.value = null
                if (m.status == "ended" && notes.value == null) notes.value = runCatching { hub.api { it.meetingNotes(id) } }.getOrNull()
            } catch (e: Exception) {
                error.value = errorText(e)
            }
        }
        loadPrep()
    }

    // a 0.4.51 hub has no prep route: the tab says it cannot prepare there
    private fun loadPrep() {
        viewModelScope.launch { prep.value = runCatching { hub.api { it.meetingPrep(id) } }.getOrElse { PrepView(state = "none", error = errorText(it)) } }
    }

    fun prepare(approve: Boolean = false) = action {
        hub.api { it.startPrep(id, approve) }
        prep.value = (prep.value ?: PrepView()).copy(state = "queued", error = null)
    }

    fun cancelPrep() = action {
        hub.api { it.cancelPrep(id) }
        loadPrep()
    }

    fun savePrep(markdown: String, onDone: () -> Unit = {}) = action("Saved") {
        prep.value = hub.api { it.savePrep(id, markdown) }
        onDone()
    }

    fun revertPrep() = action("Back to the draft") {
        hub.api { it.revertPrep(id) }
        loadPrep()
    }

    fun saveSteering(text: String, preset: String?, length: String) = action("Saved") {
        meeting.value = hub.api { it.updateMeeting(id, MeetingInput(steering = text.trim(), steeringPreset = preset, answerLength = length)) }
    }

    fun delete(onDone: () -> Unit) = action {
        hub.api { it.deleteMeeting(id) }
        onDone()
    }
}

private enum class Tab(val label: String) { PREP("Prep"), STEERING("Steering"), DETAILS("Details") }

/**
 * One meeting (docs/design/MEETING-MODE.md 11.7): the status line, then Prep,
 * Steering and Details. The phone never listens: a ready or live meeting
 * points to the desktop app.
 */
@Composable
fun MeetingDetailScreen(id: String, onBack: () -> Unit, onEdit: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: MeetingDetailViewModel = viewModel(key = "meeting:$id") { MeetingDetailViewModel(hub, id) }
    val meeting by vm.meeting.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    var deleting by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val prep by vm.prep.collectAsStateWithLifecycle()
    val m = meeting
    val c = Conclave.colors

    Scaffold(
        topBar = {
            TopBar(
                m?.title?.ifBlank { null } ?: "Meeting",
                onBack = onBack,
                newChat = false,
                actions = {
                    if (m != null) {
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "More") }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text("Edit meeting") }, onClick = { menu = false; onEdit(m.id) })
                                if (prep?.edited != null) DropdownMenuItem(text = { Text("Revert to draft") }, onClick = { menu = false; vm.revertPrep() })
                                DropdownMenuItem(text = { Text("Delete", color = c.fault) }, onClick = { menu = false; deleting = true })
                            }
                        }
                    }
                },
            )
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().imePadding()) {
            when {
                m == null && error != null -> Column(Modifier.padding(16.dp)) {
                    Text("Could not load the meeting: $error", style = ConclaveType.body, color = c.fault)
                    TextButton(onClick = { vm.load() }) { Text("Retry") }
                }
                m == null -> LoadingBox()
                else -> Body(vm, m, prep, onEdit)
            }
        }
    }
    if (deleting) {
        ConfirmDialog(
            title = "Delete ${m?.title?.ifBlank { null } ?: "this meeting"}?",
            text = "Its prep, reminders and transcript go too.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                deleting = false
                vm.delete(onBack)
            },
            onDismiss = { deleting = false },
        )
    }
}

@Composable
private fun Body(vm: MeetingDetailViewModel, m: Meeting, prep: PrepView?, onEdit: (String) -> Unit) {
    val c = Conclave.colors
    val devices by LocalAppContainer.current.hub.devices.collectAsStateWithLifecycle()
    val notes by vm.notes.collectAsStateWithLifecycle()
    val presets by vm.presets.collectAsStateWithLifecycle()
    val at = m.scheduledAt
    val now by rememberNow(at?.let { Meetings.tickMs(it - System.currentTimeMillis()) } ?: 60_000)
    val zone = Meetings.zoneOf(m, null)
    val deviceName: (String) -> String? = { id -> devices.firstOrNull { it.id == id }?.name?.ifBlank { null } }
    var tab by rememberSaveable { mutableStateOf(Tab.PREP) }
    val notHeld = Meetings.notHeld(m, now)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // "Scheduled · Mon 2 Nov, 10:00 to 11:00 · capstone · MacBook · in 2 days"
        val (word, tone) = Meetings.statusWord(m, now)
        val sub = listOfNotNull(
            at?.let { (if (notHeld) "was " else "") + Meetings.whenWords(it, m.durationMin, zone) },
            Meetings.place(m, deviceName).ifBlank { null },
            at?.takeIf { !notHeld && m.startedAt == null }?.let { Meetings.countdown(it - now, it, zone) },
        ).joinToString(" · ")
        Row {
            StateWordText(word, tone)
            if (sub.isNotBlank()) Text(" · $sub", style = ConclaveType.metaNum, color = c.fg3)
        }
        when {
            notHeld -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onEdit(m.id) }, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Reschedule") }
            }
            m.status in setOf("ready", "live", "paused") ->
                Text("Listen from the Conclave desktop app.", style = ConclaveType.body, color = c.fg2)
            m.status == "failed" && m.error != null -> Text(m.error.orEmpty(), style = ConclaveType.body, color = c.fault)
        }
        if (m.status == "ended" && !notes.isNullOrBlank()) {
            Text("Notes", style = ConclaveType.section, color = c.fg)
            MarkdownText(notes.orEmpty())
        }
        Segmented(value = tab, options = Tab.entries.map { it to it.label }, onChange = { tab = it }, modifier = Modifier.fillMaxWidth())
        when (tab) {
            Tab.PREP -> PrepTab(vm, prep, now)
            Tab.STEERING -> SteeringTab(vm, m, presets)
            Tab.DETAILS -> DetailsTab(m, zone, deviceName)
        }
    }
}

@Composable
private fun PrepTab(vm: MeetingDetailViewModel, prep: PrepView?, now: Long) {
    val c = Conclave.colors
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    var compare by rememberSaveable { mutableStateOf("mine") }
    var confirmNew by remember { mutableStateOf(false) }
    if (prep == null) {
        LoadingBox()
        return
    }
    val shown = prep.edited ?: prep.draft
    val text = editing
    when {
        text != null -> {
            OutlinedTextField(
                value = text,
                onValueChange = { editing = it.take(Meetings.PREP_MAX) },
                textStyle = CodeStyle,
                minLines = 12,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.savePrep(text) { editing = null } }, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Save") }
                OutlinedButton(onClick = { editing = null }, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Cancel") }
            }
            return
        }
        Meetings.prepRunning(prep.state) -> {
            Text(Meetings.progressLine(prep.progress, now), style = ConclaveType.metaNum, color = c.fg2)
            PrepMeter(prep.progress)
            TextButton(onClick = { vm.cancelPrep() }) { Text("Cancel") }
        }
        prep.state == "waiting" -> {
            Text(estimateLine(prep), style = ConclaveType.body, color = c.fg)
            Button(onClick = { vm.prepare(approve = true) }, colors = solidButtonColors(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Continue") }
            TextButton(onClick = { vm.cancelPrep() }) { Text("Cancel") }
        }
        prep.state == "failed" -> {
            val read = prep.progress?.done?.takeIf { it > 0 }?.let { " ($it chats already read)" }.orEmpty()
            Text("Prep failed: ${prep.error ?: "unknown error"}$read", style = ConclaveType.body, color = c.fault)
            Button(onClick = { vm.prepare() }, colors = solidButtonColors(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Try again") }
        }
    }
    if (shown == null) {
        if (Meetings.prepRunning(prep.state) || prep.state == "waiting" || prep.state == "failed") return
        Text(
            "Read every chat, the code and your notes on this folder, and write a summary, timeline, evidence, likely questions and a presenting order.",
            style = ConclaveType.body,
            color = c.fg2,
        )
        prep.error?.let { Text(it, style = ConclaveType.meta, color = c.fault) }
        Button(onClick = { vm.prepare() }, colors = solidButtonColors(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Prepare") }
        return
    }
    // a re-run made a new draft over the owner's edits: his stays in use until he says
    val newOverMine = prep.edited != null && prep.draft != null && (prep.at ?: 0) > (prep.editedAt ?: 0)
    if (newOverMine) {
        Text("A new draft is ready. Your edited version is still the one in use.", style = ConclaveType.body, color = c.warn)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { compare = if (compare == "mine") "new" else "mine" }) { Text("Compare") }
            TextButton(onClick = { confirmNew = true }) { Text("Use new draft") }
            // saving his text again stamps it newer than the draft, so the banner goes for good
            TextButton(onClick = { vm.savePrep(prep.edited.orEmpty()) }) { Text("Keep mine") }
        }
        Segmented(value = compare, options = listOf("mine" to "Mine", "new" to "New"), onChange = { compare = it }, modifier = Modifier.fillMaxWidth())
    }
    val sources = prep.sources
    val meta = listOfNotNull(
        (if (prep.edited != null) "Edited" else "Prepared") + ((if (prep.edited != null) prep.editedAt else prep.at)?.let { " ${Format.relative(it, now)}" } ?: ""),
        sources?.let { if (it.sessions == 1) "1 chat" else "${it.sessions} chats" },
        sources?.leftOut?.size?.takeIf { it > 0 }?.let { "$it left out" },
    ).joinToString(" · ")
    Row {
        Text(meta, style = ConclaveType.metaNum, color = c.fg3, modifier = Modifier.weight(1f))
        TextButton(onClick = { editing = shown }) { Text("Edit") }
    }
    MarkdownText(if (newOverMine && compare == "new") prep.draft.orEmpty() else shown)
    if (!Meetings.prepRunning(prep.state)) {
        OutlinedButton(onClick = { vm.prepare() }, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Prepare again") }
    }
    if (confirmNew) {
        ConfirmDialog(
            title = "Use the new draft?",
            text = "Your edits are replaced by the new draft.",
            confirmLabel = "Use new draft",
            destructive = true,
            onConfirm = {
                confirmNew = false
                vm.revertPrep()
            },
            onDismiss = { confirmNew = false },
        )
    }
}

/** "About 1.4M tokens" from the hub's estimate; the hub's own words when it has no count. */
private fun estimateLine(prep: PrepView): String {
    val tokens = (prep.estimate?.get("tokens") as? JsonPrimitive)?.longOrNull
    return if (tokens != null) "This prep reads about ${Format.tokens(tokens)} tokens. Continue?" else "This prep reads a lot of chats and needs your OK."
}

@Composable
private fun SteeringTab(vm: MeetingDetailViewModel, m: Meeting, presets: List<SteeringPreset>) {
    val c = Conclave.colors
    var text by rememberSaveable(m.id) { mutableStateOf(m.steering.orEmpty()) }
    var preset by rememberSaveable(m.id) { mutableStateOf(m.steeringPreset) }
    var length by rememberSaveable(m.id) { mutableStateOf(m.answerLength) }
    val changed = text.trim() != m.steering.orEmpty().trim() || length != m.answerLength
    SteeringFields(presets, text, preset, length, minLines = 8, onText = { t, p -> text = t; preset = p }, onLength = { length = it })
    if (m.status == "live" || m.status == "paused") Text("Changes apply from the next answer.", style = ConclaveType.meta, color = c.fg3)
    Button(onClick = { vm.saveSteering(text, preset, length) }, enabled = changed, colors = solidButtonColors(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Save") }
}

@Composable
private fun DetailsTab(m: Meeting, zone: java.time.ZoneId, deviceName: (String) -> String?) {
    val c = Conclave.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        m.scheduledAt?.let { KeyValue("When", Meetings.whenWords(it, m.durationMin, zone) + " (${zone.id})") }
        KeyValue("Device", deviceName(m.device) ?: m.device)
        Text("Folder", style = ConclaveType.meta, color = c.fg3)
        Text(m.cwd, style = CodeStyle, color = c.fg)
        if (!m.agenda.isNullOrBlank()) {
            Text("What it's for", style = ConclaveType.meta, color = c.fg3)
            Text(m.agenda.orEmpty(), style = ConclaveType.body, color = c.fg)
        }
        if (m.scheduledAt != null) {
            val r = Meetings.REMINDERS.filter { it.first in m.reminders }.joinToString(", ") { it.second }
            KeyValue("Reminders", r.ifBlank { "None" })
            KeyValue("Prepare the evening before", if (m.autoPrep) "On" else "Off")
        }
    }
}
