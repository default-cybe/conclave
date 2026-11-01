@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.meetings

import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.createMeeting
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Meetings
import dev.conclave.client.meeting
import dev.conclave.client.meetingFolders
import dev.conclave.client.model.Meeting
import dev.conclave.client.model.MeetingFolder
import dev.conclave.client.model.MeetingInput
import dev.conclave.client.model.SteeringPreset
import dev.conclave.client.steeringPresets
import dev.conclave.client.today
import dev.conclave.client.updateMeeting
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** What the form needs from the hub: the folders, the presets, the owner's zone, and the meeting when editing. */
class MeetingFormViewModel(hub: HubRepository, private val editId: String?) : HubViewModel(hub) {
    val folders = MutableStateFlow<List<MeetingFolder>?>(null)
    val presets = MutableStateFlow<List<SteeringPreset>>(emptyList())
    val zone = MutableStateFlow<ZoneId?>(null)
    val editing = MutableStateFlow<Meeting?>(null)
    val loaded = MutableStateFlow(editId == null)
    val saving = MutableStateFlow(false)
    val error = MutableStateFlow<String?>(null)

    init {
        viewModelScope.launch { folders.value = runCatching { hub.api { it.meetingFolders() } }.getOrElse { emptyList() } }
        viewModelScope.launch { presets.value = runCatching { hub.api { it.steeringPresets() } }.getOrElse { emptyList() } }
        // the owner's zone is the day plan's (prefs.timezone on the hub); the phone's when the hub does not say
        viewModelScope.launch { zone.value = runCatching { hub.api { it.today() }.timezone }.getOrNull()?.let { Meetings.zone(it) } ?: ZoneId.systemDefault() }
        if (editId != null) {
            viewModelScope.launch {
                try {
                    editing.value = hub.api { it.meeting(editId) }
                } catch (e: Exception) {
                    say(errorText(e))
                } finally {
                    loaded.value = true
                }
            }
        }
    }

    fun save(input: MeetingInput, onDone: (Meeting) -> Unit) {
        if (saving.value) return
        viewModelScope.launch {
            saving.value = true
            error.value = null
            try {
                val m = hub.api { if (editId != null) it.updateMeeting(editId, input) else it.createMeeting(input) }
                onDone(m)
            } catch (e: Exception) {
                error.value = errorText(e)
            } finally {
                saving.value = false
            }
        }
    }
}

/**
 * The new and edit form (docs/design/MEETING-MODE.md 11.3), full screen on
 * the phone. [startNow] hides the date and its button reads "Prepare and
 * start". With [editId] it edits that meeting (Reschedule opens it too).
 */
@Composable
fun MeetingFormScreen(editId: String?, startNow: Boolean, onBack: () -> Unit, onSaved: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: MeetingFormViewModel = viewModel(key = "meeting-form:${editId.orEmpty()}:$startNow") { MeetingFormViewModel(hub, editId) }
    val loaded by vm.loaded.collectAsStateWithLifecycle()
    val editing by vm.editing.collectAsStateWithLifecycle()
    val zone by vm.zone.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    val title = when {
        editId != null -> "Edit meeting"
        startNow -> "Start a meeting"
        else -> "Schedule a meeting"
    }
    Scaffold(topBar = { TopBar(title, onBack = onBack, newChat = false) }, snackbarHost = { ToastHost(snackbar) }) { padding ->
        val z = zone
        if (!loaded || z == null) {
            Box(Modifier.padding(padding)) { LoadingBox() }
        } else {
            FormBody(vm, editing, z, startNow, Modifier.padding(padding), onSaved)
        }
    }
}

