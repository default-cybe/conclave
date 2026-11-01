@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.meetings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.EmptyState
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.StateWordText
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.deleteMeeting
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Meetings
import dev.conclave.client.logic.StateTone
import dev.conclave.client.meetings
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Meeting
import dev.conclave.client.model.PrepProgress
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Every meeting of the account, kept live from meeting.updated and meeting.prep (11.2). */
class MeetingsViewModel(hub: HubRepository) : HubViewModel(hub) {
    val meetings = MutableStateFlow<List<Meeting>?>(null)
    val error = MutableStateFlow<String?>(null)
    val refreshing = MutableStateFlow(false)

    /** Past pages with ?before=; false once a page comes back short. */
    val morePast = MutableStateFlow(false)

    init {
        load()
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.MeetingUpdated -> meetings.update { list -> list?.let { l -> l.filterNot { it.id == e.meeting.id } + e.meeting } }
                    is EngineEvent.MeetingPrep -> meetings.update { list ->
                        list?.map { if (it.id == e.meetingId) it.copy(prepState = e.state, prepProgress = e.progress ?: it.prepProgress) else it }
                    }
                    is EngineEvent.ConfigUpdated -> load()
                    else -> Unit
                }
            }
        }
    }

    fun load() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                // shortcut: the upcoming and running ones plus the first 20 of Past in one list; a hub with thousands pages Past only
                val now = hub.api { it.meetings(view = "all", limit = PAGE + 50) }
                meetings.value = now
                morePast.value = Meetings.sections(now, System.currentTimeMillis()).past.size >= PAGE
                error.value = null
            } catch (e: Exception) {
                error.value = errorText(e)
            } finally {
                refreshing.value = false
            }
        }
    }

    fun loadMorePast() = action {
        val list = meetings.value ?: return@action
        val oldest = Meetings.sections(list, System.currentTimeMillis()).past.lastOrNull()?.let { Meetings.pastKey(it) } ?: return@action
        val page = hub.api { it.meetings(view = "past", limit = PAGE, before = oldest) }
        meetings.value = (list + page).distinctBy { it.id }
        morePast.value = page.size >= PAGE
    }

    fun delete(m: Meeting) = action("Deleted ${m.title.ifBlank { "the meeting" }}") {
        hub.api { it.deleteMeeting(m.id) }
        meetings.update { list -> list?.filterNot { it.id == m.id } }
    }

    companion object {
        const val PAGE = 20
    }
}

/**
 * Meetings (docs/design/MEETING-MODE.md 11.2): Now, Upcoming and Past, with
 * Schedule (solid) and Start now under the title. A row opens the meeting.
 */
@Composable
fun MeetingsScreen(onOpen: (String) -> Unit, onSchedule: () -> Unit, onStartNow: () -> Unit, onReschedule: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: MeetingsViewModel = viewModel { MeetingsViewModel(hub) }
    val meetings by vm.meetings.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val morePast by vm.morePast.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    val list = meetings
    // a meeting under 10 minutes away ticks every second, else every minute
    val soonest = list?.mapNotNull { it.scheduledAt }?.filter { it > System.currentTimeMillis() }?.minOrNull()
    val now by rememberNow(soonest?.let { Meetings.tickMs(it - System.currentTimeMillis()) } ?: 60_000)
    val deviceName: (String) -> String? = { id -> devices.firstOrNull { it.id == id }?.name?.ifBlank { null } }
    var deleting by remember { mutableStateOf<Meeting?>(null) }
    val c = Conclave.colors

    Scaffold(topBar = { TopBar("Meetings") }, snackbarHost = { ToastHost(snackbar) }) { padding ->
        PullToRefreshBox(isRefreshing = refreshing && list != null, onRefresh = { vm.load() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            when {
                list == null && error != null -> Column(Modifier.padding(16.dp)) {
                    Text("Could not load meetings: $error", style = ConclaveType.body, color = c.fault)
                    TextButton(onClick = { vm.load() }) { Text("Retry") }
                }
                list == null -> LoadingBox()
                list.isEmpty() -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        EmptyState(
                            Icons.Outlined.Event,
                            "No meetings yet",
                            "Schedule one for a project folder, and Conclave prepares you from your chats and code.",
                            action = {
                                Button(onClick = onSchedule, colors = solidButtonColors(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Schedule a meeting") }
                            },
                        )
                    }
                }
                else -> {
                    val s = remember(list, now) { Meetings.sections(list, now) }
                    LazyColumn(Modifier.fillMaxSize()) {
                        item(key = "actions") { HeaderActions(onSchedule, onStartNow) }
                        section("Now", s.now) { m -> NowRow(m, deviceName, now, onClick = { onOpen(m.id) }) }
                        section("Upcoming", s.upcoming) { m -> UpcomingRow(m, deviceName, now, onClick = { onOpen(m.id) }) }
                        section("Past", s.past) { m ->
                            PastRow(m, deviceName, now, onClick = { onOpen(m.id) }, onReschedule = { onReschedule(m.id) }, onDelete = { deleting = m })
                        }
                        if (morePast && s.past.isNotEmpty()) {
                            item(key = "more") {
                                TextButton(onClick = { vm.loadMorePast() }, modifier = Modifier.padding(horizontal = 8.dp)) { Text("Show more") }
                            }
                        }
                    }
                }
            }
        }
    }
    deleting?.let { m ->
        ConfirmDialog(
            title = "Delete ${m.title.ifBlank { "this meeting" }}?",
            text = "Its prep, reminders and transcript go too.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                vm.delete(m)
                deleting = null
            },
            onDismiss = { deleting = null },
        )
    }
}

