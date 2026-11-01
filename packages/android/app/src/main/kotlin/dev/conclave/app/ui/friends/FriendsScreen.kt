package dev.conclave.app.ui.friends

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.rememberClock
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.pairing.QrFrame
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FriendInboxItem
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.FriendInvite

/**
 * Friends (docs/DESIGN.md 27, docs/design/FRIENDS.md 6; the web's Settings,
 * Friends): whether friends reach this hub, key changes that hold a friend,
 * requests both ways with Accept and Decline, the friends (name, verified,
 * short key, last seen), Shares, then Add a friend: an invite as a link and
 * a QR code, or a friend's link pasted or scanned. A friend's row opens
 * their page. [link] is a friend's invite that opened the app.
 */
@Composable
fun FriendsScreen(
    link: String?,
    onBack: () -> Unit,
    onOpenFriend: (String) -> Unit,
    onOpenShares: () -> Unit,
    onOpenRemote: () -> Unit,
) {
    val hub = LocalAppContainer.current.hub
    val vm: FriendsViewModel = viewModel { FriendsViewModel(hub) }
    val friends by hub.friends.collectAsStateWithLifecycle()
    val notes by hub.friendNotes.collectAsStateWithLifecycle()
    val received by hub.receivedShares.collectAsStateWithLifecycle()
    val sent by hub.sentShares.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val reach by vm.reach.collectAsStateWithLifecycle()
    val remote by hub.remote.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    // again when remote access changes: what friends reach moves with it
    LaunchedEffect(remote?.mode, remote?.state, remote?.addresses?.size) { vm.loadReach() }
    val c = Conclave.colors

    var text by remember { mutableStateOf(link.orEmpty()) }
    LaunchedEffect(link) { if (link != null) text = link }
    var scanning by remember { mutableStateOf(false) }
    var scanRound by remember { mutableIntStateOf(0) }

    if (scanning) {
        ScanFriendLink(
            round = scanRound,
            onLink = { l ->
                scanning = false
                text = l
                vm.requested.value = null
            },
            onWrong = { scanRound++ },
            onClose = { scanning = false },
        )
        return
    }

    val all = remember(friends) { FriendWords.order(friends) }
    val blocked = all.filter { it.isBlocked }
    val requests = all.filter { it.isPending }
    val active = all.filter { it.isActive }
    // notes not read yet and share cards not seen yet, per friend
    val fresh = remember(friends, notes, received) {
        FriendWords.inbox(friends, notes, received)
            .filter { it.kind == FriendInboxItem.Kind.NOTE || it.kind == FriendInboxItem.Kind.SHARE }
            .groupBy { it.friendId }
            .mapValues { (_, list) -> list.sumOf { it.count } }
    }

    Scaffold(
        topBar = { TopBar("Friends", onBack = onBack) },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = c.bg,
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            OfflineBanner(connection)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
                ReachLine(reach, onOpenRemote, Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp))

                blocked.forEach { f ->
                    KeyChange(f, onConfirm = { vm.confirmKey(f) }, onRemove = { vm.removeFriend(f) }, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp))
                }

                if (requests.isNotEmpty()) {
                    SectionHeader("Requests", trailing = { Text(requests.size.toString(), style = ConclaveType.metaNum, color = c.fg3) })
                    requests.forEach { f -> if (f.asked) RequestIn(f, busy, vm) else RequestOut(f, busy, vm) }
                }

                SectionHeader("Friends", trailing = { if (active.isNotEmpty()) Text(active.size.toString(), style = ConclaveType.metaNum, color = c.fg3) })
                if (active.isEmpty()) {
                    Text(
                        "No friends yet. Make an invite and send it to someone who runs Conclave, or use the link they sent you.",
                        style = ConclaveType.body,
                        color = c.fg3,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                }
                active.forEach { f -> FriendRow(f, fresh[f.id] ?: 0, onOpen = { onOpenFriend(f.id) }) }

                if (active.isNotEmpty() || received.isNotEmpty() || sent.isNotEmpty()) {
                    SectionHeader("Shares")
                    val waiting = received.count { FriendWords.shareWaiting(it) }
                    val words = listOfNotNull(
                        if (received.isNotEmpty()) "${received.size} from friends" else null,
                        if (sent.isNotEmpty()) "${sent.size} sent" else null,
                    ).joinToString(", ").replaceFirstChar { it.uppercaseChar() }
                    LinkRow(onClick = onOpenShares) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(words.ifEmpty { "None yet" }, style = ConclaveType.rowTitle, color = c.fg)
                                Text("Chats and sessions, both ways.", style = ConclaveType.meta, color = c.fg3)
                            }
                            if (waiting > 0) Text("$waiting waiting", style = ConclaveType.metaNum.copy(fontWeight = FontWeight.Medium), color = c.warn)
                        }
                    }
                }

                SectionHeader("Add a friend")
                Text(
                    "A friend is someone else's Conclave hub. You trade notes, chats and sessions, hub to hub.",
                    style = ConclaveType.meta,
                    color = c.fg3,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
                )
                InviteBlock(vm, reach?.ok == false)
                UseLinkBlock(vm, text = text, onText = {
                    text = it
                    vm.requested.value = null
                }, onScan = {
                    scanRound++
                    scanning = true
                })
            }
        }
    }
}

