package dev.conclave.app.ui.friends

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.data.FriendMoments
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.KnotRope
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FriendTone
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.logic.QrCode
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.FriendReachability
import dev.conclave.client.model.Session
import dev.conclave.client.motion.RopeMoment
import kotlinx.coroutines.delay

/*
 * Pieces the friends screens share (the web's features/friends/parts.tsx):
 * the verified badge, the safety code in groups, a short key, the line
 * about whether friends reach this hub, the block a key change puts in
 * front of a friend, the invite's QR code, and the knot moments.
 */

/** How long a played moment stays before it goes. */
private const val HOLD_MS = 1_200L

@Composable
fun friendTone(t: FriendTone): Color {
    val c = Conclave.colors
    return when (t) {
        FriendTone.OK -> c.ok
        FriendTone.WARN -> c.warn
        FriendTone.FAULT -> c.fault
        FriendTone.DIM -> c.fg3
    }
}

/** "Verified" with a shield, in ok: the owner compared the safety code with this friend. */
@Composable
fun VerifiedBadge(modifier: Modifier = Modifier) {
    val c = Conclave.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.VerifiedUser, contentDescription = null, tint = c.ok, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(4.dp))
        Text("Verified", style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium), color = c.ok)
    }
}

/** The safety code: four groups of five digits, two by two, the way people read it out. */
@Composable
fun SafetyCode(code: String, modifier: Modifier = Modifier, large: Boolean = false) {
    val c = Conclave.colors
    val groups = FriendWords.safetyGroups(code)
    val style = ConclaveType.metaNum.copy(fontSize = if (large) 20.sp else 17.sp, lineHeight = if (large) 27.sp else 24.sp, fontWeight = FontWeight.Medium)
    Column(modifier.semantics { contentDescription = "Safety code ${groups.joinToString(" ")}" }) {
        groups.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(if (large) 16.dp else 12.dp)) {
                row.forEach { g -> Text(g, style = style, color = c.fg) }
            }
        }
    }
}

/** "3f9a 12c0 8e41 07b2" in mono. */
@Composable
fun ShortKey(fp: String, modifier: Modifier = Modifier, color: Color = Conclave.colors.fg3) {
    Text(FriendWords.shortFingerprint(fp), style = CodeStyle, color = color, modifier = modifier)
}

/** A whole key, in mono lines. */
@Composable
fun KeyLines(fp: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        FriendWords.fingerprintLines(fp).forEach { Text(it, style = CodeStyle, color = Conclave.colors.fg) }
    }
}

/** A bar of [color] down the left of [content], as the web's border-l-2 blocks. */
@Composable
fun Barred(color: Color, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Row(modifier.height(IntrinsicSize.Min)) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(color))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f).padding(vertical = 2.dp)) { content() }
    }
}

/**
 * Friends cannot reach this hub: says so plainly with Remote access. When
 * they can: one quiet line with the address they get.
 */
@Composable
fun ReachLine(r: FriendReachability?, onOpenRemote: () -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val w = FriendWords.reachWords(r) ?: return
    Column(modifier) {
        if (w.ok) {
            Text(w.title + (w.detail?.let { " $it" } ?: ""), style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg2)
            return@Column
        }
        Text(w.title, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.warn)
        w.why?.let { Text(it, style = ConclaveType.body, color = c.fg) }
        w.detail?.let { Text(it, style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg3, modifier = Modifier.padding(top = 4.dp)) }
        TextButton(onClick = onOpenRemote, modifier = Modifier.padding(top = 2.dp)) { Text("Open Remote access", color = c.fg) }
    }
}

/**
 * A friend's hub answered with a key its old key did not sign: nothing moves
 * until the owner confirms the new key (after asking the friend) or removes
 * the friend.
 */
@Composable
fun KeyChange(f: FriendDto, onConfirm: () -> Unit, onRemove: () -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    var ask by remember { mutableStateOf<String?>(null) }
    Barred(c.fault, modifier) {
        Text("${f.name}'s hub has a new key", style = ConclaveType.rowTitle.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold), color = c.fault)
        Text(
            (f.blockedReason ?: "${f.name}'s hub answers with a new key its old key did not sign. Nothing is sent or taken until you confirm it.") +
                " Ask ${f.name} if they set their hub up again. If they did not, someone else may hold the address.",
            style = ConclaveType.body,
            color = c.fg2,
            modifier = Modifier.padding(top = 4.dp),
        )
        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Old key", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.width(72.dp))
            ShortKey(f.fingerprint, color = c.fg2)
        }
        f.pendingFingerprint?.let { fp ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("New key", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.width(72.dp))
                ShortKey(fp, color = c.fg)
            }
        }
        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { ask = "confirm" }, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.heightIn(min = 48.dp)) { Text("Confirm new key") }
            TextButton(onClick = { ask = "remove" }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Remove ${f.name}", color = c.fault) }
        }
    }
    when (ask) {
        "confirm" -> ConfirmDialog(
            title = "Take ${f.name}'s new key?",
            text = "Only if ${f.name} told you they set their hub up again. What waits for them is sealed for the new key, and the safety code changes: compare the new one with ${f.name}.",
            confirmLabel = "Confirm new key",
            onConfirm = {
                ask = null
                onConfirm()
            },
            onDismiss = { ask = null },
        )
        "remove" -> RemoveDialog(f, onRemove = {
            ask = null
            onRemove()
        }, onDismiss = { ask = null })
    }
}

