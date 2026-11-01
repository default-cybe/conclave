@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.approvals

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.friends.FriendsViewModel
import dev.conclave.app.ui.friends.PhoneShareRow
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.gapItem
import dev.conclave.app.ui.motion.gapRow
import dev.conclave.app.ui.motion.rememberGapHold
import dev.conclave.app.ui.motion.rememberGapList
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.alerts
import dev.conclave.client.logic.Asks
import dev.conclave.client.logic.FriendInboxItem
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.logic.Inbox
import dev.conclave.client.logic.Panel
import dev.conclave.client.model.AlertAction
import dev.conclave.client.model.AlertItem
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.ApprovalResponse
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import java.time.ZoneId
import kotlinx.coroutines.launch

class ApprovalsViewModel(hub: HubRepository) : HubViewModel(hub) {
    fun refresh() = action {
        hub.approvals.value = hub.api { it.approvals() }
        hub.questions.value = hub.api { it.questions() }
        hub.alerts.value = hub.api { it.alerts() }
    }

    fun decide(id: String, response: ApprovalResponse) = action { hub.resolveApproval(id, response) }

    fun answer(id: String, what: AlertAction) = action { hub.actOnAlert(id, what) }
}

/**
 * The Inbox (MOBILE-V2 6): what waits on you as rows, the session's title
 * and one line ("Wants to run git push", "Asks: Keep the old API route?").
 * An approval has Deny and Allow on its right; a tap on a row opens the
 * conversation, where its card waits at the end. An alert (two chats on
 * one file, a stuck turn) has Dismiss, or Stop and Keep waiting. What
 * finished today follows under "Earlier", in fg-3. Friends add rows too
 * (docs/design/FRIENDS.md 6): a request, a key change, notes not read yet
 * (one row per friend), and a share with Decline and Accept in place; a
 * row opens the friend, or the share.
 *
 * A subagent's or a workflow agent's request is its chat's (Asks.kt): the
 * row has that chat's title, says who asks ("Subagent email wants to read
 * a file") and opens that chat, where its card waits at the end.
 */
@Composable
fun InboxScreen(onOpenChat: (String) -> Unit, onOpenFriend: (String) -> Unit = {}, onOpenShare: (String) -> Unit = {}) {
    val container = LocalAppContainer.current
    val hub = container.hub
    val vm: ApprovalsViewModel = viewModel { ApprovalsViewModel(hub) }
    val approvals by hub.approvals.collectAsStateWithLifecycle()
    val questions by hub.questions.collectAsStateWithLifecycle()
    val alerts by hub.alerts.collectAsStateWithLifecycle()
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val friends by hub.friends.collectAsStateWithLifecycle()
    val notes by hub.friendNotes.collectAsStateWithLifecycle()
    val shares by hub.receivedShares.collectAsStateWithLifecycle()
    val friendsVm: FriendsViewModel = viewModel(key = "inbox-friends") { FriendsViewModel(hub) }
    val friendBusy by friendsVm.busy.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    val scope = rememberCoroutineScope()
    MessagesEffect(vm.messages, snackbar)
    MessagesEffect(friendsVm.messages, snackbar)
    LaunchedEffect(Unit) { vm.refresh() }
    val now by rememberNow(60_000)
    val zone = remember { ZoneId.systemDefault() }
    val clearedAt = settings?.inboxClearedAt ?: 0L
    val results = remember(sessions, now, clearedAt) { Inbox.results(sessions, now, zone, clearedAt) }
    val c = Conclave.colors

    val hold = rememberGapHold()
    val sortedApprovals = remember(approvals) { approvals.sortedByDescending { it.createdAt } }
    // allow and close the gap: a decided row says so in place, slides away, and the rest ride up
    val shownApprovals = rememberGapList(sortedApprovals, { it.id }, hold)
    val shownQuestions = rememberGapList(questions, { it.id })
    val sortedAlerts = remember(alerts) { alerts.sortedByDescending { it.createdAt } }
    val shownAlerts = rememberGapList(sortedAlerts, { it.id })
    val fromFriends = remember(friends, notes, shares) { FriendWords.inbox(friends, notes, shares) }
    val shownFriends = rememberGapList(fromFriends, { it.id })
    fun titleOf(id: String): String = sessions.firstOrNull { it.id == id }?.let { Panel.title(it) } ?: "Session"

    Scaffold(
        topBar = { TopBar("Inbox", inbox = false) },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = c.bg,
    ) { padding ->
        // one list the whole time: the last row finishes sliding out while the empty words fade in
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            if (shownQuestions.isEmpty() && shownApprovals.isEmpty() && shownAlerts.isEmpty() && shownFriends.isEmpty()) {
                item(key = "empty") {
                    Text(
                        "Nothing waits on you.",
                        style = ConclaveType.body,
                        color = c.fg3,
                        textAlign = TextAlign.Center,
                        modifier = gapItem().fillMaxWidth().padding(horizontal = 32.dp, vertical = 40.dp),
                    )
                }
            }
            items(shownQuestions, key = { "q:" + it.key }) { e ->
                InboxRow(
                    title = titleOf(Asks.home(e.item)),
                    line = Asks.askerLine(e.item, Inbox.questionLine(e.item)),
                    onOpen = { onOpenChat(Asks.home(e.item)) },
                    modifier = gapItem().gapRow(e.leaving),
                )
            }
            items(shownAlerts, key = { "al:" + it.key }) { e ->
                AlertRow(
                    alert = e.item,
                    title = titleOf(e.item.sessionId),
                    line = Inbox.alertLine(e.item, now),
                    onOpen = { onOpenChat(e.item.sessionId) },
                    onAnswer = { what -> vm.answer(e.item.id, what) },
                    modifier = gapItem().gapRow(e.leaving),
                )
            }
            items(shownApprovals, key = { "a:" + it.key }) { e ->
                val a = e.item
                ApprovalRow(
                    approval = a,
                    title = titleOf(Asks.home(a)),
                    onOpen = { onOpenChat(Asks.home(a)) },
                    onDecide = { r ->
                        hold.confirm(a.id)
                        vm.decide(a.id, r)
                    },
                    modifier = gapItem().gapRow(e.leaving),
                )
            }
            items(shownFriends, key = { "f:" + it.key }) { e ->
                val it = e.item
                val share = it.share
                if (share != null) {
                    PhoneShareRow(
                        share,
                        busy = friendBusy,
                        onOpen = { onOpenShare(share.id) },
                        onAccept = { friendsVm.acceptShare(share) },
                        onDecline = { friendsVm.declineShare(share) },
                        modifier = gapItem().gapRow(e.leaving),
                    )
                } else {
                    FriendRow(it, onOpen = { onOpenFriend(it.friendId) }, modifier = gapItem().gapRow(e.leaving))
                }
            }
            if (results.isNotEmpty()) {
                item(key = "h:earlier") {
                    Row(gapItem().fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Earlier", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
                        TextButton(onClick = { scope.launch { container.settings.setInboxClearedAt(System.currentTimeMillis()) } }) {
                            Text("Clear", style = ConclaveType.meta, color = c.fg3)
                        }
                    }
                }
                items(results, key = { "r:" + it.id }) { s -> EarlierRow(s, onOpen = { onOpenChat(s.id) }, modifier = gapItem()) }
            }
            item(key = "foot") { Spacer(Modifier.height(24.dp)) }
        }
    }
}

