package dev.conclave.app.ui.friends

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.model.ReceivedShareDto
import dev.conclave.client.model.SentShareDto
import dev.conclave.client.model.Session

/*
 * Shares as cards (docs/design/FRIENDS.md, phases 2 and 3; the web's
 * ShareCards.tsx). From a friend: what it holds, the note, how it stands,
 * Accept and Decline while it waits, then Open. Sent by you: the title,
 * how each friend has it, Update (a new revision) and Unsend.
 */

/** The busy word of a share's answer, or null: "Declining", "Fetching". */
private fun busyNo(busy: Set<String>, s: ReceivedShareDto): String? = if ("decline:${s.id}" in busy) "Declining" else null
private fun busyYes(busy: Set<String>, s: ReceivedShareDto): String? = if ("accept:${s.id}" in busy || s.state == "fetching") "Fetching" else null

/**
 * A share from a friend as a card: its title (opens it), what it holds, the
 * note, how it stands, and Accept and Decline while it waits.
 */
@Composable
fun ReceivedShareCard(
    s: ReceivedShareDto,
    now: Long,
    busy: Set<String>,
    onOpen: () -> Unit,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Conclave.colors
    val w = ShareWords.received(s, now)
    val waits = FriendWords.shareWaiting(s) || s.state == "declined"
    Column(
        modifier
            .border(1.dp, c.rule2, RoundedCornerShape(18.dp))
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Shared ${ShareWords.kindWords(s.kind)}", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
            ShareArrived(s.id, size = 12.dp)
        }
        Text(
            s.title,
            style = ConclaveType.rowTitle.copy(fontSize = 16.sp),
            color = c.fg,
            modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 6.dp),
        )
        Text(ShareWords.summaryText(s.kind, s.summary), style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg2)
        s.note?.takeIf { it.isNotBlank() }?.let { Text(it, style = ConclaveType.body, color = c.fg, modifier = Modifier.padding(top = 6.dp)) }
        StateLine(w.word, w.line, friendTone(w.tone), Modifier.padding(top = 6.dp))
        when {
            waits -> AnswerPair(
                no = "Decline",
                yes = ShareWords.acceptLabel(s),
                busyNo = busyNo(busy, s),
                busyYes = busyYes(busy, s),
                onNo = if (s.state == "offered") onDecline else null,
                onYes = onAccept,
                modifier = Modifier.padding(top = 8.dp),
            )
            s.state == "accepted" -> TextButton(onClick = onOpen, modifier = Modifier.heightIn(min = 48.dp)) { Text("Open", color = c.fg) }
        }
    }
}

/** "Waiting. It expires in 3 days." with the word in its tone and the rest quiet. */
@Composable
fun StateLine(word: String, line: String?, color: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = color)) { append(word) }
            if (line != null) withStyle(SpanStyle(color = c.fg3)) { append(". $line") }
        },
        style = ConclaveType.meta,
        modifier = modifier,
    )
}

/**
 * A share card on the phone Inbox: "Alice sent 'title'" and what it holds,
 * with Decline and Accept under it at the right, where an approval's Deny
 * and Allow sit. A tap on the words opens the share.
 */
@Composable
fun PhoneShareRow(s: ReceivedShareDto, busy: Set<String>, onOpen: () -> Unit, onAccept: () -> Unit, onDecline: () -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val no = busyNo(busy, s)
    val yes = busyYes(busy, s)
    Column(modifier.fillMaxWidth().padding(top = 10.dp, bottom = 4.dp)) {
        Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Open the share", onClick = onOpen).heightIn(min = 44.dp).padding(horizontal = 20.dp)) {
            Text("${s.friendName} sent '${s.title}'", style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                if (s.updateWaiting) "Revision ${s.revision}. ${ShareWords.summaryText(s.kind, s.summary)}" else ShareWords.summaryText(s.kind, s.summary),
                style = ConclaveType.body.copy(fontSize = 14.sp),
                color = c.fg2,
            )
        }
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            ShareArrived(s.id, size = 14.dp)
            Spacer(Modifier.weight(1f))
            if (s.state == "offered") {
                TextButton(onClick = onDecline, enabled = no == null && yes == null) {
                    Swap(on = no != null, off = { Text("Decline", style = ConclaveType.button, color = c.fg2) }) { Text("Declining", style = ConclaveType.button, color = c.fg3) }
                }
            }
            TextButton(onClick = onAccept, enabled = no == null && yes == null) {
                Swap(on = yes != null, off = { Text(if (s.updateWaiting) "Accept revision" else "Accept", style = ConclaveType.button.copy(fontWeight = FontWeight.SemiBold), color = c.fg) }) {
                    Text("Fetching", style = ConclaveType.button, color = c.fg3)
                }
            }
        }
    }
}

/**
 * A share this hub sent: its title (opens the conversation it came from),
 * what it held, the revision, how each friend has it (or only [friendId]),
 * and Update and Unsend while it is out.
 */
@Composable
fun SentShareCard(
    s: SentShareDto,
    sessions: List<Session>,
    onOpenSession: (Session) -> Unit,
    onUpdate: () -> Unit,
    onUnsend: () -> Unit,
    modifier: Modifier = Modifier,
    friendId: String? = null,
) {
    val c = Conclave.colors
    var unsend by remember { mutableStateOf(false) }
    val people = if (friendId == null) s.recipients else s.recipients.filter { it.friendId == friendId }
    val own = sessions.firstOrNull { it.id == s.sessionId }
    Column(
        modifier
            .background(c.surface2, RoundedCornerShape(18.dp))
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text("You shared ${ShareWords.kindWords(s.kind)}" + if (s.revision > 1) ", revision ${s.revision}" else "", style = ConclaveType.meta, color = c.fg3)
        Text(
            s.title,
            style = ConclaveType.rowTitle.copy(fontSize = 16.sp),
            color = c.fg,
            modifier = Modifier.fillMaxWidth().then(if (own != null) Modifier.clickable { onOpenSession(own) } else Modifier).padding(vertical = 6.dp),
        )
        Text(ShareWords.summaryText(s.kind, s.summary), style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg2)
        s.note?.takeIf { it.isNotBlank() }?.let { Text(it, style = ConclaveType.body, color = c.fg, modifier = Modifier.padding(top = 6.dp)) }
        Column(Modifier.padding(top = 6.dp)) {
            people.forEach { r ->
                val w = ShareWords.recipient(r, s)
                Text(
                    buildAnnotatedString {
                        if (friendId == null) withStyle(SpanStyle(color = c.fg2)) { append("${r.friendName}: ") }
                        withStyle(SpanStyle(color = friendTone(w.tone))) { append(w.word) }
                        if (w.line != null) withStyle(SpanStyle(color = c.fg3)) { append(". ${w.line}") }
                    },
                    style = ConclaveType.meta,
                )
            }
        }
        if (ShareWords.sentActive(s)) {
            Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onUpdate, modifier = Modifier.heightIn(min = 48.dp)) { Text("Update", color = c.fg) }
                TextButton(onClick = { unsend = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Unsend", color = c.fault) }
            }
        }
    }
    if (unsend) {
        ConfirmDialog(
            title = "Unsend '${s.title}'?",
            text = ShareWords.unsendBody(s),
            confirmLabel = "Unsend",
            onConfirm = {
                unsend = false
                onUnsend()
            },
            onDismiss = { unsend = false },
            destructive = true,
        )
    }
}

/** Width for a card in a thread: most of the row, never the whole. */
val CARD_MAX = 420.dp