/** Remove a friend, after asking. */
@Composable
fun RemoveDialog(f: FriendDto, onRemove: () -> Unit, onDismiss: () -> Unit) {
    ConfirmDialog(
        title = "Remove ${f.name}?",
        text = "${f.name}'s hub is asked to stop too, and what waits to go to them is cancelled. Nothing more goes either way. Notes you have stay here.",
        confirmLabel = "Remove",
        onConfirm = onRemove,
        onDismiss = onDismiss,
        destructive = true,
    )
}

/**
 * The invite's QR code, read from the hub's SVG and drawn module by module,
 * dark on white whatever the theme, with the quiet zone the SVG carries.
 * Devices, Pair a device draws its code with it too ([label], [fallback]).
 */
@Composable
fun InviteQr(
    svg: String,
    modifier: Modifier = Modifier,
    size: Dp = 200.dp,
    label: String = "QR code of the invite link",
    fallback: String = "The code did not draw. Copy the link instead.",
) {
    val matrix = remember(svg) { QrCode.parse(svg) }
    Box(
        modifier
            .size(size + 32.dp)
            .background(Color.White, RoundedCornerShape(12.dp))
            .border(1.dp, Conclave.colors.rule, RoundedCornerShape(12.dp))
            .padding(16.dp)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (matrix == null) {
            Text(fallback, style = ConclaveType.meta, color = Color(0xFF555555))
            return@Box
        }
        Canvas(Modifier.size(size)) {
            val n = matrix.size
            val cell = this.size.minDimension / n
            for (y in 0 until n) {
                var x = 0
                while (x < n) {
                    if (!matrix[x, y]) {
                        x++
                        continue
                    }
                    // one rect per run of dark modules, a hair wider so no seam shows
                    var end = x
                    while (end < n && matrix[end, y]) end++
                    drawRect(Color.Black, topLeft = Offset(x * cell, y * cell), size = Size((end - x) * cell + 0.5f, cell + 0.5f))
                    x = end
                }
            }
        }
    }
}

/** By a friend just added: the light runs the knot and settles, then goes. */
@Composable
fun FriendAdded(id: String, size: Dp = 16.dp, modifier: Modifier = Modifier) {
    val on by FriendMoments.friends.collectAsState()
    if (id !in on) return
    var played by remember(id) { mutableStateOf(false) }
    LaunchedEffect(played) {
        if (!played) return@LaunchedEffect
        delay(HOLD_MS)
        FriendMoments.playedFriend(id)
    }
    KnotRope(RopeMoment.SUCCESS, modifier = modifier, size = size, label = "Friends now", onDone = { played = true })
}

/** On a share card that arrived while you watched: the rope slides in and ties. */
@Composable
fun ShareArrived(id: String, size: Dp = 14.dp, modifier: Modifier = Modifier) {
    val on by FriendMoments.shares.collectAsState()
    if (id !in on) return
    var played by remember(id) { mutableStateOf(false) }
    LaunchedEffect(played) {
        if (!played) return@LaunchedEffect
        delay(HOLD_MS)
        FriendMoments.playedShare(id)
    }
    KnotRope(RopeMoment.RECEIVE, modifier = modifier, size = size, label = "Just arrived", onDone = { played = true })
}

/**
 * The line under a session made from a friend's share (a fork, a handoff or
 * a reference): whose turns are quoted here, and while the guard holds, that
 * the first turn asks before any tool runs. Open the share when this hub
 * still has it.
 */
@Composable
fun FriendShareLine(session: Session, onOpenShare: ((String) -> Unit)?, modifier: Modifier = Modifier) {
    val words = remember(session.meta) { ShareWords.madeFromWords(session) } ?: return
    val hub = LocalAppContainer.current.hub
    val received by hub.receivedShares.collectAsState()
    val share = received.firstOrNull { r -> r.sessions.any { it.id == session.id } }
    val c = Conclave.colors
    Row(modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(words, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
        if (share != null && onOpenShare != null) {
            TextButton(onClick = { onOpenShare(share.id) }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Open the share", style = ConclaveType.meta, color = c.fg2) }
        }
    }
}

/**
 * Lets a sheet's own rows (ChoiceRow, OptionRow, which carry their 20dp
 * inset) sit in a column already inset by [by] on each side, so their words
 * line up with the rest instead of doubling the inset.
 */
fun Modifier.bleed(by: Dp): Modifier = layout { measurable, constraints ->
    val extra = (by * 2).roundToPx()
    val wider = if (constraints.hasBoundedWidth) constraints.copy(minWidth = constraints.minWidth + extra, maxWidth = constraints.maxWidth + extra) else constraints
    val p = measurable.measure(wider)
    layout((p.width - extra).coerceAtLeast(0), p.height) { p.place(-extra / 2, 0) }
}

/** A row that opens something: 60dp to touch, a chevron at the right. */
@Composable
fun LinkRow(onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Row(
        modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 60.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f)) { content() }
        Spacer(Modifier.width(8.dp))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = Conclave.colors.fg4, modifier = Modifier.size(20.dp))
    }
}

/** Two answers side by side, each half the width: Decline and Accept, with their busy words. */
@Composable
fun AnswerPair(
    no: String,
    yes: String,
    busyNo: String?,
    busyYes: String?,
    onNo: (() -> Unit)?,
    onYes: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val c = Conclave.colors
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (onNo != null) {
            TextButton(onClick = onNo, enabled = enabled && busyNo == null && busyYes == null, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                Swap(on = busyNo != null, off = { Text(no, color = c.fg2) }) { Text(busyNo ?: "", color = c.fg3) }
            }
        }
        Button(onClick = onYes, enabled = enabled && busyNo == null && busyYes == null, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
            Swap(on = busyYes != null, off = { Text(yes) }) { Text(busyYes ?: "") }
        }
    }
}
