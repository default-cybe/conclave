@file:OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.conclave.app.ui.common.ModelName
import dev.conclave.app.ui.motion.Fold
import dev.conclave.app.ui.motion.Knot
import dev.conclave.app.ui.motion.LiveState
import dev.conclave.app.ui.motion.LiveStatus
import dev.conclave.app.ui.motion.Step
import dev.conclave.app.ui.motion.Steps
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.ChatLive
import dev.conclave.client.logic.ChatSources
import dev.conclave.client.logic.ChatTools
import dev.conclave.client.logic.ChatUnit
import dev.conclave.client.logic.LivePhase
import dev.conclave.client.logic.ModelRefs
import dev.conclave.client.logic.NextModel
import dev.conclave.client.logic.Source
import dev.conclave.client.logic.TurnPiece
import dev.conclave.client.logic.Work
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.DocumentBlock
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.plainText
import dev.conclave.client.motion.KnotState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** What a reply's actions do; the screen owns the pickers and dialogs. */
class ReplyActions(
    val retry: (ChatUnit.Reply) -> Unit,
    val retryWith: (ChatUnit.Reply) -> Unit,
    val branch: (ChatUnit.Reply) -> Unit,
    val askAnother: (ChatUnit.Reply) -> Unit,
    val continueAsSession: () -> Unit,
    val forgetNote: (String, () -> Unit) -> Unit,
    val openMemory: () -> Unit,
    val switchModel: () -> Unit,
    /** Send to friend, in the "..." sheet; null when the chat cannot go to a friend. */
    val sendToFriend: (() -> Unit)? = null,
)

/** A quiet text action under a message: 13.5sp fg-3, a 40dp touch target. [enabled] false while its call is out. */
@Composable
fun Act(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Conclave.colors
    Box(
        modifier.heightIn(min = 40.dp).clip(RoundedCornerShape(3.dp)).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = ConclaveType.meta.copy(fontSize = ConclaveType.body.fontSize * 0.9f), color = c.fg3, maxLines = 1)
    }
}

/**
 * "Try the next model" (NextModel): in a refused reply's action row and
 * under the refusal notice that offers it. "Trying" while the hub takes it.
 */
@Composable
fun NextModelAct(busy: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Act(if (busy) NextModel.BUSY else NextModel.LABEL, onClick = onClick, modifier = modifier, enabled = !busy)
}

/**
 * A tap that runs [action] (and says so to screen readers), with no ripple:
 * your message's actions. A long press is left to the text inside, which
 * selects (SelectionContainer); it never opens anything, so a press held
 * and let go does not count as a tap either.
 */
@Composable
internal fun Modifier.tapForActions(label: String, action: () -> Unit): Modifier {
    val latest = rememberUpdatedState(action)
    return pointerInput(Unit) { detectTapGestures(onTap = { latest.value() }, onLongPress = { }) }
        .semantics { onClick(label = label) { latest.value(); true } }
}