/** A friend: name, verified, what is new, the key, how their hub is, and the state word. */
@Composable
private fun FriendRow(f: FriendDto, fresh: Int, onOpen: () -> Unit) {
    val c = Conclave.colors
    val now by rememberNow(60_000)
    val st = FriendWords.state(f, now)
    LinkRow(onClick = onOpen) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(f.name, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (f.verified) VerifiedBadge(Modifier.padding(start = 8.dp))
                    FriendAdded(f.id, size = 16.dp, modifier = Modifier.padding(start = 8.dp))
                    if (fresh > 0) Text("$fresh new", style = ConclaveType.metaNum.copy(fontWeight = FontWeight.Medium), color = c.warn, modifier = Modifier.padding(start = 8.dp))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Key ", style = ConclaveType.meta, color = c.fg3)
                    ShortKey(f.fingerprint)
                }
                st.line?.let { Text(it, style = ConclaveType.meta, color = friendTone(st.tone), maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            Spacer(Modifier.width(8.dp))
            Text(st.word, style = ConclaveType.meta.copy(fontSize = 14.sp), color = friendTone(st.tone))
        }
    }
}

@Composable
private fun RequestIn(f: FriendDto, busy: Set<String>, vm: FriendsViewModel) {
    val c = Conclave.colors
    val now by rememberNow(60_000)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
        Text("${f.name} wants to be friends", style = ConclaveType.rowTitle, color = c.fg)
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
            Text("Key ", style = ConclaveType.meta, color = c.fg3)
            ShortKey(f.fingerprint)
            Text(". Asked ${FriendWords.agoText(f.createdAt, now)}.", style = ConclaveType.meta, color = c.fg3)
        }
        Text("Safety code, to compare with ${f.name}", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 6.dp))
        SafetyCode(f.safetyCode, Modifier.padding(top = 2.dp))
        AnswerPair(
            no = "Decline",
            yes = "Accept",
            busyNo = if ("decline:${f.id}" in busy) "Declining" else null,
            busyYes = if ("accept:${f.id}" in busy) "Accepting" else null,
            onNo = { vm.declineRequest(f) },
            onYes = { vm.acceptRequest(f) },
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}

