@file:OptIn(ExperimentalFoundationApi::class)

package dev.conclave.app.ui.panel

import android.widget.Toast
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.data.HubProblem
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.Glyphs
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.hubName
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.home.ModeSwitch
import dev.conclave.app.ui.motion.Motion
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.update.waiting
import dev.conclave.client.ConnectionState
import dev.conclave.client.logic.Delegated
import dev.conclave.client.logic.DelegatedRow
import dev.conclave.client.logic.Drawer
import dev.conclave.client.logic.GroupBy
import dev.conclave.client.logic.Meetings
import dev.conclave.client.logic.Recent
import dev.conclave.client.logic.RecentDot
import dev.conclave.client.logic.StartMode
import dev.conclave.client.meetings
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Meeting
import dev.conclave.client.update.UpdatePrompt
import kotlinx.coroutines.launch

/**
 * The side panel, simple as the Claude app's: New and Search at the top
 * (Search becomes a field that narrows the list), the Chat, Assistant and
 * Code switch, then the conversations of that [mode] in groups (Group by:
 * project, device or time), Delegated work (a Delegate call's sessions, in
 * every mode, folding), and at the foot the account row (avatar, name,
 * the hub's state) that opens Settings. Every other page is in Settings,
 * except Meetings under Search (docs/design/MEETING-MODE.md 11.1); the
 * Inbox count is in the top bar. [currentId] marks the open
 * conversation, [inSettings] the account row. Closed ([open] false), the
 * panel lets go of its search, and so of the keyboard.
 */