/** A row of fg-3 meta text, at least 25dp tall. */
@Composable
private fun Line(text: String, modifier: Modifier = Modifier, failed: Boolean = false) {
    val c = Conclave.colors
    Box(modifier.heightIn(min = 26.dp).padding(vertical = 2.dp), contentAlignment = Alignment.CenterStart) {
        Text(text, style = ConclaveType.meta, color = if (failed) c.fault else c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** Text under a hairline rule on its left (a thought, the notes, a quote). */
@Composable
private fun Ruled(content: @Composable () -> Unit) {
    val c = Conclave.colors
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(Modifier.width(1.dp).fillMaxHeight().background(c.rule2))
        Spacer(Modifier.width(12.dp))
        Box(Modifier.weight(1f)) { content() }
    }
}

// ---------------------------------------------------------------------------
// Your messages
// ---------------------------------------------------------------------------

/**
 * Your message (MOBILE-V2 5): right aligned in a bubble of the second
 * surface, 20dp corners, up to 85% of the width, 16sp; attachments above
 * it. Nothing under it but the notes memory gave the model, when it gave
 * some. A tap opens Copy and Edit in a sheet; a long press selects the text.
 */
@Composable
fun UserBubble(
    message: Message?,
    text: String,
    images: List<ImageBlock>,
    files: List<String>,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
    /** The quiet line of one sent while the chat worked: "Queued" (docs/design/CHAT-AND-MOTION.md 2.11). */
    label: String? = null,
    /** Given while it waits: the x before the label takes it off. */
    onRemove: (() -> Unit)? = null,
    /** Given for one Stop held: Send after the label runs it. */
    onSend: (() -> Unit)? = null,
    /** Notes from memory the hub gave the model with this message. */
    recalled: Int = 0,
    onOpenMemory: () -> Unit = {},
) {
    val c = Conclave.colors
    var shown by remember { mutableStateOf<ImageBlock?>(null) }
    shown?.let { FullImage(it, onDismiss = { shown = null }) }
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val max = maxWidth * 0.85f
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
            images.forEach { img ->
                val open = if (img.data.isNullOrBlank()) Modifier else Modifier.clickable(onClickLabel = "Open full screen") { shown = img }
                Box(Modifier.padding(bottom = 6.dp).widthIn(max = max)) { ChatImage(img, maxHeight = 160.dp, modifier = open) }
            }
            files.forEach { name ->
                Text(name, style = ConclaveType.meta, color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = max).padding(bottom = 6.dp).clip(RoundedCornerShape(12.dp)).background(c.surface2).padding(horizontal = 12.dp, vertical = 8.dp))
            }
            if (text.isNotBlank()) {
                val tap = if (message == null) Modifier else Modifier.tapForActions("Message actions", onTap)
                Box(
                    Modifier
                        .widthIn(max = max)
                        .clip(RoundedCornerShape(20.dp))
                        .background(c.surface2)
                        .then(tap)
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    SelectionContainer { Text(text, style = ConclaveType.chat, color = c.fg) }
                }
            }
            if (label != null) {
                // one height with or without the x, so the line stays put when the message takes the waiting one's place
                Row(Modifier.padding(top = 2.dp).height(28.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (onRemove != null) {
                        Box(Modifier.size(width = 36.dp, height = 28.dp).clickable(onClickLabel = "Remove", onClick = onRemove), contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Close, contentDescription = "Remove", tint = c.fg3, modifier = Modifier.size(16.dp))
                        }
                    }
                    Text(label, style = ConclaveType.meta, color = c.fg3)
                    if (onSend != null) Text("Send", style = ConclaveType.meta, color = c.fg2, modifier = Modifier.clickable(onClickLabel = "Send", onClick = onSend).padding(horizontal = 10.dp, vertical = 4.dp))
                }
            }
            if (message != null && recalled > 0) {
                Act(if (recalled == 1) "Used 1 note from memory" else "Used $recalled notes from memory", onClick = onOpenMemory)
            }
        }
    }
}

/**
 * An image in a message: at most [maxHeight] tall, 5dp corners and a 1dp
 * rule. Decoded off the main thread at about the size it shows.
 */
@Composable
fun ChatImage(block: ImageBlock, maxHeight: Dp, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val data = block.data
    val target = with(LocalDensity.current) { (maxHeight * 2).roundToPx() }
    val bitmap by produceState<ImageBitmap?>(null, data, target) {
        value = if (data.isNullOrBlank()) null else withContext(Dispatchers.Default) { decodeScaled(data, target) }
    }
    val img = bitmap
    if (img != null) {
        Image(
            bitmap = img,
            contentDescription = "Image",
            contentScale = ContentScale.Fit,
            modifier = modifier.heightIn(max = maxHeight).clip(RoundedCornerShape(5.dp)).border(1.dp, c.rule, RoundedCornerShape(5.dp)),
        )
    } else if (data.isNullOrBlank()) {
        Text("Image", style = ConclaveType.meta, color = c.fg3, modifier = modifier.border(1.dp, c.rule, RoundedCornerShape(5.dp)).padding(horizontal = 10.dp, vertical = 6.dp))
    }
}

/** An image you attached, over everything and fitted to the screen: pinch to zoom, a tap, Back or Close shuts it. */
@Composable
private fun FullImage(block: ImageBlock, onDismiss: () -> Unit) {
    val data = block.data
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black).clickable(onClickLabel = "Close", onClick = onDismiss), contentAlignment = Alignment.Center) {
            val target = maxOf(constraints.maxWidth, constraints.maxHeight)
            val bitmap by produceState<ImageBitmap?>(null, data, target) {
                value = if (data.isNullOrBlank()) null else withContext(Dispatchers.Default) { decodeScaled(data, target) }
            }
            var scale by remember { mutableFloatStateOf(1f) }
            var offset by remember { mutableStateOf(Offset.Zero) }
            val zoom = rememberTransformableState { z, pan, _ ->
                scale = (scale * z).coerceIn(1f, 5f)
                offset = if (scale == 1f) Offset.Zero else offset + pan
            }
            bitmap?.let {
                Image(
                    bitmap = it,
                    contentDescription = "Attached image",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().transformable(zoom).graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
                )
            }
            IconButton(onClick = onDismiss, modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(8.dp)) {
                Icon(Icons.Outlined.Close, contentDescription = "Close", tint = Color.White)
            }
        }
    }
}

