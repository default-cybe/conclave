package dev.conclave.app.ui.friends

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.chat.DiffView
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MarkdownText
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.SectionHeader
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
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.logic.Diffs
import dev.conclave.client.logic.FriendTone
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.logic.ModelRefs
import dev.conclave.client.logic.QuotedUnit
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.model.ReceivedShareDto
import dev.conclave.client.model.SentShareDto
import dev.conclave.client.model.ShareViewDto
import dev.conclave.client.model.ShareViewMessage
import dev.conclave.client.receivedShare
import dev.conclave.client.viewShare
import kotlinx.coroutines.CancellationException

/**
 * Shares (docs/DESIGN.md 26; the web's /shares): what friends sent, waiting
 * first, and what you sent, with Update and Unsend. Nothing a friend sends
 * is fetched before you accept it. A page under Friends.
 */
@Composable
fun SharesScreen(onBack: () -> Unit, onOpenShare: (String) -> Unit, onOpenSession: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: FriendsViewModel = viewModel(key = "shares") { FriendsViewModel(hub) }
    val received by hub.receivedShares.collectAsStateWithLifecycle()
    val sent by hub.sentShares.collectAsStateWithLifecycle()
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val now by rememberNow(60_000)
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    val inbox = remember(received) { ShareWords.receivedOrder(received) }
    val out = remember(sent) { ShareWords.sentOrder(sent) }
    val waiting = inbox.count { FriendWords.shareWaiting(it) }
    var updating by remember { mutableStateOf<SentShareDto?>(null) }
    val c = Conclave.colors

    Scaffold(
        topBar = { TopBar("Shares", onBack = onBack) },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = c.bg,
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OfflineBanner(connection)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
                Text(
                    "Chats and sessions friends sent you, and the ones you sent them. Nothing a friend sends is fetched before you accept it.",
                    style = ConclaveType.body,
                    color = c.fg3,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
                )
                SectionHeader("From friends", trailing = { if (waiting > 0) Text(waiting.toString(), style = ConclaveType.metaNum, color = c.warn) })
                if (inbox.isEmpty()) {
                    Text("Nothing yet. When a friend sends you a chat or a session, it lands in your Inbox and here.", style = ConclaveType.body, color = c.fg3, modifier = Modifier.padding(16.dp))
                }
                inbox.forEach { s -> ReceivedRow(s, now, onOpen = { onOpenShare(s.id) }) }

                SectionHeader("Sent", trailing = { if (out.isNotEmpty()) Text(out.size.toString(), style = ConclaveType.metaNum, color = c.fg3) })
                if (out.isEmpty()) {
                    Text("You have not sent a share. Send a chat or a session from its sheet, Send to friend.", style = ConclaveType.body, color = c.fg3, modifier = Modifier.padding(16.dp))
                }
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    out.forEach { s ->
                        SentShareCard(
                            s,
                            sessions = sessions,
                            onOpenSession = { onOpenSession(it.id) },
                            onUpdate = { updating = s },
                            onUnsend = { vm.unsendShare(s) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
    updating?.let { s ->
        val own = sessions.firstOrNull { it.id == s.sessionId }
        SendToFriendSheet(sessionId = s.sessionId, title = own?.title ?: s.title, chat = own?.isChat ?: (s.kind == "chat"), update = s, onDismiss = { updating = null })
    }
}

@Composable
private fun ReceivedRow(s: ReceivedShareDto, now: Long, onOpen: () -> Unit) {
    val c = Conclave.colors
    val w = ShareWords.received(s, now)
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).heightIn(min = 60.dp).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Text(s.title, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("From ${s.friendName}. ${ShareWords.summaryText(s.kind, s.summary)}", style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(12.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(FriendWords.agoText(s.receivedAt, now), style = ConclaveType.metaNum, color = c.fg3)
            Text(w.word, style = ConclaveType.meta, color = friendTone(w.tone))
            ShareArrived(s.id, size = 12.dp)
        }
    }
}

// ---------------------------------------------------------------------------
// One share from a friend
// ---------------------------------------------------------------------------

/**
 * One share from a friend: Accept and Decline while it waits; once
 * accepted, the conversation read only and marked as quoted from the
 * friend's hub, the code's diff, and Continue as fork, Handoff, Apply code
 * and Use as reference. An unsent or expired share says so.
 */
@Composable
fun ShareScreen(id: String, onBack: () -> Unit, onOpenSession: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: FriendsViewModel = viewModel(key = "share:$id") { FriendsViewModel(hub) }
    val received by hub.receivedShares.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    val s = received.firstOrNull { it.id == id }
    var missing by remember { mutableStateOf(false) }
    // the share from the hub when the shared list does not hold it
    LaunchedEffect(id, s == null) {
        if (s != null) return@LaunchedEffect
        try {
            hub.putReceivedShare(hub.api { it.receivedShare(id) })
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            missing = true
        }
    }
    // the read only view, once accepted, again when a new revision is fetched
    var view by remember { mutableStateOf<ShareViewDto?>(null) }
    var viewError by remember { mutableStateOf<String?>(null) }
    val ready = s?.state == "accepted"
    LaunchedEffect(ready, s?.acceptedRevision) {
        if (!ready) return@LaunchedEffect
        viewError = null
        try {
            view = hub.api { it.viewShare(id) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            viewError = if (e is ConclaveApiException && e.status == 404) "This share is not on this hub any more." else errorText(e)
        }
    }
    val c = Conclave.colors
    Scaffold(
        topBar = { TopBar(s?.title ?: if (missing) "Share" else "", onBack = onBack, newChat = false) },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = c.bg,
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OfflineBanner(connection)
            when {
                s != null -> ShareBody(s, vm, if (ready) view else null, if (ready) viewError else null, onOpenSession)
                missing -> Text("This share is not on this hub.", style = ConclaveType.body, color = c.fg2, modifier = Modifier.padding(20.dp))
                else -> LoadingBox()
            }
        }
    }
}

@Composable
private fun ShareBody(s: ReceivedShareDto, vm: FriendsViewModel, view: ShareViewDto?, error: String?, onOpenSession: (String) -> Unit) {
    val c = Conclave.colors
    val now by rememberNow(60_000)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 40.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "${s.friendName} sent it ${FriendWords.agoText(s.receivedAt, now)}. ${ShareWords.summaryText(s.kind, s.summary)}" + (if (s.revision > 1) ", revision ${s.revision}" else "") + ".",
                style = ConclaveType.body,
                color = c.fg2,
            )
            s.note?.takeIf { it.isNotBlank() }?.let { note ->
                Barred(c.rule2) { Text(note, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg) }
            }
        }
        StateBlock(s, vm)
        if (s.state == "accepted") {
            when {
                error != null -> Text(error, style = ConclaveType.body, color = c.fault)
                view == null -> LoadingBox(Modifier.heightIn(min = 80.dp))
                else -> AcceptedShare(s, view, vm, onOpenSession)
            }
        }
        MadeFrom(s, onOpenSession)
    }
}

/** How the share stands, with what can be done about it now. */
@Composable
private fun StateBlock(s: ReceivedShareDto, vm: FriendsViewModel) {
    val c = Conclave.colors
    val now by rememberNow(60_000)
    val busy by vm.busy.collectAsStateWithLifecycle()
    if (s.state == "accepted" && !s.updateWaiting) return
    val w = ShareWords.received(s, now)
    val answer = FriendWords.shareWaiting(s) || s.state == "declined" || s.state == "fetching"
    Barred(if (w.tone == FriendTone.WARN) c.warn else c.rule2) {
        Text(w.word, style = ConclaveType.rowTitle.copy(fontSize = 16.sp), color = if (w.tone == FriendTone.DIM) c.fg else friendTone(w.tone))
        w.line?.let { Text(it, style = ConclaveType.body, color = c.fg2, modifier = Modifier.padding(top = 4.dp)) }
        if (s.state == "offered") {
            Text(
                "Accept fetches it from ${s.friendName}'s hub and checks their key signed it. Then you can read it, continue it or apply its code.",
                style = ConclaveType.meta.copy(fontSize = 14.sp),
                color = c.fg3,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        if (answer) {
            AnswerPair(
                no = "Decline",
                yes = ShareWords.acceptLabel(s),
                busyNo = if ("decline:${s.id}" in busy) "Declining" else null,
                busyYes = if ("accept:${s.id}" in busy || s.state == "fetching") "Fetching" else null,
                onNo = if (s.state == "offered") ({ vm.declineShare(s) }) else null,
                onYes = { vm.acceptShare(s, quiet = true) },
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}

private enum class Ask { FORK, HANDOFF, REFERENCE, APPLY }

@Composable
private fun AcceptedShare(s: ReceivedShareDto, view: ShareViewDto, vm: FriendsViewModel, onOpenSession: (String) -> Unit) {
    val c = Conclave.colors
    var ask by remember { mutableStateOf<Ask?>(null) }
    val ok = view.verified.ok
    val root = view.sessions.firstOrNull { it.parentId == null } ?: view.sessions.firstOrNull()
    val subs = view.sessions.filter { it !== root }
    // a phone: the fork across, the rest two by two under it
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { ask = Ask.FORK }, enabled = ok, colors = solidButtonColors(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Continue as fork") }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { ask = Ask.HANDOFF }, enabled = ok, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Handoff") }
            if (view.code != null) {
                OutlinedButton(onClick = { ask = Ask.APPLY }, enabled = ok, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Apply code") }
            } else {
                OutlinedButton(onClick = { ask = Ask.REFERENCE }, enabled = ok, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Use as reference") }
            }
        }
        if (view.code != null) {
            OutlinedButton(onClick = { ask = Ask.REFERENCE }, enabled = ok, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Use as reference") }
        }
        Text("Continue as fork starts a new ${if (s.kind == "chat") "chat" else "session"} on your models. ${ShareWords.FORK_LINE}", style = ConclaveType.meta, color = c.fg3)
    }

    Column {
        SectionTitle("Conversation", root?.messages?.size)
        Provenance(s, view)
        root?.let { Quoted(it.messages, s.friendName) }
        subs.forEach { x ->
            Text("Subagent: ${x.title}", style = ConclaveType.rowTitle.copy(fontWeight = FontWeight.SemiBold), color = c.fg, modifier = Modifier.padding(top = 20.dp))
            Quoted(x.messages, s.friendName)
        }
    }

    view.code?.let { code ->
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionTitle("Code", null)
            Text(
                ShareWords.codeWords(code.kind, code.files.size, code.branch) + (if (code.kind == "git-bundle" && code.base != null) ", from ${code.base!!.take(10)}" else "") +
                    ". Apply code puts it on a new branch after you approve the plan.",
                style = ConclaveType.body,
                color = c.fg2,
            )
            code.excluded.forEach { e -> Text("Left out on their side: ${e.path} (${e.reason})", style = ConclaveType.meta, color = c.fg3) }
            val diff = code.diff
            if (!diff.isNullOrBlank()) {
                DiffView(remember(diff) { Diffs.parse(diff) })
            } else {
                code.files.forEach { Text(it, style = CodeStyle, color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
    }

    when (ask) {
        Ask.FORK -> ForkSheet(s, vm, onDone = { sid ->
            ask = null
            onOpenSession(sid)
        }, onDismiss = { ask = null })
        Ask.HANDOFF -> HandoffSheet(s, vm, onDone = { sid ->
            ask = null
            onOpenSession(sid)
        }, onDismiss = { ask = null })
        Ask.REFERENCE -> ReferenceDialog(s, onConfirm = {
            ask = null
            vm.referenceShare(s)
        }, onDismiss = { ask = null })
        Ask.APPLY -> ApplySheet(s, view.code, onDismiss = { ask = null })
        null -> Unit
    }
}

@Composable
private fun SectionTitle(text: String, count: Int?) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, style = ConclaveType.section, color = c.fg)
            count?.let { Text(" $it", style = ConclaveType.metaNum, color = c.fg3) }
        }
        androidx.compose.material3.HorizontalDivider(thickness = 1.dp, color = c.rule2)
    }
}

/** Where the turns come from, and whether the signature checks out against the friend's key. */
@Composable
private fun Provenance(s: ReceivedShareDto, view: ShareViewDto) {
    val c = Conclave.colors
    Column(Modifier.padding(top = 10.dp, bottom = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (view.verified.ok) {
                Icon(Icons.Outlined.VerifiedUser, contentDescription = null, tint = c.ok, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Quoted from ${s.friendName}'s hub, signed by their key", style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium), color = c.ok)
            } else {
                Icon(Icons.Outlined.GppMaybe, contentDescription = null, tint = c.fault, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("The signature does not check out: ${view.verified.reason ?: "unknown"}. Accept it again.", style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium), color = c.fault)
            }
        }
        if (view.provenance.isNotBlank()) Text(view.provenance, style = ConclaveType.meta, color = c.fg3)
    }
}

/** A shared conversation as quoted turns: the friend's asks in bubbles, their assistant's words and a line for its tool calls. */
@Composable
private fun Quoted(messages: List<ShareViewMessage>, friend: String) {
    val c = Conclave.colors
    val units = remember(messages) { ShareWords.quotedUnits(messages) }
    if (units.isEmpty()) {
        Text("No messages in the range they shared.", style = ConclaveType.body, color = c.fg3, modifier = Modifier.padding(vertical = 12.dp))
        return
    }
    Barred(c.rule2, Modifier.padding(top = 12.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            units.forEach { u ->
                when (u) {
                    is QuotedUnit.User -> Column {
                        Text(friend, style = ConclaveType.meta, color = c.fg3)
                        Text(
                            u.text.ifEmpty { if (u.attachments == 1) "1 attachment" else "${u.attachments} attachments" },
                            style = ConclaveType.chat,
                            color = c.fg,
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .widthIn(max = 520.dp)
                                .background(c.surface2, RoundedCornerShape(20.dp))
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                    is QuotedUnit.Assistant -> Column {
                        if (u.first) {
                            Text(
                                if (u.model.isNullOrBlank()) "$friend's assistant" else "$friend's assistant, ${ModelRefs.displayName(u.model)}",
                                style = ConclaveType.meta,
                                color = c.fg3,
                                modifier = Modifier.padding(bottom = 4.dp),
                            )
                        }
                        if (u.text.isNotEmpty()) MarkdownText(u.text)
                        u.line?.let { Text(it, style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg3, modifier = Modifier.padding(top = if (u.text.isNotEmpty()) 6.dp else 0.dp)) }
                    }
                }
            }
        }
    }
}

/** Sessions made from it here: forks, handoffs and the reference. */
@Composable
private fun MadeFrom(s: ReceivedShareDto, onOpenSession: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val c = Conclave.colors
    if (s.sessions.isEmpty()) return
    Column {
        SectionTitle("Made from it", s.sessions.size)
        s.sessions.forEach { x ->
            val own = sessions.firstOrNull { it.id == x.id }
            Row(
                Modifier.fillMaxWidth().then(if (own != null) Modifier.clickable { onOpenSession(own.id) } else Modifier).heightIn(min = 48.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(ShareWords.roleWord(x.role), style = ConclaveType.body, color = c.fg3, modifier = Modifier.width(96.dp))
                Text(own?.title?.ifBlank { null } ?: if (own != null) "Untitled" else "Not on this hub any more", style = ConclaveType.body, color = if (own != null) c.fg else c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
