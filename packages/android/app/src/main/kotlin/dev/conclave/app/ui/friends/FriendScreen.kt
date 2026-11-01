@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.friends

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.rememberClock
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.motion.SendStopButton
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FriendEntry
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.SentShareDto

/**
 * One friend (the web's FriendPage.tsx, phone layout, MOBILE-V2 5): the bar
 * like a conversation, its title opens a sheet about their hub (the safety
 * code with Mark verified, the key, where it answers, Sync, the grant for
 * notes and shares, Remove). The notes and shares both ways fill the page,
 * a request or a key change first, and the composer sits at the bottom.
 * What is on screen is read, on every device.
 */
@Composable
fun FriendScreen(
    id: String,
    onBack: () -> Unit,
    onOpenShare: (String) -> Unit,
    onOpenSession: (String) -> Unit,
) {
    val hub = LocalAppContainer.current.hub
    val vm: FriendsViewModel = viewModel(key = "friend:$id") { FriendsViewModel(hub) }
    val friends by hub.friends.collectAsStateWithLifecycle()
    val fetched by vm.fetched.collectAsStateWithLifecycle()
    val missing by vm.missing.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    val stored = friends.firstOrNull { it.id == id }
    // a removed friend is not in the shared list: ask the hub, for its notes
    LaunchedEffect(id, stored == null) { if (stored == null) vm.fetchFriend(id) }
    LaunchedEffect(id) { vm.openThread(id) }
    val f = stored ?: fetched
    var details by remember { mutableStateOf(false) }
    val c = Conclave.colors

    Scaffold(
        topBar = {
            TopBar(
                f?.name ?: if (missing) "Friend" else "",
                onBack = onBack,
                onTitle = if (f != null) ({ details = true }) else null,
                titleAction = "Details",
                newChat = false,
            )
        },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = c.bg,
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            OfflineBanner(connection)
            when {
                f != null -> FriendBody(f, vm, onBack, onOpenShare, onOpenSession, onDetails = { details = true }, modifier = Modifier.weight(1f))
                missing -> Text("This friend is not on this hub.", style = ConclaveType.body, color = c.fg2, modifier = Modifier.padding(20.dp))
                else -> LoadingBox()
            }
        }
    }
    if (details && f != null) {
        FriendDetailsSheet(f, vm, onRemoved = {
            details = false
            onBack()
        }, onDismiss = { details = false })
    }
}