/** A bitmap no more than about [target] px on its long side, or null when the data is not an image. */
internal fun decodeScaled(data: String, target: Int): ImageBitmap? =
    runCatching { java.util.Base64.getDecoder().decode(data) }.getOrNull()?.let { decodeScaled(it, target) }

/** The same from raw bytes (a shared file's preview in FileCards.kt). */
internal fun decodeScaled(bytes: ByteArray, target: Int): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= target) sample *= 2
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}.getOrNull()

/** The editor that replaces your bubble while you edit it: focused, the cursor at the end. Back cancels. */
@Composable
fun EditBubble(initial: String, onCancel: () -> Unit, onSend: (String) -> Unit) {
    val c = Conclave.colors
    var value by remember { mutableStateOf(TextFieldValue(initial, TextRange(initial.length))) }
    val text = value.text
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    BackHandler(onBack = onCancel)
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Box(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(5.dp)).background(c.bgSunk).border(1.dp, c.rule2, RoundedCornerShape(5.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            androidx.compose.foundation.text.BasicTextField(
                value = value,
                onValueChange = { value = it },
                textStyle = ConclaveType.chat.copy(color = c.fg),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(c.signal),
                maxLines = 12,
                modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "Edit your message" },
            )
        }
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCancel, shape = RoundedCornerShape(5.dp)) { Text("Cancel", style = ConclaveType.button, color = c.fg2) }
            Spacer(Modifier.width(6.dp))
            Box(
                Modifier.clip(RoundedCornerShape(5.dp)).background(if (text.isNotBlank()) c.solid else c.rule).clickable(enabled = text.isNotBlank()) { onSend(text) }.padding(horizontal = 14.dp, vertical = 8.dp),
            ) {
                Text("Send", style = ConclaveType.button, color = if (text.isNotBlank()) c.solidFg else c.fg3)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/**
 * One reply: thinking, tool rows and text in the order they came, then the
 * sources and the action row. While it is written ([live]) the Knot at its
 * foot says what the model is doing, with the step next to it ("Searching
 * the web", "Writing"). One Knot per chat. A long press on its text selects
 * it (SelectionContainer, markdown and code blocks too); the actions are
 * the row at its end: Copy, Retry and More, on every finished reply.
 */
@Composable
fun ReplyView(
    reply: ChatUnit.Reply,
    isLast: Boolean,
    live: Boolean,
    phase: LivePhase,
    startedAt: Long?,
    results: Map<String, ToolResultBlock>,
    failed: Boolean,
    actions: ReplyActions,
    thoughtMs: Map<String, Long> = emptyMap(),
    /** An approval or a question is open: the Knot freezes in amber, "Waiting on you". */
    waiting: Boolean = false,
    /** The chat waits for a provider limit to reset: the Knot draws back to a grey stub and rests; when the reply starts again it writes on from it. */
    resuming: Boolean = false,
    /** One more action in the row, after Retry, when it applies ("Try the next model" on a refused reply). */
    extra: (@Composable () -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    // a thought that ends the reply streams while the reply thinks
    val thinking = live && phase == LivePhase.THINKING
    val pieces = remember(reply.messages, thinking) { Work.pieces(reply.messages, thinking) }
    val lastText = Work.lastText(pieces)
    val text = remember(reply.messages) { reply.text }
    val sources = remember(live, text, reply.messages, results) { if (live) emptyList() else ChatSources.of(text, ChatSources.results(reply.messages, results)) }
    // the reply ended without finishing: it failed, or it waits for a limit to reset; its Knot says so in place
    val held: KnotState? = if (isLast && !live) (if (failed) KnotState.FAILED else if (resuming) KnotState.PAUSED else null) else null
    if (pieces.isEmpty() && !live && held == null) return

    // One Knot per reply, at its foot, from the moment you send until it is done (spec 1.9): it
    // thinks while nothing has arrived and while a thought streams, works while a tool runs or
    // text streams, waits in amber while you are asked, and settles into the still grey knot
    // when the reply ends. A failure stops the stroke where it is and turns it the fault color;
    // a limit draws it back to a grey stub that writes on when the reply starts again. It is the
    // same Knot the whole time, so every change starts from the frame it was on. The status line
    // next to it says the step (Steps).
    val running = if (live) pieces.filterIsInstance<TurnPiece.Work>().flatMap { Work.calls(it.entries) }.filter { results[it.id] == null } else emptyList()
    // a finished reply has no mark: its icons are enough (MOBILE-V2 5)
    val foot: KnotState? = when {
        !isLast -> null
        live && waiting -> KnotState.WAITING
        live -> if (phase == LivePhase.WRITING || phase == LivePhase.TOOL) KnotState.TOOL else KnotState.THINKING
        else -> held
    }
    val step: Step? = when {
        !live -> null
        phase == LivePhase.TOOL -> ChatTools.runningStep(running)?.let { Step(it.words, it.detail, id = running.joinToString(" ") { u -> u.id }) }
        phase == LivePhase.WRITING -> WRITING
        else -> null
    }
    // between two steps the last one stays on the line, so a quick gap never flashes a new word
    val lastStep = remember { arrayOfNulls<Step>(1) }
    if (step != null) lastStep[0] = step
    val shownStep = step ?: if (live && phase == LivePhase.BETWEEN) lastStep[0] else null

    Column(modifier.fillMaxWidth()) {
        pieces.forEachIndexed { i, p ->
            androidx.compose.runtime.key(p.key) {
                when (p) {
                    is TurnPiece.Block -> when (val b = p.block) {
                        is ImageBlock -> Box(Modifier.padding(vertical = 8.dp)) { ChatImage(b, maxHeight = 320.dp) }
                        is TextBlock -> {
                            val on = live && phase == LivePhase.WRITING && p.last && p.message.stopReason == null
                            // a long press selects: paragraphs, lists, tables and code blocks alike
                            SelectionContainer { ChatProse(b.text, streaming = on, modifier = Modifier.padding(vertical = 4.dp)) }
                        }
                        else -> Unit
                    }
                    // the thoughts and calls between two pieces of text: one row (TurnWork); a lone thought folds as it did
                    is TurnPiece.Work -> TurnWork(
                        p.entries,
                        results,
                        live = live && i > lastText,
                        turnLive = live,
                        cwd = null,
                        measured = thoughtMs,
                        onForget = actions.forgetNote,
                        onOpenMemory = actions.openMemory,
                    ) { t ->
                        val block = t.block
                        if (block is ThinkingBlock) ThoughtFold(block, t.streaming, thoughtMs[t.message.id]) else Line("The provider hid this reasoning.")
                    }
                }
            }
        }
        if (sources.isNotEmpty()) SourcesLine(sources)
        // the last reply: the working line while it is written, then its icons; an earlier one: its icons, quieter
        if (isLast || !live) {
            Foot(reply, text, foot, live, startedAt, actions, quiet = !isLast, extra = extra) {
                when {
                    !live -> Unit
                    waiting -> LiveStatus(LiveState.WAITING, mark = false)
                    phase == LivePhase.WAITING -> LateThinking(startedAt)
                    shownStep != null -> Steps(shownStep)
                }
            }
        }
    }
}

private val WRITING = Step("Writing")

/**
 * "Thinking 4s" next to the Knot before anything arrives. The words wait
 * 400ms, so a fast first token never shows them; their place is held so
 * nothing moves when they come.
 */
@Composable
private fun LateThinking(startedAt: Long?) {
    val mounted = remember { System.currentTimeMillis() }
    val since = startedAt ?: mounted
    var late by remember { mutableStateOf(System.currentTimeMillis() - since >= 400) }
    LaunchedEffect(since) {
        val wait = 400 - (System.currentTimeMillis() - since)
        if (wait > 0) delay(wait)
        late = true
    }
    Box(Modifier.graphicsLayer { alpha = if (late) 1f else 0f }) {
        LiveStatus(LiveState.THINKING, startedAt = since, mark = false)
    }
}

/**
 * A reply on its way before the hub has it: the Knot thinking at what will
 * be the reply's foot, and "Thinking 4s" after 400ms. The reply that takes
 * its place keeps the Knot's place in the loop.
 */
@Composable
fun PendingReplyLine(startedAt: Long?) {
    val mounted = remember { System.currentTimeMillis() }
    val since = startedAt ?: mounted
    Row(Modifier.fillMaxWidth().heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
        Knot(KnotState.THINKING, size = 16.dp, since = since)
        Spacer(Modifier.width(8.dp))
        LateThinking(since)
    }
}

/**
 * The thought (Fold): while it streams the row reads "Thinking" in violet
 * over it, and the new words come in with Ink. In the same frame the answer
 * starts it turns into "Thought for 12s" and folds closed. A tap opens it.
 */
@Composable
private fun ThoughtFold(block: ThinkingBlock, live: Boolean, measuredMs: Long?) {
    val text = block.thinking.trim()
    val words = text.split(Regex("\\s+")).count { it.isNotEmpty() }
    // the hub stores the time when the message ends; until then the phone's own measure
    val label = (block.durationMs ?: measuredMs)?.let { ChatLive.thoughtFor(it) } ?: "Thought, $words ${if (words == 1) "word" else "words"}"
    Fold(live = live, label = label) {
        ChatProse(text, streaming = live, color = Conclave.colors.fg2, style = ConclaveType.meta.copy(lineHeight = ConclaveType.meta.fontSize * 1.6f))
    }
}

/** "Sources  1 caddyserver.com  2 tailscale.com": numbered hosts as links. No chips. */
@Composable
private fun SourcesLine(list: List<Source>) {
    val c = Conclave.colors
    val text = buildAnnotatedString {
        append("Sources")
        addStyle(SpanStyle(color = c.fg3), 0, length)
        list.forEach { s ->
            append("   ")
            val n = length
            append(s.n.toString())
            addStyle(SpanStyle(color = c.fg3), n, length)
            append(" ")
            val h = length
            append(s.host)
            addLink(LinkAnnotation.Url(s.url, TextLinkStyles(SpanStyle(color = c.fg2, textDecoration = TextDecoration.Underline))), h, length)
        }
    }
    Text(text, style = ConclaveType.meta.copy(lineHeight = ConclaveType.meta.fontSize * 1.8f), modifier = Modifier.padding(top = 8.dp))
}

/**
 * The end of a reply (MOBILE-V2 5, as Claude's apps): while the last one is
 * written, the animated mark and the step in words; once it is done, the
 * icon row, always in view: Copy, Retry, [extra] and More, in fg-3 under
 * the last reply and fg-4 under earlier ones ([quiet]). A reply that failed
 * or waits for a limit keeps its mark there.
 */
@Composable
private fun Foot(
    reply: ChatUnit.Reply,
    text: String,
    mark: KnotState?,
    live: Boolean,
    startedAt: Long?,
    actions: ReplyActions,
    quiet: Boolean = false,
    extra: (@Composable () -> Unit)? = null,
    status: @Composable () -> Unit,
) {
    val c = Conclave.colors
    var more by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        if (mark != null) {
            Knot(mark, size = 16.dp, since = if (mark == KnotState.THINKING) startedAt else null)
            Spacer(Modifier.width(8.dp))
        }
        if (live) {
            Box(Modifier.weight(1f)) { status() }
        } else {
            // the icons line up with the text: their own padding is taken back
            Row(Modifier.offset(x = if (mark == null) (-12).dp else 0.dp), verticalAlignment = Alignment.CenterVertically) {
                val tint = if (quiet) c.fg4 else c.fg3
                // a reply stopped before it wrote anything has nothing to copy
                if (text.isNotBlank()) CopyIcon(tint) { text }
                if (reply.user != null) FootIcon(Icons.Outlined.Refresh, "Retry", tint) { actions.retry(reply) }
                extra?.invoke()
                FootIcon(Icons.Outlined.MoreHoriz, "More actions", tint) { more = true }
            }
        }
    }
    if (more) ReplySheet(reply, actions, onDismiss = { more = false })
}

/** An icon under a reply: fg-3 (fg-4 under an earlier one), 48dp to touch. */
@Composable
private fun FootIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, tint: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp)) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(18.dp), tint = tint)
    }
}