@Composable
private fun RequestOut(f: FriendDto, busy: Set<String>, vm: FriendsViewModel) {
    val c = Conclave.colors
    val now by rememberNow(60_000)
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(f.name, style = ConclaveType.rowTitle, color = c.fg)
            Text("Waiting for them to accept. You asked ${FriendWords.agoText(f.createdAt, now)}.", style = ConclaveType.meta, color = c.fg3)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Key ", style = ConclaveType.meta, color = c.fg3)
                ShortKey(f.fingerprint)
            }
        }
        val withdrawing = "decline:${f.id}" in busy
        TextButton(onClick = { vm.declineRequest(f) }, enabled = !withdrawing, modifier = Modifier.heightIn(min = 48.dp)) {
            Swap(on = withdrawing, off = { Text("Withdraw", color = c.fg2) }) { Text("Withdrawing", color = c.fg3) }
        }
    }
}

// ---------------------------------------------------------------------------
// Make an invite
// ---------------------------------------------------------------------------

@Composable
private fun InviteBlock(vm: FriendsViewModel, unreachable: Boolean) {
    val c = Conclave.colors
    val invite by vm.invite.collectAsStateWithLifecycle()
    val error by vm.inviteError.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    var lan by remember { mutableStateOf(false) }
    val making = "invite" in busy
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text("Invite a friend", style = ConclaveType.rowTitle, color = c.fg)
        Text("A link and a QR code for one person. It works once, for 24 hours.", style = ConclaveType.meta, color = c.fg3)
        // friends outside cannot reach the hub: an invite can carry this network's addresses for someone on it
        if (unreachable && invite == null) {
            Row(Modifier.fillMaxWidth().clickable { lan = !lan }.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = lan, onCheckedChange = { lan = it })
                Column(Modifier.weight(1f)) {
                    Text("Include addresses on this network", style = ConclaveType.body, color = c.fg)
                    Text("For a friend on your Wi-Fi. Anyone else cannot use them.", style = ConclaveType.meta, color = c.fg3)
                }
            }
        }
        val label = if (invite != null) "Make another" else "Make an invite"
        if (invite != null) {
            TextButton(onClick = { vm.makeInvite(lan) }, enabled = !making, modifier = Modifier.padding(top = 6.dp).heightIn(min = 48.dp)) {
                Swap(on = making, off = { Text(label, color = c.fg) }) { Text("Making", color = c.fg3) }
            }
        } else {
            OutlinedButton(onClick = { vm.makeInvite(lan) }, enabled = !making, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.padding(top = 8.dp).heightIn(min = 48.dp)) {
                Swap(on = making, off = { Text(label) }) { Text("Making") }
            }
        }
        error?.let { Text(it, style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(top = 6.dp)) }
        invite?.let { InvitePanel(it, Modifier.padding(top = 12.dp)) }
    }
}

@Composable
private fun InvitePanel(invite: FriendInvite, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val context = LocalContext.current
    val now by rememberNow(30_000)
    val clock = rememberClock()
    var copied by remember(invite.link) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            kotlinx.coroutines.delay(1_600)
            copied = false
        }
    }
    val expired = invite.expiresAt <= now
    Column(modifier) {
        if (!expired) InviteQr(invite.qrSvg)
        Text("Invite link", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 16.dp))
        Text(invite.link, style = CodeStyle, color = c.fg, modifier = Modifier.padding(top = 4.dp))
        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    copyText(context, invite.link, "Friend invite")
                    copied = true
                },
                enabled = !expired,
                colors = outlineButtonColors(),
                border = outlineButtonBorder(),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(if (copied) "Copied" else "Copy link") }
            TextButton(onClick = { shareText(context, invite.link) }, enabled = !expired, modifier = Modifier.heightIn(min = 48.dp)) { Text("Share", color = c.fg) }
        }
        Text(
            if (expired) "This invite expired. Make another." else "Send it to one person, or let them scan the code. It works once, ${FriendWords.untilText(invite.expiresAt, now, clock)}.",
            style = ConclaveType.meta.copy(fontSize = 14.sp),
            color = if (expired) c.fault else c.fg3,
            modifier = Modifier.padding(top = 10.dp),
        )
        Text("Your hub's key, for them to compare", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 14.dp))
        KeyLines(invite.fingerprint, Modifier.padding(top = 4.dp))
        invite.warning?.let { Text(it, style = ConclaveType.meta, color = c.warn, modifier = Modifier.padding(top = 10.dp)) }
    }
}