@Composable
private fun FormBody(vm: MeetingFormViewModel, editing: Meeting?, zone: ZoneId, startNow: Boolean, modifier: Modifier, onSaved: (String) -> Unit) {
    val c = Conclave.colors
    val folders by vm.folders.collectAsStateWithLifecycle()
    val presets by vm.presets.collectAsStateWithLifecycle()
    val saving by vm.saving.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val edit = editing != null
    // a meeting that started cannot move (409): its form edits only the words
    val datesShown = !startNow && (editing == null || Meetings.canReschedule(editing))

    val start0 = editing?.scheduledAt?.let { Instant.ofEpochMilli(it).atZone(Meetings.zoneOf(editing, zone.id)).withZoneSameInstant(zone) }
    var titleText by rememberSaveable { mutableStateOf(editing?.title.orEmpty()) }
    var date by rememberSaveable { mutableStateOf(start0?.toLocalDate() ?: LocalDate.now(zone).plusDays(1)) }
    var time by rememberSaveable { mutableStateOf(start0?.toLocalTime()?.withSecond(0)?.withNano(0) ?: LocalTime.of(10, 0)) }
    var duration by rememberSaveable { mutableStateOf(editing?.durationMin) }
    var folderKey by rememberSaveable { mutableStateOf(editing?.let { it.device + "\u0000" + it.cwd }) }
    var purpose by rememberSaveable { mutableStateOf(editing?.agenda.orEmpty()) }
    var steering by rememberSaveable { mutableStateOf(editing?.steering.orEmpty()) }
    var preset by rememberSaveable { mutableStateOf(editing?.steeringPreset) }
    var length by rememberSaveable { mutableStateOf(editing?.answerLength ?: "short") }
    var reminders by rememberSaveable { mutableStateOf(editing?.reminders ?: listOf(1440, 15)) }
    var autoPrep by rememberSaveable { mutableStateOf(editing?.autoPrep ?: true) }

    val folder = folders?.firstOrNull { it.device + "\u0000" + it.cwd == folderKey }
    val startMs = date.atTime(time).atZone(zone).toInstant().toEpochMilli()
    val startProblem = if (datesShown) Meetings.startProblem(startMs, System.currentTimeMillis()) else null
    val ready = folderKey != null && startProblem == null && titleText.length <= Meetings.TITLE_MAX && !saving

    Column(modifier.fillMaxSize().imePadding()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            OutlinedTextField(
                value = titleText,
                onValueChange = { titleText = it.take(Meetings.TITLE_MAX) },
                label = { Text("Title") },
                placeholder = { Text("Capstone defence") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (datesShown) {
                DateTimeField(date, time, zone, onDate = { date = it }, onTime = { time = it }, problem = startProblem)
                DurationField(duration, onChange = { duration = it })
            }
            FolderField(folders, folder, editing, onPick = { folderKey = it.device + "\u0000" + it.cwd })
            OutlinedTextField(
                value = purpose,
                onValueChange = { purpose = it.take(Meetings.TEXT_MAX) },
                label = { Text("What it's for") },
                placeholder = { Text("Capstone defence: present all evidence, defend the findings, 10 min talk then questions.") },
                minLines = 3,
                maxLines = 10,
                modifier = Modifier.fillMaxWidth(),
            )
            SteeringFields(
                presets = presets,
                text = steering,
                preset = preset,
                length = length,
                minLines = 8,
                onText = { t, p ->
                    steering = t
                    preset = p
                },
                onLength = { length = it },
            )
            if (datesShown) {
                Column {
                    Text("Reminders", style = ConclaveType.section, color = c.fg)
                    Meetings.REMINDERS.forEach { (minutes, label) ->
                        val on = minutes in reminders
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { reminders = if (on) reminders - minutes else (reminders + minutes).sortedDescending() },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = on, onCheckedChange = null)
                            Spacer(Modifier.width(8.dp))
                            Text(label, style = ConclaveType.body, color = c.fg)
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Prepare the evening before", style = ConclaveType.body, color = c.fg)
                        Text("At 19:00 the day before, if you have not prepared yet.", style = ConclaveType.meta, color = c.fg3)
                    }
                    Switch(checked = autoPrep, onCheckedChange = { autoPrep = it })
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = c.rule)
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp)) {
            error?.let { Text(it, style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(bottom = 8.dp)) }
            Button(
                onClick = {
                    val f = folder
                    val input = MeetingInput(
                        // the folder is fixed once the meeting exists; a new one sends the picked pair
                        device = if (edit) null else f?.device,
                        cwd = if (edit) null else f?.cwd,
                        projectId = if (edit) null else f?.projectId,
                        title = titleText.trim().ifBlank { null },
                        agenda = purpose.trim(),
                        scheduledAt = if (datesShown) startMs else null,
                        durationMin = if (datesShown) duration else null,
                        tz = if (datesShown) zone.id else null,
                        steering = steering.trim(),
                        steeringPreset = preset,
                        answerLength = length,
                        reminders = if (datesShown) reminders else null,
                        autoPrep = if (datesShown) autoPrep else null,
                    )
                    vm.save(input) { onSaved(it.id) }
                },
                enabled = ready,
                colors = solidButtonColors(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Text(
                    when {
                        saving && edit -> "Saving..."
                        saving -> if (startNow) "Preparing..." else "Scheduling..."
                        edit -> "Save"
                        startNow -> "Prepare and start"
                        else -> "Schedule"
                    },
                )
            }
        }
    }
}

private val DATE_WORDS = DateTimeFormatter.ofPattern("EEE d MMM yyyy", Locale.UK)

/** The date and time in the owner's zone, with the zone named under it. Material 3 pickers, the time in 5 minute steps. */
@Composable
private fun DateTimeField(date: LocalDate, time: LocalTime, zone: ZoneId, onDate: (LocalDate) -> Unit, onTime: (LocalTime) -> Unit, problem: String?) {
    val c = Conclave.colors
    val context = LocalContext.current
    var pickDate by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf(false) }
    Column {
        Text("Date and time", style = ConclaveType.section, color = c.fg)
        Spacer(Modifier.padding(top = 6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { pickDate = true }, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.weight(3f).heightIn(min = 48.dp)) {
                Text(DATE_WORDS.format(date), style = ConclaveType.metaNum, maxLines = 1)
            }
            OutlinedButton(onClick = { pickTime = true }, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.weight(2f).heightIn(min = 48.dp)) {
                Text(Meetings.clock(date.atTime(time).atZone(zone).toInstant().toEpochMilli(), zone), style = ConclaveType.metaNum, maxLines = 1)
            }
        }
        Text("${zone.getDisplayName(TextStyle.FULL, Locale.getDefault())} (${zone.id})", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 4.dp))
        if (problem != null) Text(problem, style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(top = 2.dp))
    }
    if (pickDate) {
        // the picker counts days as UTC midnights: the day picked is the owner's day, not an instant
        val today = LocalDate.now(zone)
        val state = rememberDatePickerState(
            initialSelectedDateMillis = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean {
                    val d = Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate()
                    return !d.isBefore(today) && !d.isAfter(today.plusDays(365))
                }
            },
        )
        DatePickerDialog(
            onDismissRequest = { pickDate = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { onDate(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                    pickDate = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { pickDate = false }) { Text("Cancel") } },
        ) { DatePicker(state = state) }
    }
    if (pickTime) {
        val state = rememberTimePickerState(time.hour, time.minute, DateFormat.is24HourFormat(context))
        ConfirmDialog(
            title = "Time",
            text = "",
            confirmLabel = "OK",
            onConfirm = {
                // step 5 min, as the web's time input
                onTime(LocalTime.of(state.hour, (state.minute / 5) * 5))
                pickTime = false
            },
            onDismiss = { pickTime = false },
            extra = { TimePicker(state = state) },
        )
    }
}

