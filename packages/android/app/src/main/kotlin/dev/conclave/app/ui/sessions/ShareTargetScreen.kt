package dev.conclave.app.ui.sessions

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.data.SharePayload
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Drawer
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Panel
import dev.conclave.client.logic.ShareIn
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import dev.conclave.client.model.Session

/**
 * "Share to": where text and files shared from another app go, asked before
 * anything opens. What is shared and any file left out on top; then a new
 * conversation in Chat, Assistant or Code (Home, with the files in its box;
 * Code asks for its folder there as it always does); then every chat and
 * session, newest first, searchable, each marked with its mode. A pick opens
 * it with the files in the composer, unsent. Back drops the share.
 */
@Composable
fun ShareTargetScreen(
    share: SharePayload,
    onNew: (StartMode) -> Unit,
    onOpen: (Session) -> Unit,
    onCancel: () -> Unit,
) {
    val hub = LocalAppContainer.current.hub
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    val rows = remember(sessions, query) { ShareIn.targets(sessions, query) }
    val hasHome = remember(sessions) { Drawer.homeOf(sessions) != null }
    val c = Conclave.colors
    BackHandler(onBack = onCancel)

    // a Surface takes the touches, so nothing under the picker reacts
    Surface(Modifier.fillMaxSize(), color = c.bg) {
        Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
            TopBar("Share to", onBack = onCancel, newChat = false, inbox = false)
            OfflineBanner(connection)
            LazyColumn(Modifier.fillMaxSize()) {
                item(key = "what") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
                        Text(ShareIn.summary(share.attachments.size, share.text), style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg)
                        val names = share.attachments.mapNotNull { it.name }
                        if (names.isNotEmpty()) {
                            Text(names.joinToString(", "), style = ConclaveType.meta, color = c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        if (share.text.isNotBlank()) {
                            Text(share.text, style = ConclaveType.meta, color = c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        // files left out (not a kind the hub reads, too big, past 15): said here, never dropped silently
                        share.notes.forEach { note ->
                            Text(note, style = ConclaveType.meta, color = c.warn, modifier = Modifier.padding(top = 4.dp))
                        }
                    }
                }
                item(key = "new") { GroupLabel("New chat") }
                items(StartMode.entries, key = { "new:" + it.wire }) { m ->
                    NewRow(
                        mode = m,
                        line = when (m) {
                            StartMode.CHAT -> "A new chat"
                            StartMode.ASSISTANT -> if (hasHome) "Your assistant's thread" else "The assistant on your hub"
                            StartMode.CODE -> "A coding agent, in a folder you choose"
                        },
                        onClick = { onNew(m) },
                    )
                }
                item(key = "rule") { HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) }
                item(key = "search") { SearchField(query, onChange = { query = it }, placeholder = "Search chats and sessions") }
                if (rows.isEmpty()) {
                    item(key = "empty") {
                        Text(
                            if (query.isNotBlank()) "Nothing matches." else "No chats or sessions yet.",
                            style = ConclaveType.body,
                            color = c.fg3,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 32.dp),
                        )
                    }
                }
                items(rows, key = { "s:" + it.id }) { s -> TargetRow(s, onClick = { onOpen(s) }) }
                item(key = "foot") { Spacer(Modifier.size(24.dp)) }
            }
        }
    }
}

/** A new conversation in [mode]: its word, a line saying what it is. */
@Composable
private fun NewRow(mode: StartMode, line: String, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClickLabel = mode.newWords, onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(mode.label, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg)
            Text(line, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 2.dp))
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = c.fg3, modifier = Modifier.size(20.dp))
    }
}

/** A chat or session: its title with the time on its right, its mode under it. */
@Composable
private fun TargetRow(session: Session, onClick: () -> Unit) {
    val c = Conclave.colors
    Column(
        Modifier.fillMaxWidth().clickable(onClickLabel = "Add to this conversation", onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 20.dp, vertical = 10.dp),
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
        Text(Start.modeOf(session).label, style = ConclaveType.meta, color = c.fg3, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
    }
}