/** Copy that turns into a check for 1.5s (Swap). No toast. */
@Composable
private fun CopyIcon(tint: androidx.compose.ui.graphics.Color, text: () -> String) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    val c = Conclave.colors
    IconButton(onClick = { copyText(context, text()); copied = true }, modifier = Modifier.size(48.dp)) {
        Swap(on = copied, off = { Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy", modifier = Modifier.size(18.dp), tint = tint) }) {
            Icon(Icons.Outlined.Check, contentDescription = "Copied", modifier = Modifier.size(18.dp), tint = c.fg2)
        }
    }
}

/** "..." under a reply: the rest of its actions in a sheet (Copy and Retry are in the row). */
@Composable
fun ReplySheet(reply: ChatUnit.Reply, actions: ReplyActions, onDismiss: () -> Unit) {
    val c = Conclave.colors
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            if (reply.user != null) SheetRow("Retry with…") { onDismiss(); actions.retryWith(reply) }
            SheetRow("Ask another model") { onDismiss(); actions.askAnother(reply) }
            SheetRow("Branch") { onDismiss(); actions.branch(reply) }
            SheetRow("Move to Code") { onDismiss(); actions.continueAsSession() }
            actions.sendToFriend?.let { send -> SheetRow("Send to friend") { onDismiss(); send() } }
        }
    }
}