// ---------------------------------------------------------------------------
// Use a friend's link
// ---------------------------------------------------------------------------

@Composable
private fun UseLinkBlock(vm: FriendsViewModel, text: String, onText: (String) -> Unit, onScan: () -> Unit) {
    val c = Conclave.colors
    val now by rememberNow(30_000)
    val clock = rememberClock()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val sent by vm.requested.collectAsStateWithLifecycle()
    val parsed = remember(text) { FriendWords.parseLink(text) }
    val expired = parsed != null && parsed.expiresAt <= now
    val checking = "link" in busy
    val send = { if (parsed != null && !expired) vm.useLink(parsed.link, onSent = { onText("") }) }
    val note: Pair<String, Boolean>? = when {
        text.isNotBlank() && parsed == null -> "That is not a friend link. It starts with conclave://friend." to true
        expired -> "This invite has expired. Ask your friend for a new one." to true
        parsed != null -> "An invite from the hub ${FriendWords.shortFingerprint(parsed.fp, 2)} at ${FriendWords.hostWords(parsed.url)}. It works ${FriendWords.untilText(parsed.expiresAt, now, clock)}." to false
        else -> null
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text("Use a friend's link", style = ConclaveType.rowTitle, color = c.fg)
        Text("Paste the link a friend sent you. Your hub checks their hub's key, then asks to be friends.", style = ConclaveType.meta, color = c.fg3)
        OutlinedTextField(
            value = text,
            onValueChange = onText,
            placeholder = { Text("conclave://friend?...", style = CodeStyle) },
            textStyle = CodeStyle,
            isError = note?.second == true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onSend = { send() }),
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
        )
        note?.let { (words, fault) -> Text(words, style = ConclaveType.meta, color = if (fault) c.fault else c.fg3, modifier = Modifier.padding(top = 6.dp)) }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onScan, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Scan QR code") }
            Button(onClick = send, enabled = parsed != null && !expired && !checking, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                Swap(on = checking, off = { Text("Send request") }) { Text("Checking") }
            }
        }
        sent?.let { f ->
            Text(
                "Request sent. Their hub's key checked out. You are friends once their owner accepts.",
                style = ConclaveType.body,
                color = c.ok,
                modifier = Modifier.padding(top = 12.dp),
            )
            Text("Safety code, to compare with them:", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 4.dp))
            SafetyCode(f.safetyCode, Modifier.padding(top = 4.dp))
        }
    }
}

/** The camera over the whole screen until it reads a friend's invite, or Close. */
@Composable
private fun ScanFriendLink(round: Int, onLink: (String) -> Unit, onWrong: () -> Unit, onClose: () -> Unit) {
    var wrong by remember { mutableStateOf(false) }
    BackHandler(onBack = onClose)
    Box(Modifier.fillMaxSize().background(Color.Black).systemBarsPadding()) {
        key(round) {
            QrFrame(
                onResult = { value ->
                    val l = FriendWords.parseLink(value)
                    if (l != null) {
                        onLink(l.link)
                    } else {
                        wrong = true
                        onWrong()
                    }
                },
                modifier = Modifier.align(Alignment.Center).padding(24.dp).widthIn(max = 420.dp).fillMaxWidth().aspectRatio(1f),
            )
        }
        IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopStart).padding(4.dp).size(48.dp)) {
            Icon(Icons.Outlined.Close, contentDescription = "Close camera", tint = Color.White)
        }
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                if (wrong) "That is not a Conclave friend invite." else "Point the camera at the code in your friend's Friends.",
                style = ConclaveType.body,
                color = Color.White,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onClose) { Text("Paste the link instead", color = Color.White) }
        }
    }
}

fun copyText(context: Context, text: String, label: String) {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return
    cm.setPrimaryClip(ClipData.newPlainText(label, text))
}

fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    runCatching { context.startActivity(Intent.createChooser(send, null)) }
}
