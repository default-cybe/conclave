package dev.conclave.app.ui.common

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FriendWords

/** Opens the side panel. Null where the panel always shows (840dp and wider): no menu button then. */
val LocalOpenPanel = compositionLocalOf<(() -> Unit)?> { null }

/** Starts a new conversation: Home, in the mode of where you are. Null before the app is paired. */
val LocalNewChat = compositionLocalOf<(() -> Unit)?> { null }

/** What New says for a screen reader: "New chat", "New assistant chat" or "New session" (docs/DESIGN.md 15). */
val LocalNewWords = compositionLocalOf { "New chat" }

/** The Inbox in the top bar: how many things wait there, and how to open it. */
data class InboxBadge(val count: Int, val open: () -> Unit)

/** Null before the app is paired: no Inbox button then. */
val LocalInbox = compositionLocalOf<InboxBadge?> { null }

/** What waits in the Inbox: approvals, questions, alerts, and requests, notes and shares from friends. */
@Composable
fun rememberInboxCount(): Int {
    val hub = LocalAppContainer.current.hub
    val approvals by hub.approvals.collectAsStateWithLifecycle()
    val questions by hub.questions.collectAsStateWithLifecycle()
    val alerts by hub.alerts.collectAsStateWithLifecycle()
    val friends by hub.friends.collectAsStateWithLifecycle()
    val notes by hub.friendNotes.collectAsStateWithLifecycle()
    val shares by hub.receivedShares.collectAsStateWithLifecycle()
    val fromFriends = remember(friends, notes, shares) { FriendWords.waiting(FriendWords.inbox(friends, notes, shares)) }
    return approvals.size + questions.size + alerts.size + fromFriends
}

/** An icon button with its words for screen readers; 48dp to touch, the glyph 22dp. */
@Composable
fun BarButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    IconButton(onClick = onClick, modifier = modifier.size(48.dp)) {
        Icon(icon, contentDescription = label, tint = Conclave.colors.fg2, modifier = Modifier.size(22.dp))
    }
}

/**
 * The top bar of every main screen (MOBILE-V2 1): 56dp, no border. The
 * menu button on the left (a back arrow on a page behind More, [onBack]),
 * the title in the middle (17sp semibold, one line; on a conversation a tap
 * opens its sheet, [onTitle]), and New chat on the right after any
 * [actions]. The title stays centered on the bar whatever the sides hold.
 * [titleContent] takes the title's place: Home's Chat, Assistant and Code
 * switch (docs/DESIGN.md 15). On a main screen (no [onBack]) the Inbox shows
 * as a small icon with its count while approvals, questions or anything
 * else wait there; the side panel no longer lists it. [inbox] false hides
 * it (the Inbox itself).
 */
@Composable
fun TopBar(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    onTitle: (() -> Unit)? = null,
    /** What a tap on the title does, for screen readers. */
    titleAction: String = "Conversation details",
    newChat: Boolean = true,
    inbox: Boolean = true,
    titleContent: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = Conclave.colors
    val openPanel = LocalOpenPanel.current
    val startNew = LocalNewChat.current
    val newWords = LocalNewWords.current
    val waiting = LocalInbox.current?.takeIf { inbox && onBack == null && it.count > 0 }
    Layout(
        content = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                when {
                    onBack != null -> BarButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack)
                    openPanel != null -> BarButton(Glyphs.Menu, "Menu", openPanel)
                }
            }
            Box(contentAlignment = Alignment.Center) {
                if (titleContent != null) {
                    titleContent()
                } else {
                    val tap = if (onTitle != null) {
                        Modifier.clip(RoundedCornerShape(5.dp)).clickable(onClickLabel = titleAction, role = Role.Button, onClick = onTitle)
                    } else {
                        Modifier
                    }
                    Text(
                        title,
                        style = ConclaveType.title,
                        color = c.fg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center,
                        modifier = tap.semantics { heading() }.padding(horizontal = 8.dp, vertical = 12.dp),
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                actions()
                if (waiting != null) InboxButton(waiting.count, waiting.open)
                if (newChat && startNew != null) BarButton(Glyphs.NewChat, newWords, startNew)
            }
        },
        modifier = modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 4.dp),
    ) { measurables, constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val start = measurables[0].measure(loose)
        val end = measurables[2].measure(loose)
        // the title gets the middle, as wide as the wider side allows on both
        val side = maxOf(start.width, end.width)
        val titleWidth = (constraints.maxWidth - 2 * side).coerceAtLeast(0)
        val middle = measurables[1].measure(loose.copy(maxWidth = titleWidth))
        val height = constraints.maxHeight
        layout(constraints.maxWidth, height) {
            start.placeRelative(0, (height - start.height) / 2)
            middle.placeRelative((constraints.maxWidth - middle.width) / 2, (height - middle.height) / 2)
            end.placeRelative(constraints.maxWidth - end.width, (height - end.height) / 2)
        }
    }
}

/** The Inbox in the bar: its icon and the count in the accent, 48dp high to touch. */
@Composable
private fun InboxButton(count: Int, onClick: () -> Unit) {
    val c = Conclave.colors
    val words = if (count == 1) "Inbox, 1 waiting" else "Inbox, $count waiting"
    Row(
        Modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(24.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = words }
            .padding(start = 12.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Inbox, contentDescription = null, tint = c.fg2, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(4.dp))
        Text(if (count > 99) "99+" else count.toString(), style = ConclaveType.metaNum.copy(fontSize = 14.sp, fontWeight = FontWeight.Medium), color = c.warn)
    }
}