@Composable
fun SheetRow(label: String, danger: Boolean = false, onClick: () -> Unit) {
    val c = Conclave.colors
    Box(Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(onClick = onClick).padding(horizontal = 20.dp), contentAlignment = Alignment.CenterStart) {
        Text(label, style = ConclaveType.rowTitle, color = if (danger) c.fault else c.fg)
    }
}

/**
 * The failed line at the end of a reply: "Failed." in red, the reason, and
 * what to do. The reply's own Knot is the stroke that stopped and turned
 * the fault color, right above this line; [mark] puts a Knot here only when
 * the turn failed before any reply showed one.
 */
@Composable
fun FailedLine(reason: String?, onRetry: (() -> Unit)?, onSwitch: () -> Unit, mark: Boolean = true) {
    val c = Conclave.colors
    // with a mark the words line up after it; without one they start at the edge, and the
    // actions' own 8dp padding is taken back so their words line up too
    val indent = if (mark) 22.dp else 0.dp
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (mark) {
                Knot(KnotState.FAILED, size = 14.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text("Failed.", style = ConclaveType.meta, color = c.fault)
        }
        if (!reason.isNullOrBlank()) Text(reason, style = ConclaveType.meta, color = c.fg2, modifier = Modifier.padding(start = indent, top = 2.dp))
        Row(Modifier.padding(start = indent).offset(x = (-8).dp)) {
            if (onRetry != null) Act("Retry", onClick = onRetry)
            Act("Switch model", onClick = onSwitch)
        }
    }
}