@Composable
fun SidePanel(
    currentId: String?,
    inSettings: Boolean,
    mode: StartMode,
    onMode: (StartMode) -> Unit,
    onNew: () -> Unit,
    onOpen: (id: String, chat: Boolean) -> Unit,
    onSettings: () -> Unit,
    modifier: Modifier = Modifier,
    open: Boolean = true,
    inMeetings: Boolean = false,
    onMeetings: () -> Unit = {},
) {
    val container = LocalAppContainer.current
    val hub = container.hub
    val c = Conclave.colors
    val scope = rememberCoroutineScope()
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val approvals by hub.approvals.collectAsStateWithLifecycle()
    val questions by hub.questions.collectAsStateWithLifecycle()
    val projects by hub.projects.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val by = settings?.drawerGroup ?: GroupBy.PROJECT
    val waitingIds = remember(approvals, questions) { (approvals.map { it.sessionId } + questions.map { it.sessionId }).toSet() }
    // Search: a field in place of its row, until closed or a conversation opens
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val groups = remember(sessions, waitingIds, mode, by, projects, devices, searching, query) {
        Drawer.groups(sessions, mode, by, waitingIds, projects, devices, query = if (searching) query else "")
    }
    // Delegated work: its own group in every mode; Search looks in it too, folded or not
    val delegated = remember(sessions, waitingIds, devices, searching, query) {
        Drawer.delegated(sessions, waitingIds, devices, query = if (searching) query else "")
    }
    // Assistant mode: the hub makes its home thread on the first ask; an older hub answers null (404) and the list stays as it was
    val hasHome = remember(sessions) { Drawer.homeOf(sessions) != null }
    LaunchedEffect(mode, hasHome) {
        if (mode == StartMode.ASSISTANT && !hasHome) runCatching { hub.api { it.assistantHome() } }.getOrNull()?.let { hub.putSession(it) }
    }
    var delegatedFolded by rememberSaveable { mutableStateOf(false) }
    // long press on a conversation: Delete, after a confirm
    var deleting by remember { mutableStateOf<Recent?>(null) }
    val context = LocalContext.current
    val finding = searching && query.isNotBlank()
    fun endSearch() {
        searching = false
        query = ""
    }
    LaunchedEffect(open) { if (!open) endSearch() }

    Column(modifier.fillMaxHeight().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Column(Modifier.padding(horizontal = 8.dp, vertical = 8.dp)) {
            // the home thread is the one Assistant conversation: no New in Assistant mode then
            if (!(mode == StartMode.ASSISTANT && hasHome)) {
                PanelRow("New", selected = false, onClick = {
                    endSearch()
                    onNew()
                }, strong = true, leading = {
                    Icon(Glyphs.NewChat, contentDescription = null, tint = c.fg2, modifier = Modifier.size(20.dp))
                })
            }
            if (searching) {
                SearchField(query, onChange = { query = it }, onClose = ::endSearch)
            } else {
                PanelRow("Search", selected = false, onClick = { searching = true }, strong = true, leading = {
                    Icon(Icons.Outlined.Search, contentDescription = null, tint = c.fg2, modifier = Modifier.size(20.dp))
                })
            }
            MeetingsRow(open, selected = inMeetings, onClick = {
                endSearch()
                onMeetings()
            })
            ModeSwitch(mode, onChange = onMode, modifier = Modifier.padding(start = 4.dp, top = 12.dp))
        }

        LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 8.dp)) {
            item(key = "group-by") {
                GroupByRow(by, onPick = { next -> scope.launch { container.settings.setDrawerGroup(next) } })
            }
            if (groups.isEmpty() && !(finding && delegated.isNotEmpty())) {
                item(key = "empty") {
                    Text(
                        when {
                            finding -> "Nothing matches."
                            mode == StartMode.CHAT -> "No chats yet."
                            else -> "No sessions yet."
                        },
                        style = ConclaveType.meta,
                        color = c.fg3,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }
            groups.forEach { g ->
                item(key = "h:" + g.key) {
                    Text(
                        g.title,
                        style = ConclaveType.meta.copy(fontSize = 12.sp),
                        color = c.fg3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 2.dp).semantics { heading() },
                    )
                }
                items(g.items, key = { "s:" + g.key + ":" + it.id }) { r ->
                    PanelRow(
                        r.title,
                        selected = r.id == currentId,
                        onClick = {
                            endSearch()
                            onOpen(r.id, r.chat)
                        },
                        onLongClick = { deleting = r },
                        trailing = {
                            // an imported chat's source and original date (Imported.kt)
                            r.note?.let { Text(it, style = ConclaveType.meta.copy(fontSize = 12.sp), color = c.fg3, maxLines = 1) }
                            Dot(r.dot)
                        },
                    )
                }
            }
            if (delegated.isNotEmpty()) {
                val shown = !delegatedFolded || finding
                item(key = "h:delegated") {
                    DelegatedHeading(open = shown, onToggle = { delegatedFolded = !delegatedFolded })
                }
                if (shown) {
                    items(delegated, key = { "d:" + it.id }) { r ->
                        DelegatedPanelRow(r, selected = r.id == currentId, onClick = {
                            endSearch()
                            onOpen(r.id, false)
                        })
                    }
                }
            }
            item(key = "foot") { Spacer(Modifier.size(12.dp)) }
        }

        HorizontalDivider(thickness = 1.dp, color = c.rule)
        AccountRow(selected = inSettings, onClick = onSettings)
    }
    deleting?.let { r ->
        val what = if (r.chat) "chat" else "session"
        ConfirmDialog(
            title = "Delete $what?",
            text = "“${r.title}” and its messages are deleted on the hub.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                deleting = null
                scope.launch {
                    runCatching { hub.api { it.deleteSession(r.id) } }
                        .onSuccess {
                            hub.sessions.value = hub.sessions.value.filterNot { it.id == r.id }
                            if (r.id == currentId) onNew()
                        }
                        .onFailure { Toast.makeText(context, "Could not delete: ${it.message}", Toast.LENGTH_LONG).show() }
                }
            },
            onDismiss = { deleting = null },
        )
    }
}