@Composable
private fun DurationField(duration: Int?, onChange: (Int?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        Text("Duration", style = ConclaveType.section, color = Conclave.colors.fg)
        Spacer(Modifier.padding(top = 6.dp))
        Box {
            OutlinedButton(onClick = { open = true }, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(duration?.let { "$it min" } ?: "None", style = ConclaveType.metaNum)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                DropdownMenuItem(text = { Text("None") }, onClick = { onChange(null); open = false })
                Meetings.DURATIONS.forEach { d -> DropdownMenuItem(text = { Text("$d min") }, onClick = { onChange(d); open = false }) }
            }
        }
    }
}

/**
 * The folder picker (11.3.1): a filter over the known device and folder
 * pairs, newest first. Editing shows the folder as it is: it does not move.
 */
@Composable
private fun FolderField(folders: List<MeetingFolder>?, picked: MeetingFolder?, editing: Meeting?, onPick: (MeetingFolder) -> Unit) {
    val c = Conclave.colors
    var q by rememberSaveable { mutableStateOf("") }
    Column {
        Text("Project folder", style = ConclaveType.section, color = c.fg)
        Spacer(Modifier.padding(top = 6.dp))
        if (editing != null) {
            Text(Meetings.folderName(editing.cwd), style = ConclaveType.rowTitle, color = c.fg)
            Text(editing.cwd, style = CodeStyle, color = c.fg3)
            return@Column
        }
        if (picked != null) {
            Text(Meetings.folderLabel(picked), style = ConclaveType.rowTitle, color = c.fg)
            Text(picked.cwd, style = CodeStyle, color = c.fg3)
            if (!picked.online) {
                val name = picked.deviceName.ifBlank { picked.device }
                Text(
                    "$name is offline. Prep will read your chats now, and the code and git history only once $name is online.",
                    style = ConclaveType.meta,
                    color = c.warn,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            Spacer(Modifier.padding(top = 8.dp))
        }
        OutlinedTextField(
            value = q,
            onValueChange = { q = it },
            placeholder = { Text(if (picked == null) "Find a folder" else "Pick another folder") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        when {
            folders == null -> Text("Loading folders", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 6.dp))
            folders.isEmpty() -> Text("No folders yet. Start a Code session in a folder first.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 6.dp))
            else -> Meetings.filterFolders(folders, q).filter { it != picked }.take(if (picked == null || q.isNotBlank()) 8 else 0).forEach { f ->
                Column(Modifier.fillMaxWidth().clickable {
                    onPick(f)
                    q = ""
                }.padding(vertical = 8.dp)) {
                    val ago = if (f.lastAt > 0) " · ${Format.relative(f.lastAt)}" else ""
                    Text(Meetings.folderLabel(f) + ago, style = ConclaveType.body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(f.cwd, style = CodeStyle, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/**
 * How it should answer (11.3.3): the presets, the owner's text, and the
 * answer length. Picking a preset replaces the text, after a confirm when
 * the text was the owner's own; editing makes the preset "custom".
 */
@Composable
fun SteeringFields(
    presets: List<SteeringPreset>,
    text: String,
    preset: String?,
    length: String,
    minLines: Int,
    onText: (String, String?) -> Unit,
    onLength: (String) -> Unit,
) {
    val c = Conclave.colors
    var asking by remember { mutableStateOf<SteeringPreset?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("How it should answer", style = ConclaveType.section, color = c.fg)
        if (presets.isNotEmpty()) {
            // three to a row: the house switch shares the width, and five labels in one row would not read
            presets.chunked(3).forEach { row ->
                Segmented(
                    value = preset,
                    options = row.map { it.id to it.label },
                    onChange = { id ->
                        val p = row.first { it.id == id }
                        val own = text.isNotBlank() && presets.none { it.text == text }
                        if (own) asking = p else onText(p.text, p.id)
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        OutlinedTextField(
            value = text,
            onValueChange = { onText(it.take(Meetings.TEXT_MAX), "custom") },
            placeholder = { Text("Tone, length, what to stress and what to avoid.") },
            textStyle = CodeStyle,
            minLines = minLines,
            maxLines = 16,
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Answer length", style = ConclaveType.meta, color = c.fg2)
        Segmented(value = length, options = listOf("short" to "Short", "long" to "Longer"), onChange = onLength, modifier = Modifier.fillMaxWidth())
    }
    asking?.let { p ->
        ConfirmDialog(
            title = "Replace your text?",
            text = "Replace your text with the ${p.label} preset?",
            confirmLabel = "Replace",
            onConfirm = {
                onText(p.text, p.id)
                asking = null
            },
            onDismiss = { asking = null },
        )
    }
}