/** A second opinion: indented under a hairline rule, with Continue and Dismiss until something follows it. */
@Composable
fun AsideView(message: Message, pending: Boolean, onContinue: () -> Unit, onDismiss: () -> Unit, streaming: Boolean) {
    val c = Conclave.colors
    val name = ModelRefs.displayName(message.model).ifBlank { message.author ?: "another model" }
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Second opinion from ", style = ConclaveType.meta.copy(fontWeight = FontWeight.SemiBold), color = c.fg2)
            ModelName(message.model, size = 13.dp, style = ConclaveType.meta.copy(fontWeight = FontWeight.SemiBold), color = c.fg2, asModel = true)
        }
        Spacer(Modifier.height(6.dp))
        Ruled { SelectionContainer { ChatProse(message.content.plainText(), streaming = streaming, color = c.fg2) } }
        if (pending && !streaming) {
            Row(Modifier.padding(start = 5.dp, top = 2.dp)) {
                if (!message.model.isNullOrBlank()) Act("Continue with $name", onClick = onContinue)
                Act("Dismiss", onClick = onDismiss)
            }
        }
    }
}

/** A notice line ("Stopped by you.", errors, limits) or "Switched to GPT-5.5.". */
@Composable
fun NoticeText(text: String) {
    Line(text, Modifier.fillMaxWidth())
}

/** Images and file names a user message carries. */
fun imagesOf(content: List<ContentBlock>): List<ImageBlock> = content.filterIsInstance<ImageBlock>()
fun filesOf(content: List<ContentBlock>): List<String> = content.filterIsInstance<DocumentBlock>().map { it.title ?: it.mediaType }