/** "Delegated work" and its chevron: a tap folds the group (Search opens it while it looks). */
@Composable
private fun DelegatedHeading(open: Boolean, onToggle: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 12.dp)
            .heightIn(min = 40.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClickLabel = if (open) "Fold" else "Show", onClick = onToggle)
            .semantics {
                heading()
                stateDescription = if (open) "Shown" else "Folded"
            }
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(Delegated.WORDS, style = ConclaveType.meta.copy(fontSize = 12.sp), color = c.fg3, maxLines = 1, modifier = Modifier.weight(1f, fill = false))
        Spacer(Modifier.width(4.dp))
        Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null, tint = c.fg3, modifier = Modifier.size(16.dp).rotate(if (open) 0f else -90f))
    }
}

/**
 * A row of Delegated work: the title and its dot, then a quiet second line
 * with who did it and where and the conversation it came from ("Code on
 * MadX Arch, from Capstone chat"), as on the web. 56dp to touch; the open
 * one on a fill.
 */
@Composable
private fun DelegatedPanelRow(r: DelegatedRow, selected: Boolean, onClick: () -> Unit) {
    val c = Conclave.colors
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) c.surface2 else Color.Transparent)
            .clickable(onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(r.title, style = ConclaveType.body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (r.dot != RecentDot.NONE) {
                Spacer(Modifier.width(8.dp))
                Dot(r.dot)
            }
        }
        Text(
            if (r.from != null) "${r.who}, ${r.from}" else r.who,
            style = ConclaveType.meta,
            color = c.fg3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Search, open: the field with its focus, and X to close it. */
@Composable
private fun SearchField(value: String, onChange: (String) -> Unit, onClose: () -> Unit) {
    val c = Conclave.colors
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(c.surface2)
            .padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = c.fg3, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = ConclaveType.body.copy(fontSize = 16.sp, color = c.fg),
            cursorBrush = SolidColor(c.signal),
            modifier = Modifier.weight(1f).focusRequester(focus).semantics { contentDescription = "Search" },
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text("Search", style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg3, maxLines = 1)
                    inner()
                }
            },
        )
        IconButton(onClick = onClose, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Outlined.Close, contentDescription = "Close search", tint = c.fg3, modifier = Modifier.size(18.dp))
        }
    }
}

/** "Group by" and the choice in words; a tap opens Project, Device and Time. */
@Composable
private fun GroupByRow(by: GroupBy, onPick: (GroupBy) -> Unit) {
    val c = Conclave.colors
    var open by remember { mutableStateOf(false) }
    Box(Modifier.padding(top = 8.dp)) {
        Row(
            Modifier
                .heightIn(min = 40.dp)
                .clip(RoundedCornerShape(10.dp))
                .clickable(onClickLabel = "Group by") { open = true }
                .semantics { contentDescription = "Group by, ${by.label}" }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Group by", style = ConclaveType.meta, color = c.fg3)
            Spacer(Modifier.width(6.dp))
            Text(by.label, style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium), color = c.fg2)
            Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null, tint = c.fg3, modifier = Modifier.size(16.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            GroupBy.entries.forEach { g ->
                DropdownMenuItem(
                    text = { Text(g.label) },
                    trailingIcon = { if (g == by) Icon(Icons.Filled.Check, contentDescription = "Selected", modifier = Modifier.size(18.dp)) },
                    onClick = {
                        open = false
                        onPick(g)
                    },
                )
            }
        }
    }
}

/**
 * Meetings, with "Live" in fault red while one listens, else the countdown
 * to the next one within a day. The list is read while the panel is open
 * and again when a meeting changes; a hub without meetings shows the row bare.
 */