/** A row that waits on you: the session's title (16sp) and one line. */
@Composable
private fun InboxRow(title: String, line: String, onOpen: () -> Unit, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    val c = Conclave.colors
    Row(
        modifier.fillMaxWidth().clickable(onClickLabel = "Open the conversation", onClick = onOpen).heightIn(min = 64.dp).padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(line, style = ConclaveType.body.copy(fontSize = 14.sp), color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        trailing?.invoke()
    }
}

/** From a friend: their name, then one line (a key change in fault), and how many notes are new. */
@Composable
private fun FriendRow(item: FriendInboxItem, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    Row(
        modifier.fillMaxWidth().clickable(onClickLabel = "Open", onClick = onOpen).heightIn(min = 64.dp).padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(item.name, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(item.line, style = ConclaveType.body.copy(fontSize = 14.sp), color = if (item.kind == FriendInboxItem.Kind.KEY) c.fault else c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (item.kind == FriendInboxItem.Kind.NOTE) {
            Spacer(Modifier.width(12.dp))
            Text(item.count.toString(), style = ConclaveType.metaNum.copy(fontSize = 15.sp, fontWeight = FontWeight.Medium), color = c.warn, modifier = Modifier.semantics { contentDescription = "${item.count} new" })
        }
    }
}

/** An approval: its row with Deny and Allow on the right; once decided it says so until it leaves. */
@Composable
private fun ApprovalRow(
    approval: ApprovalRequest,
    title: String,
    onOpen: () -> Unit,
    onDecide: (ApprovalResponse) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Conclave.colors
    var decided by remember(approval.id) { mutableStateOf<Boolean?>(null) }
    // still here well after the decision (the hub refused it): ready to decide again
    LaunchedEffect(decided) {
        if (decided != null) {
            kotlinx.coroutines.delay(4_000)
            decided = null
        }
    }
    val line = remember(approval) { Asks.askerLine(approval, Inbox.askLine(approval.tool, approval.summary, approval.input)) }
    InboxRow(title, line, onOpen, modifier) {
        Swap(on = decided != null, off = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = {
                    decided = false
                    onDecide(ApprovalResponse.deny())
                }) { Text("Deny", style = ConclaveType.button, color = c.fg2) }
                TextButton(onClick = {
                    decided = true
                    onDecide(ApprovalResponse.allowOnce())
                }) { Text("Allow", style = ConclaveType.button, color = c.fg) }
            }
        }) {
            Text(
                if (decided == true) "Allowed" else "Denied",
                style = ConclaveType.meta,
                color = if (decided == true) c.ok else c.fg3,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
    }
}

/** An alert: its row with its answers on the right, the last one in fg. */
@Composable
private fun AlertRow(
    alert: AlertItem,
    title: String,
    line: String,
    onOpen: () -> Unit,
    onAnswer: (AlertAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Conclave.colors
    val answers = remember(alert.kind) { Inbox.alertActions(alert) }
    InboxRow(title, line, onOpen, modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            answers.forEachIndexed { i, a ->
                TextButton(onClick = { onAnswer(a) }) {
                    Text(a.label, style = ConclaveType.button, color = if (i == answers.lastIndex) c.fg else c.fg2)
                }
            }
        }
    }
}

/** What finished earlier: the title in fg-3, and "Failed" when it did. */
@Composable
private fun EarlierRow(s: Session, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    Row(
        modifier.fillMaxWidth().clickable(onClick = onOpen).heightIn(min = 56.dp).padding(horizontal = 20.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(Panel.title(s), style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (s.status == SessionStatus.ERROR) {
            Spacer(Modifier.width(12.dp))
            Text("Failed", style = ConclaveType.meta, color = c.fault)
        }
    }
}