@Composable
private fun FriendBody(
    f: FriendDto,
    vm: FriendsViewModel,
    onGone: () -> Unit,
    onOpenShare: (String) -> Unit,
    onOpenSession: (String) -> Unit,
    onDetails: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val hub = LocalAppContainer.current.hub
    val c = Conclave.colors
    val notesAll by hub.friendNotes.collectAsStateWithLifecycle()
    val receivedAll by hub.receivedShares.collectAsStateWithLifecycle()
    val sent by hub.sentShares.collectAsStateWithLifecycle()
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val outbox by vm.outbox.collectAsStateWithLifecycle()
    val loaded by vm.outboxLoaded.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val now by rememberNow(60_000)
    val clock = rememberClock()
    val notes = remember(notesAll, f.id) { notesAll.filter { it.friendId == f.id } }
    val received = remember(receivedAll, f.id) { receivedAll.filter { it.friendId == f.id } }
    val entries = remember(f.id, notes, outbox, received, sent, now) { ShareWords.thread(f.id, notes, outbox, received, sent, now, clock) }
    val lastOut = entries.lastOrNull { it is FriendEntry.NoteOut }?.id
    var updating by remember { mutableStateOf<SentShareDto?>(null) }

    // what is on screen is read, here and on the owner's other devices
    val targets = remember(f, notes, received) { FriendWords.readTargets(f, notes, received) }
    LaunchedEffect(targets) { vm.markRead(f, targets) }

    // open at the newest, and follow new ones
    val list = rememberLazyListState()
    LaunchedEffect(entries.size, loaded) {
        // the head, then the entries, then the foot: the foot is the last row
        if (entries.isNotEmpty()) list.scrollToItem(entries.size + 1)
    }

    Column(modifier.fillMaxSize()) {
        LazyColumn(state = list, modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp)) {
            item(key = "head") {
                Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    FriendAdded(f.id, size = 28.dp)
                    StatusBlock(f, vm, busy, onGone, Modifier.fillMaxWidth())
                    if (f.isActive && !f.verified) {
                        TextButton(onClick = onDetails) {
                            Text("Not verified yet. Compare the safety code", style = ConclaveType.body, color = c.fg3, textAlign = TextAlign.Center)
                        }
                    }
                }
            }
            if (loaded && entries.isEmpty()) {
                item(key = "empty") {
                    Text(
                        if (f.isActive) "No notes yet. A note is plain text, signed by your hub and sealed for ${f.name}'s hub. Send a chat or a session from its sheet, Send to friend." else "No notes.",
                        style = ConclaveType.body,
                        color = c.fg3,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                    )
                }
            }
            items(entries, key = { e -> e.key }) { e ->
                Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                    e.stamp?.let { Text(it, style = ConclaveType.metaNum, color = c.fg3, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 6.dp)) }
                    when (e) {
                        is FriendEntry.NoteIn -> NoteIn(e, f.name)
                        is FriendEntry.NoteOut -> NoteOut(e, f, last = e.id == lastOut, busy = busy, vm = vm, now = now)
                        is FriendEntry.ShareIn -> ReceivedShareCard(
                            e.share,
                            now = now,
                            busy = busy,
                            onOpen = { onOpenShare(e.share.id) },
                            onAccept = { vm.acceptShare(e.share) },
                            onDecline = { vm.declineShare(e.share) },
                            modifier = Modifier.align(Alignment.Start).widthIn(max = CARD_MAX).fillMaxWidth(0.88f),
                        )
                        is FriendEntry.ShareOut -> SentShareCard(
                            e.share,
                            sessions = sessions,
                            onOpenSession = { onOpenSession(it.id) },
                            onUpdate = { updating = e.share },
                            onUnsend = { vm.unsendShare(e.share) },
                            friendId = f.id,
                            modifier = Modifier.align(Alignment.End).widthIn(max = CARD_MAX).fillMaxWidth(0.88f),
                        )
                    }
                }
            }
            item(key = "foot") { Box(Modifier.heightIn(min = 12.dp)) }
        }
        Composer(f, vm, busy)
    }
    updating?.let { s ->
        val own = sessions.firstOrNull { it.id == s.sessionId }
        SendToFriendSheet(
            sessionId = s.sessionId,
            title = own?.title ?: s.title,
            chat = own?.isChat ?: (s.kind == "chat"),
            update = s,
            onDismiss = { updating = null },
        )
    }
}

private val BUBBLE = RoundedCornerShape(20.dp)

@Composable
private fun NoteIn(e: FriendEntry.NoteIn, name: String) {
    val c = Conclave.colors
    val (text, color) = when (e.state) {
        "fetching" -> "A note from $name is on its way." to c.fg3
        "failed" -> "A note from $name did not open." to c.fault
        else -> e.text to c.fg
    }
    Box(Modifier.fillMaxWidth(0.82f), contentAlignment = Alignment.CenterStart) {
        Text(
            text,
            style = ConclaveType.chat,
            color = color,
            modifier = Modifier
                .border(1.dp, if (color == c.fg) c.rule2 else c.rule, BUBBLE)
                .padding(horizontal = 16.dp, vertical = 10.dp)
                .semantics { contentDescription = "$name: $text" },
        )
    }
}

@Composable
private fun NoteOut(e: FriendEntry.NoteOut, f: FriendDto, last: Boolean, busy: Set<String>, vm: FriendsViewModel, now: Long) {
    val c = Conclave.colors
    val d = FriendWords.delivery(e.item, f.name, now)
    // a delivered note says so only under the last one
    val show = e.item.state != "delivered" || last
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Box(Modifier.fillMaxWidth(0.82f), contentAlignment = Alignment.CenterEnd) {
            Text(
                e.text,
                style = ConclaveType.chat,
                color = c.fg,
                modifier = Modifier
                    .clip(BUBBLE)
                    .background(c.surface2)
                    .then(if (c.dark) Modifier else Modifier.border(1.dp, c.rule, BUBBLE))
                    .padding(horizontal = 16.dp, vertical = 10.dp)
                    .semantics { contentDescription = "You: ${e.text}" },
            )
        }
        if (show) {
            Text(d.word, style = ConclaveType.meta, color = friendTone(d.tone), modifier = Modifier.padding(top = 2.dp))
            d.line?.let { Text(it, style = ConclaveType.meta, color = c.fg3, textAlign = TextAlign.End, modifier = Modifier.fillMaxWidth(0.82f)) }
            if (d.retry || (d.cancel && e.item.attempts > 0)) {
                val working = "retry:${e.id}" in busy || "cancel:${e.id}" in busy
                Row {
                    if (d.retry) TextButton(onClick = { vm.retryNote(e.id, f.id) }, enabled = !working) { Text("Retry", color = c.fg) }
                    TextButton(onClick = { vm.cancelNote(e.id, f.id) }, enabled = !working) { Text("Cancel", color = c.fg2) }
                }
            }
        }
    }
}