/** Schedule (the one solid button) and Start now, each half the width, under the title. */
@Composable
private fun HeaderActions(onSchedule: () -> Unit, onStartNow: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = onSchedule, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Schedule") }
        OutlinedButton(onClick = onStartNow, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Start now") }
    }
}

private fun LazyListScope.section(title: String, rows: List<Meeting>, row: @Composable (Meeting) -> Unit) {
    if (rows.isEmpty()) return
    item(key = "h-$title") { SectionHeader(title) }
    items(rows, key = { "$title-${it.id}" }) { m ->
        row(m)
        HorizontalDivider(thickness = 1.dp, color = Conclave.colors.rule, modifier = Modifier.padding(horizontal = 16.dp))
    }
}

/** The house list row: title and meta on the left, a time and the state word in fixed places on the right. */
@Composable
private fun MeetingRow(
    title: String,
    meta: String,
    time: String?,
    timeTone: StateTone,
    word: Pair<String, StateTone>,
    onClick: () -> Unit,
    below: (@Composable () -> Unit)? = null,
) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(Modifier.heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (meta.isNotBlank()) Text(meta, style = ConclaveType.metaNum, color = c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(12.dp))
            Column(horizontalAlignment = Alignment.End) {
                StateWordText(word.first, word.second)
                if (time != null) StateWordText(time, timeTone, style = ConclaveType.metaNum)
            }
        }
        below?.invoke()
    }
}

private fun titleOf(m: Meeting) = m.title.ifBlank { "Meeting" }

@Composable
private fun NowRow(m: Meeting, deviceName: (String) -> String?, now: Long, onClick: () -> Unit) {
    val time = m.scheduledAt?.let { Meetings.countdown(it - now, it, Meetings.zoneOf(m, null)) } ?: Format.relative(m.startedAt ?: m.createdAt, now)
    MeetingRow(titleOf(m), Meetings.place(m, deviceName), time, if (time == "now") StateTone.SIGNAL else StateTone.DIM, Meetings.statusWord(m, now), onClick)
}

@Composable
private fun UpcomingRow(m: Meeting, deviceName: (String) -> String?, now: Long, onClick: () -> Unit) {
    val zone = Meetings.zoneOf(m, null)
    val at = m.scheduledAt
    val time = at?.let { Meetings.countdown(it - now, it, zone) }
    MeetingRow(
        titleOf(m),
        Meetings.upcomingMeta(m, zone, deviceName),
        time,
        if (time == "now") StateTone.SIGNAL else StateTone.NEUTRAL,
        Meetings.prepWord(m),
        onClick,
        below = if (Meetings.prepRunning(m.prepState)) ({ PrepMeter(m.prepProgress, Modifier.padding(top = 6.dp)) }) else null,
    )
}

@Composable
private fun PastRow(m: Meeting, deviceName: (String) -> String?, now: Long, onClick: () -> Unit, onReschedule: () -> Unit, onDelete: () -> Unit) {
    val notHeld = Meetings.notHeld(m, now)
    MeetingRow(
        titleOf(m),
        Meetings.place(m, deviceName),
        Format.relative(Meetings.pastKey(m), now),
        StateTone.DIM,
        Meetings.statusWord(m, now),
        onClick,
        below = if (notHeld) ({
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onReschedule) { Text("Reschedule") }
                TextButton(onClick = onDelete) { Text("Delete", color = Conclave.colors.fault) }
            }
        }) else null,
    )
}

/** The prep meter: a 3dp bar in the meter colours, the done part in signal. */
@Composable
fun PrepMeter(p: PrepProgress?, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val f = Meetings.progressFraction(p) ?: 0f
    Box(modifier.fillMaxWidth().height(3.dp).background(c.meterOff)) {
        Box(Modifier.fillMaxWidth(f).fillMaxHeight().background(c.signal))
    }
}