@Composable
private fun MeetingsRow(open: Boolean, selected: Boolean, onClick: () -> Unit) {
    val c = Conclave.colors
    val hub = LocalAppContainer.current.hub
    var list by remember { mutableStateOf<List<Meeting>>(emptyList()) }
    LaunchedEffect(open) {
        if (!open) return@LaunchedEffect
        list = runCatching { hub.api { it.meetings(view = "all", limit = 50) } }.getOrElse { list }
        hub.events.collect { e ->
            if (e is EngineEvent.MeetingUpdated) list = list.filterNot { it.id == e.meeting.id } + e.meeting
        }
    }
    val now by rememberNow(60_000)
    val meta = remember(list, now) { Meetings.panelMeta(list, now) }
    PanelRow("Meetings", selected = selected, onClick = onClick, strong = true, leading = {
        Icon(Icons.Outlined.Event, contentDescription = null, tint = c.fg2, modifier = Modifier.size(20.dp))
    }, trailing = if (meta == null) null else {
        { Text(meta, style = ConclaveType.metaNum, color = if (meta == "Live") c.fault else c.fg3, maxLines = 1) }
    })
}

/** One row of the panel: 48dp to touch, the open conversation on a quiet fill. */
@Composable
private fun PanelRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    strong: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
) {
    val c = Conclave.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) c.surface2 else Color.Transparent)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick, onLongClickLabel = onLongClick?.let { "Delete" })
            .semantics { this.selected = selected }
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(12.dp))
        }
        Text(
            label,
            style = if (strong) ConclaveType.rowTitle.copy(fontSize = 16.sp) else ConclaveType.body,
            color = c.fg,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            trailing()
        }
    }
}

/**
 * A conversation's dot: a small violet one that breathes while it runs, the
 * accent while it waits on you. Still when animations are off.
 */
@Composable
fun Dot(dot: RecentDot, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    when (dot) {
        RecentDot.NONE -> Unit
        RecentDot.WAITING -> Box(modifier.size(7.dp).background(c.warn, CircleShape).semantics { contentDescription = "Waiting for you" })
        RecentDot.RUNNING -> {
            val still = modifier.size(7.dp).background(c.signal, CircleShape).semantics { contentDescription = "Running" }
            if (reducedMotion()) {
                Box(still)
            } else {
                val pulse = rememberInfiniteTransition(label = "dot")
                val alpha = pulse.animateFloat(0.35f, 1f, infiniteRepeatable(tween(900, easing = Motion.Ease), RepeatMode.Reverse), label = "dot-alpha")
                // read in the layer, so the breathing never recomposes the panel
                Box(Modifier.graphicsLayer { this.alpha = alpha.value }.then(still))
            }
        }
    }
}

/**
 * The account row at the foot: the avatar with the owner's first letter, the
 * name, and the hub with its state ("homelab · online"). A tap opens
 * Settings. A small dot on the avatar when the app's update waits and was
 * not skipped (client UpdatePrompt).
 */
@Composable
private fun AccountRow(selected: Boolean, onClick: () -> Unit) {
    val container = LocalAppContainer.current
    val hub = container.hub
    val c = Conclave.colors
    val owner by hub.ownerName.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val problem by hub.problem.collectAsStateWithLifecycle()
    val update by container.updates.state.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val account = Drawer.account(owner, hubName(), connection, noNetwork = problem == HubProblem.NoNetwork)
    val dot = UpdatePrompt.showDot(update.waiting, settings?.updateSkipped)
    val state = when (connection) {
        ConnectionState.OPEN -> c.ok
        ConnectionState.CONNECTING -> c.fg3
        ConnectionState.CLOSED -> c.fault
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 8.dp)
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) c.surface2 else Color.Transparent)
            .clickable(onClickLabel = "Settings", onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Box(Modifier.size(36.dp).background(c.surface2, CircleShape), contentAlignment = Alignment.Center) {
                Text(account.initial, style = ConclaveType.rowTitle, color = c.fg)
            }
            if (dot) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 2.dp, y = (-2).dp)
                        .size(11.dp)
                        .border(2.dp, c.bg, CircleShape)
                        .padding(2.dp)
                        .background(c.signal, CircleShape)
                        .semantics { contentDescription = "Update available" },
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(account.name, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).background(state, CircleShape))
                Spacer(Modifier.width(6.dp))
                Text(account.line, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
