@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package dev.conclave.app.ui.sessions

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.rememberClock
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Lists
import dev.conclave.client.logic.Panel
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus

/**
 * Chats ([chats]) or Code, or the archive of either ([archived]) (MOBILE-V2
 * 6): a search field, then the rows by last activity. A row is its title
 * with the time on its right, and a second line only when it says
 * something ("Running", "Waiting for you", "Failed"). Archived is a row at
 * the end. A long press offers Pin, Rename, Archive and Delete.
 */
@Composable
fun SessionsScreen(
    chats: Boolean,
    archived: Boolean,
    onOpen: (String) -> Unit,
    onOpenArchive: () -> Unit,
    onBack: (() -> Unit)?,
) {
    val hub = LocalAppContainer.current.hub
    val vm: SessionsViewModel = viewModel(key = "list:$chats:$archived") { SessionsViewModel(hub, chats, archived) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    var renaming by remember { mutableStateOf<Session?>(null) }
    var deleting by remember { mutableStateOf<Session?>(null) }
    val c = Conclave.colors
    val title = when {
        archived -> "Archived"
        chats -> "Chats"
        else -> "Code"
    }

    Scaffold(
        topBar = { TopBar(title, onBack = onBack) },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = c.bg,
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OfflineBanner(connection)
            SearchField(query, onChange = { vm.query.value = it }, placeholder = if (chats) "Search chats" else "Search sessions")
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.fillMaxSize()) {
                LazyColumn(Modifier.fillMaxSize()) {
                    if (ui.total == 0 && ui.messageHits.isEmpty()) {
                        item(key = "empty") {
                            Text(
                                when {
                                    query.isNotBlank() -> "Nothing matches."
                                    archived -> "Nothing archived."
                                    chats -> "No chats yet. Ask anything on Home to start one."
                                    else -> "No sessions yet. On Home, switch to Code and describe a task."
                                },
                                style = ConclaveType.body,
                                color = c.fg3,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 40.dp),
                            )
                        }
                    }
                    ui.groups.forEachIndexed { i, group ->
                        // separators between groups, never round them
                        if (i > 0) item(key = "rule:" + group.key) { HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) }
                        item(key = "h:" + group.key) { GroupLabel(group.title) }
                        items(group.sessions, key = { "s:" + group.key + ":" + it.id }) { s ->
                            ListRow(
                                session = s,
                                onOpen = { onOpen(s.id) },
                                onPin = { vm.togglePin(s) },
                                onRename = { renaming = s },
                                onArchive = { vm.archive(s, archive = !s.archived) },
                                onDelete = { deleting = s },
                            )
                        }
                    }
                    if (ui.messageHits.isNotEmpty()) {
                        item(key = "hits") { GroupLabel("In messages") }
                        items(ui.messageHits.distinctBy { it.sessionId + "/" + it.messageId }, key = { "hit:" + it.sessionId + "/" + it.messageId }) { hit ->
                            Column(Modifier.fillMaxWidth().clickable { onOpen(hit.sessionId) }.heightIn(min = 56.dp).padding(horizontal = 20.dp, vertical = 8.dp)) {
                                Text(hit.title.ifBlank { if (chats) "New chat" else "New session" }, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(hit.snippet, style = ConclaveType.meta, color = c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    if (!archived && query.isBlank()) {
                        item(key = "archived") { ArchivedRow(onOpenArchive) }
                    }
                    item(key = "foot") { Spacer(Modifier.size(24.dp)) }
                }
            }
        }
    }

    deleting?.let { s ->
        ConfirmDialog(
            title = if (s.isChat) "Delete chat?" else "Delete session?",
            text = "“${Panel.title(s)}” and its messages are deleted on the hub.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                vm.delete(s)
                deleting = null
            },
            onDismiss = { deleting = null },
        )
    }
    renaming?.let { s ->
        var text by remember(s.id) { mutableStateOf(s.title) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename") },
            text = { OutlinedTextField(value = text, onValueChange = { text = it }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = {
                    vm.rename(s, text)
                    renaming = null
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } },
        )
    }
}

/** The search field at the top of a list: a quiet rounded field, X to clear. */
@Composable
internal fun SearchField(value: String, onChange: (String) -> Unit, placeholder: String) {
    val c = Conclave.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 6.dp)
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(c.surface2)
            .padding(start = 14.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = c.fg3, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = ConclaveType.body.copy(fontSize = 16.sp, color = c.fg),
            cursorBrush = SolidColor(c.signal),
            modifier = Modifier.weight(1f).semantics { contentDescription = placeholder },
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text(placeholder, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg3, maxLines = 1)
                    inner()
                }
            },
        )
        if (value.isNotEmpty()) {
            IconButton(onClick = { onChange("") }, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Outlined.Close, contentDescription = "Clear search", tint = c.fg3, modifier = Modifier.size(18.dp))
            }
        } else {
            Spacer(Modifier.size(48.dp))
        }
    }
}

@Composable
internal fun GroupLabel(text: String) {
    Text(text, style = ConclaveType.meta, color = Conclave.colors.fg3, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 4.dp))
}

/** A row: the title (16sp), the time on its right in fg-3, and a second line only when it says something. */
@Composable
private fun ListRow(
    session: Session,
    onOpen: () -> Unit,
    onPin: () -> Unit,
    onRename: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
) {
    val c = Conclave.colors
    var menu by remember { mutableStateOf(false) }
    val line = Lists.stateLine(session, rememberClock())
    Box {
        Column(
            Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onOpen, onLongClick = { menu = true }, onLongClickLabel = "More")
                .heightIn(min = 56.dp)
                .padding(horizontal = 20.dp, vertical = 10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    Panel.title(session),
                    style = ConclaveType.body.copy(fontSize = 16.sp),
                    color = c.fg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(12.dp))
                Text(Format.relative(session.updatedAt), style = ConclaveType.metaNum, color = c.fg3, maxLines = 1)
            }
            if (line != null) {
                Text(
                    line,
                    style = ConclaveType.meta,
                    color = when (session.status) {
                        SessionStatus.RUNNING -> c.signal
                        SessionStatus.WAITING_APPROVAL, SessionStatus.WAITING_INPUT -> c.warn
                        SessionStatus.ERROR -> c.fault
                        else -> c.fg3
                    },
                    maxLines = 1,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (!session.archived) DropdownMenuItem(text = { Text(if (session.pinned) "Unpin" else "Pin") }, onClick = { menu = false; onPin() })
            DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; onRename() })
            DropdownMenuItem(text = { Text(if (session.archived) "Restore" else "Archive") }, onClick = { menu = false; onArchive() })
            DropdownMenuItem(text = { Text("Delete", color = c.fault) }, onClick = { menu = false; onDelete() })
        }
    }
}

/** Archived, the last row of a list. */
@Composable
private fun ArchivedRow(onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp).clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Archived", style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg2, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = c.fg3, modifier = Modifier.size(20.dp))
    }
}