/** A request, a key change or a removed friend, with what can be done about it. */
@Composable
private fun StatusBlock(f: FriendDto, vm: FriendsViewModel, busy: Set<String>, onGone: () -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val now by rememberNow(60_000)
    when {
        f.isBlocked -> KeyChange(f, onConfirm = { vm.confirmKey(f) }, onRemove = { vm.removeFriend(f, onGone) }, modifier = modifier.padding(top = 8.dp))
        f.isRemoved -> Text(
            "You are not friends with ${f.name} any more. Nothing goes either way. Their notes stay here.",
            style = ConclaveType.body,
            color = c.fg2,
            modifier = modifier.padding(top = 8.dp),
        )
        f.isPending && !f.asked -> Column(modifier.padding(top = 8.dp)) {
            Text("Waiting for them to accept. You asked ${FriendWords.agoText(f.createdAt, now)}.", style = ConclaveType.body, color = c.fg)
            Text("Compare the safety code with them meanwhile.", style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg3, modifier = Modifier.padding(top = 4.dp))
            SafetyCode(f.safetyCode, Modifier.padding(top = 6.dp))
            val withdrawing = "decline:${f.id}" in busy
            TextButton(onClick = { vm.declineRequest(f, onGone) }, enabled = !withdrawing, modifier = Modifier.padding(top = 6.dp).heightIn(min = 48.dp)) {
                Swap(on = withdrawing, off = { Text("Withdraw the request", color = c.fg2) }) { Text("Withdrawing", color = c.fg3) }
            }
        }
        f.isPending -> Column(modifier.padding(top = 8.dp)) {
            Text("${f.name} wants to be friends.", style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg)
            Text(
                "Compare the safety code with ${f.name} in person or on a call before you accept. You both see the same code.",
                style = ConclaveType.meta.copy(fontSize = 14.sp),
                color = c.fg3,
                modifier = Modifier.padding(top = 4.dp),
            )
            SafetyCode(f.safetyCode, Modifier.padding(top = 6.dp))
            AnswerPair(
                no = "Decline",
                yes = "Accept",
                busyNo = if ("decline:${f.id}" in busy) "Declining" else null,
                busyYes = if ("accept:${f.id}" in busy) "Accepting" else null,
                onNo = { vm.declineRequest(f, onGone) },
                onYes = { vm.acceptRequest(f) },
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}

/** The note box at the bottom, or why there is none. */
@Composable
private fun Composer(f: FriendDto, vm: FriendsViewModel, busy: Set<String>) {
    val c = Conclave.colors
    var text by remember(f.id) { mutableStateOf("") }
    val why = FriendWords.cannotWrite(f)
    if (why != null) {
        Text(why, style = ConclaveType.body, color = c.fg3, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp))
        return
    }
    val sending = "note" in busy
    val ready = text.isNotBlank() && !sending
    val shape = RoundedCornerShape(24.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 8.dp)
            .clip(shape)
            .background(c.surface2)
            .then(if (c.dark) Modifier else Modifier.border(1.dp, c.rule, shape))
            .padding(start = 16.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        BasicTextField(
            value = text,
            onValueChange = { text = it },
            textStyle = ConclaveType.chat.copy(color = c.fg),
            cursorBrush = SolidColor(c.signal),
            maxLines = 6,
            modifier = Modifier.weight(1f).padding(vertical = 10.dp).semantics { contentDescription = "Note to ${f.name}" },
            decorationBox = { inner ->
                Box {
                    if (text.isEmpty()) Text("Note to ${f.name}", style = ConclaveType.chat, color = c.fg3, maxLines = 1)
                    inner()
                }
            },
        )
        SendStopButton(
            running = false,
            ready = ready,
            enabled = ready,
            onClick = {
                val t = text.trim()
                if (t.isNotEmpty()) vm.sendNote(f, t, onSent = { text = "" })
            },
            sendLabel = "Send note",
        )
    }
}

/** About their hub, from the title: the safety code, the key, where it answers, the grant, Remove. */
@Composable
private fun FriendDetailsSheet(f: FriendDto, vm: FriendsViewModel, onRemoved: () -> Unit, onDismiss: () -> Unit) {
    val c = Conclave.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val busy by vm.busy.collectAsStateWithLifecycle()
    val now by rememberNow(60_000)
    val st = FriendWords.state(f, now)
    var remove by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(f.name, style = ConclaveType.title, color = c.fg, modifier = Modifier.weight(1f, fill = false))
                if (f.verified && f.isActive) VerifiedBadge(Modifier.padding(start = 10.dp))
            }
            Block("Safety code") {
                SafetyCode(f.safetyCode, large = true)
                Text("Compare it with ${f.name} in person or on a call. You both see the same code.", style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg3, modifier = Modifier.padding(top = 6.dp))
                // the mark is for a friend's current key: a request or a key change has none to give
                if (f.isActive) {
                    val saving = "verify:${f.id}" in busy
                    if (f.verified) {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                            VerifiedBadge()
                            TextButton(onClick = { vm.markVerified(f, false) }, enabled = !saving, modifier = Modifier.heightIn(min = 48.dp)) {
                                Swap(on = saving, off = { Text("Take the mark off", color = c.fg2) }) { Text("Saving", color = c.fg3) }
                            }
                        }
                    } else {
                        OutlinedButton(onClick = { vm.markVerified(f, true) }, enabled = !saving, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.padding(top = 10.dp).heightIn(min = 48.dp)) {
                            Swap(on = saving, off = { Text("Mark verified") }) { Text("Saving") }
                        }
                    }
                }
            }
            Block("Key") { KeyLines(f.fingerprint) }
            if (f.isActive) {
                Block("Their hub") {
                    Text(st.word, style = ConclaveType.body, color = if (st.tone == dev.conclave.client.logic.FriendTone.DIM) c.fg else friendTone(st.tone))
                    f.addresses.firstOrNull()?.let { Text(it.url, style = CodeStyle, color = c.fg2, modifier = Modifier.padding(top = 2.dp)) }
                    st.line?.let { Text(it, style = ConclaveType.meta, color = friendTone(st.tone), modifier = Modifier.padding(top = 4.dp)) }
                    val syncing = "sync:${f.id}" in busy
                    TextButton(onClick = { vm.sync(f) }, enabled = !syncing, modifier = Modifier.heightIn(min = 48.dp)) {
                        Swap(on = syncing, off = { Text("Sync now", color = c.fg) }) { Text("Syncing", color = c.fg3) }
                    }
                }
                Block("Notes and shares from ${f.name}") {
                    Row(Modifier.fillMaxWidth().clickable { vm.setReceiveShares(f, !f.grants.receiveShares) }.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            if (f.grants.receiveShares) "They land in your Inbox. Nothing runs because of them." else "Your hub turns them away. ${f.name}'s hub keeps trying for 7 days.",
                            style = ConclaveType.meta.copy(fontSize = 14.sp),
                            color = c.fg3,
                            modifier = Modifier.weight(1f).padding(end = 12.dp),
                        )
                        Switch(checked = f.grants.receiveShares, onCheckedChange = { vm.setReceiveShares(f, it) })
                    }
                }
            }
            if (!f.isRemoved && !f.isBlocked) {
                TextButton(onClick = { remove = true }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Remove ${f.name}", color = c.fault, style = ConclaveType.button.copy(fontWeight = FontWeight.Medium))
                }
            }
        }
    }
    if (remove) {
        RemoveDialog(f, onRemove = {
            remove = false
            vm.removeFriend(f, onRemoved)
        }, onDismiss = { remove = false })
    }
}

@Composable
private fun Block(label: String, content: @Composable () -> Unit) {
    Column {
        Text(label, style = ConclaveType.meta, color = Conclave.colors.fg3)
        Column(Modifier.padding(top = 6.dp)) { content() }
    }
}
