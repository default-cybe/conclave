@file:OptIn(ExperimentalFoundationApi::class)

package dev.conclave.app.ui.chat

import dev.conclave.client.model.isReminder
import android.graphics.BitmapFactory
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.common.MarkdownText
import dev.conclave.app.ui.common.ModelMark
import dev.conclave.app.ui.common.ModelName
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.conversation.ChatProse
import dev.conclave.app.ui.conversation.LocalSessionWork
import dev.conclave.app.ui.conversation.SessionWork
import dev.conclave.app.ui.conversation.TurnWork
import dev.conclave.app.ui.conversation.tapForActions
import dev.conclave.app.ui.motion.Fold
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.AgentResult
import dev.conclave.client.logic.ChatLive
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.ModelRefs
import dev.conclave.client.logic.NextModel
import dev.conclave.client.logic.PendingQueue
import dev.conclave.client.logic.TurnPiece
import dev.conclave.client.logic.Work
import dev.conclave.client.logic.Transcript
import dev.conclave.client.model.Attachment
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.DocumentBlock
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.QueuedMessage
import dev.conclave.client.model.RedactedThinkingBlock
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.UnknownBlock
import dev.conclave.client.model.plainText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Base64

/**
 * Your message in a session (MOBILE-V2 5): right aligned in a bubble of
 * the second surface, 20dp corners, up to 85% of the width, 16sp. One sent
 * while the session worked keeps its quiet line under it: "Queued", or
 * "Steered the running turn" (docs/design/CHAT-AND-MOTION.md 2.11). A tap
 * opens its actions; a long press selects its text.
 */
@Composable
fun UserMessage(message: Message, onTap: () -> Unit) {
    val c = Conclave.colors
    SessionBubble(label = PendingQueue.storedWord(message.meta), onTap = onTap) {
        message.content.forEach { block ->
            when (block) {
                // the hub's reminders (recalled notes, the steering note) are for the model, not for the page
                is TextBlock -> if (block.text.isNotBlank() && !block.isReminder()) SelectionContainer { Text(block.text, style = ConclaveType.chat, color = c.fg) }
                is ImageBlock -> InlineImage(block)
                is DocumentBlock -> DocumentChip(block)
                else -> Unit
            }
        }
    }
}

/**
 * A message you sent while the session works, before its turn takes it
 * (docs/design/CHAT-AND-MOTION.md 2.11): your bubble as it will be, and
 * under it an x that takes it off and "Queued" (or "Sending to the running
 * turn"). [local]: the files this app sent with it, so pictures show before
 * the hub has stored them; else their names. When the hub stores it, the
 * message takes this row's place (the same list key, PendingQueue.keyOf)
 * and the label stays where it was.
 */
@Composable
fun PendingUserMessage(item: QueuedMessage, local: List<Attachment>?, onRemove: () -> Unit, onSend: () -> Unit = {}) {
    val c = Conclave.colors
    SessionBubble(label = PendingQueue.pendingWord(item.whenBusy, item.held), onRemove = onRemove, onSend = if (item.held) onSend else null) {
        if (item.text.isNotBlank()) Text(item.text, style = ConclaveType.chat, color = c.fg)
        if (local != null) {
            local.forEach { a ->
                if (a.mediaType.startsWith("image/") && a.data != null) InlineImage(ImageBlock(mediaType = a.mediaType, data = a.data))
                else DocumentChip(DocumentBlock(mediaType = a.mediaType, title = a.name))
            }
        } else {
            item.attachments.forEach { a -> DocumentChip(DocumentBlock(mediaType = a.mediaType, title = a.name)) }
        }
    }
}

/** The bubble of your message and its quiet line: the label, after an x when it can be taken back. A tap runs [onTap]. */
@Composable
private fun SessionBubble(label: String?, onTap: (() -> Unit)? = null, onRemove: (() -> Unit)? = null, onSend: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val c = Conclave.colors
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), contentAlignment = Alignment.CenterEnd) {
        val max = maxWidth * 0.85f
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            // a tap opens the actions; a long press is the text's, which selects
            val press = if (onTap != null) Modifier.tapForActions("Message actions", onTap) else Modifier
            Column(
                Modifier
                    .widthIn(max = max)
                    .clip(RoundedCornerShape(20.dp))
                    .background(c.surface2)
                    .then(press)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                content = content,
            )
            if (label != null) {
                // one height with or without the x, so the line stays put when the message takes the pending one's place
                Row(Modifier.height(28.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (onRemove != null) {
                        Box(Modifier.size(width = 36.dp, height = 28.dp).clickable(onClickLabel = "Remove", onClick = onRemove), contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Close, contentDescription = "Remove", tint = c.fg3, modifier = Modifier.size(16.dp))
                        }
                    }
                    Text(label, style = ConclaveType.meta, color = c.fg3)
                    // one Stop held: Send runs it
                    if (onSend != null) Text("Send", style = ConclaveType.meta, color = c.fg2, modifier = Modifier.clickable(onClickLabel = "Send", onClick = onSend).padding(horizontal = 10.dp, vertical = 4.dp))
                }
            }
        }
    }
}

/**
 * An assistant turn in a session (MOBILE-V2 5): plain text, full width, no
 * name or model line, 16sp. The thoughts and calls between two pieces of
 * text are one row (TurnWork, CHAT-AND-MOTION 6.3): "Thought for 24s, read
 * 4 files, ran 1 command", or what it does now while the turn works on it.
 * A Workflow or Task call is a compact row of its own; a lone thought folds
 * as "Thought for 3s". Under each turn once it is done, the icon row: Copy,
 * Retry and More. A long press on its text selects it (SelectionContainer);
 * it opens nothing. [work]: the session and its runs, for the workflow and
 * subagent rows.
 */
@Composable
fun TurnView(
    messages: List<Message>,
    live: Transcript,
    running: Boolean,
    cwd: String?,
    work: SessionWork = SessionWork(),
    /** The icon row under it: given for each turn once it is done. */
    foot: (@Composable () -> Unit)? = null,
) {
    val c = Conclave.colors
    // the turn's last message is still being written: a thought that ends it streams
    val streaming = running && messages.lastOrNull()?.stopReason == null
    val pieces = remember(messages, streaming) { Work.pieces(messages, streaming) }
    val lastText = Work.lastText(pieces)
    CompositionLocalProvider(LocalSessionWork provides work) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            pieces.forEachIndexed { i, p ->
                key(p.key) {
                    when (p) {
                        is TurnPiece.Block -> Column(Modifier.fillMaxWidth()) {
                            when (val block = p.block) {
                                // a long press selects: paragraphs, lists, tables and code blocks alike
                                is TextBlock -> SelectionContainer { ChatProse(block.text, streaming = streaming && p.last) }
                                is ImageBlock -> InlineImage(block)
                                is DocumentBlock -> DocumentChip(block)
                                else -> Unit
                            }
                        }
                        // what the turn works on now is the stretch after its last text
                        is TurnPiece.Work -> TurnWork(p.entries, live.toolResults, live = running && i > lastText, turnLive = running, cwd = cwd) { t ->
                            if (t.redacted) {
                                Text("The provider hid this reasoning.", style = ConclaveType.meta, color = c.fg3)
                            } else {
                                ThinkingView(t.text, active = t.streaming, durationMs = t.durationMs)
                            }
                        }
                    }
                }
            }
            foot?.invoke()
        }
    }
}

@Composable
fun Blocks(content: List<ContentBlock>, live: Transcript, streaming: Boolean) {
    content.forEachIndexed { index, block ->
        val isLast = index == content.lastIndex
        when (block) {
            is TextBlock -> if (block.text.isNotBlank()) MarkdownText(block.text)
            is ThinkingBlock -> if (block.thinking.isNotBlank()) ThinkingView(block.thinking, active = streaming && isLast, durationMs = block.durationMs)
            is RedactedThinkingBlock -> Text("The provider hid this reasoning.", style = ConclaveType.meta, color = Conclave.colors.fg3)
            is ToolUseBlock -> ToolCard(
                use = block,
                result = live.toolResults[block.id],
                running = block.id in live.runningTools || (streaming && isLast && live.toolResults[block.id] == null),
                progress = live.toolProgress[block.id],
            )
            is ImageBlock -> InlineImage(block)
            is DocumentBlock -> DocumentChip(block)
            is ToolResultBlock, is UnknownBlock -> Unit
        }
    }
}

/**
 * The reasoning as a Fold (CHAT-AND-MOTION 1.9): a closed row that reads
 * "Reasoning" while it streams (the live line under the turn says
 * "Thinking" with the Knot), then "Thought for 3s". A tap opens it: the rule
 * draws down and the reasoning comes in; while it streams the new words
 * arrive with Ink.
 */
@Composable
fun ThinkingView(text: String, active: Boolean, durationMs: Long? = null) {
    val c = Conclave.colors
    // the time we watched it stream, taken in the composition it ends, so the row goes from
    // "Reasoning" straight to "Thought for 3s"
    val watched = remember { longArrayOf(0L, 0L) }
    val now = System.currentTimeMillis()
    if (active && watched[0] == 0L) watched[0] = now
    if (!active && watched[0] != 0L && watched[1] == 0L) watched[1] = now
    val took = durationMs ?: if (watched[0] != 0L && watched[1] != 0L) watched[1] - watched[0] else null
    val words = text.trim().split(Regex("\\s+")).count { it.isNotEmpty() }
    val label = when {
        active -> "Reasoning"
        took != null -> ChatLive.thoughtFor(took)
        else -> "Reasoning, $words ${if (words == 1) "word" else "words"}"
    }
    Fold(live = false, label = label) {
        ChatProse(text.trim(), streaming = active, color = c.fg2, style = ConclaveType.meta.copy(lineHeight = ConclaveType.meta.fontSize * 1.6f))
    }
}

/** Second opinion or other side comment: indented under a neutral hairline rule (spec 10.21). A long press selects its text. */
@Composable
fun AsideMessage(message: Message, live: Transcript) {
    val c = Conclave.colors
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .padding(start = 28.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
    ) {
        Box(Modifier.width(1.dp).fillMaxHeight().background(c.rule2))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(message.author ?: "Aside", style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium), color = c.fg2)
                if (!message.model.isNullOrBlank()) {
                    Spacer(Modifier.width(8.dp))
                    ModelName(message.model, Modifier.weight(1f, fill = false), size = 13.dp, style = ConclaveType.meta, color = c.fg3)
                }
            }
            SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { Blocks(message.content, live, streaming = false) } }
        }
    }
}

/** Jury: a pager of juror answers, then the verdict. A long press selects text. */
@Composable
fun JuryView(answers: List<Message>, verdict: Message?, live: Transcript) {
    val pager = rememberPagerState { answers.size }
    val scope = rememberCoroutineScope()
    val c = Conclave.colors
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Column(Modifier.padding(vertical = 12.dp)) {
            Row(Modifier.padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Jury", style = ConclaveType.section, color = c.fg)
                Spacer(Modifier.width(8.dp))
                Text(if (answers.size == 1) "1 answer" else "${answers.size} answers", style = ConclaveType.metaNum, color = c.fg3)
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                // Jurors are told apart by their model mark, never by a color.
                answers.forEachIndexed { i, m ->
                    FilterChip(
                        selected = pager.currentPage == i,
                        onClick = { scope.launch { pager.animateScrollToPage(i) } },
                        label = { Text(m.author ?: ModelRefs.displayName(m.model).ifBlank { "Juror ${i + 1}" }) },
                        leadingIcon = if (m.model.isNullOrBlank()) {
                            null
                        } else {
                            { ModelMark(m.model, size = 14.dp) }
                        },
                    )
                }
            }
            HorizontalPager(state = pager, modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) { page ->
                val m = answers[page]
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    ModelName(m.model, size = 13.dp, style = ConclaveType.meta, color = c.fg2)
                    SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { Blocks(m.content, live, streaming = false) } }
                }
            }
            if (verdict != null) {
                Spacer(Modifier.height(12.dp))
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    HorizontalDivider(thickness = 2.dp, color = c.fg)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Verdict", style = ConclaveType.meta, color = c.fg3)
                        if (!verdict.model.isNullOrBlank()) {
                            Spacer(Modifier.width(8.dp))
                            ModelName(verdict.model, Modifier.weight(1f, fill = false), size = 13.dp, style = ConclaveType.meta, color = c.fg3)
                        }
                    }
                    SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { Blocks(verdict.content, live, streaming = false) } }
                }
            }
        }
    }
}

/**
 * UI-only event line. A limit notice gets a countdown and actions while the
 * session waits. A refusal notice that offers the next model of Refusal
 * fallback gets "Try the next model" ([onTryNext], NextModel); "Trying"
 * while the hub takes it ([tryingNext]).
 */
@Composable
fun NoticeLine(
    message: Message,
    session: Session?,
    isLatestNotice: Boolean,
    onResume: () -> Unit,
    onSwitchModel: () -> Unit,
    onTryNext: (() -> Unit)? = null,
    tryingNext: Boolean = false,
    /** A background task that reported back: its compact row instead of the line. */
    result: AgentResult? = null,
) {
    if (result != null) {
        AgentResultLine(result, Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
        return
    }
    val text = message.content.plainText().ifBlank { message.author ?: "Notice" }
    val waiting = session?.status == SessionStatus.WAITING_RESET && isLatestNotice
    val resumeAt = session?.resumeAt
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Info, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(6.dp))
            Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        if (waiting) {
            val now by rememberNow()
            val left = (resumeAt ?: now) - now
            Spacer(Modifier.height(6.dp))
            Text(
                if (left > 0) "Resumes automatically in ${Format.countdown(left)}" else "Resuming",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.tertiary,
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = onResume) { Text("Resume now") }
                OutlinedButton(onClick = onSwitchModel) { Text("Switch model") }
            }
        }
        if (onTryNext != null) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onTryNext, enabled = !tryingNext) { Text(if (tryingNext) NextModel.BUSY else NextModel.LABEL) }
        }
    }
}

/**
 * A background task that reported back (AgentResults): "Message from
 * subagent count widgets", its state (failed in the fault color) and a
 * chevron, one quiet line. A tap opens the report under it, markdown at up
 * to 320dp that scrolls.
 */
@Composable
fun AgentResultLine(result: AgentResult, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    var open by rememberSaveable(result.id, result.label) { mutableStateOf(false) }
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 40.dp).clickable(onClickLabel = if (open) "Hide the report" else "Show the report") { open = !open },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(result.title, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            Text(result.stateWord, style = ConclaveType.meta, color = if (result.failed) c.fault else if (result.state == "stopped") c.warn else c.fg3)
            Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null, tint = c.fg4, modifier = Modifier.size(16.dp))
        }
        if (open) {
            // the Markdown composable uses a LazyColumn, which crashes under IntrinsicSize.Min; paint the rule
            // with drawBehind so the Row can size naturally to the scroll Box
            val stripe = c.rule2
            Row(
                Modifier.fillMaxWidth().padding(bottom = 6.dp)
                    .drawBehind { drawRect(stripe, Offset.Zero, Size(1.dp.toPx(), size.height)) }
                    .padding(start = 13.dp),
            ) {
                val report = result.report
                if (report.isNullOrBlank()) {
                    Text("The report is not in this view.", style = ConclaveType.meta, color = c.fg3)
                } else {
                    Box(Modifier.weight(1f).heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
                        SelectionContainer { MarkdownText(report) }
                    }
                }
            }
        }
    }
}

@Composable
fun SummaryLine(message: Message) {
    var open by rememberSaveable { mutableStateOf(false) }
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Column(Modifier.clickable { open = !open }.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Outlined.Notes, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text("Earlier messages were summarized", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null)
            }
            if (open) {
                Spacer(Modifier.height(8.dp))
                MarkdownText(message.content.plainText())
            }
        }
    }
}

@Composable
fun InlineImage(block: ImageBlock) {
    val data = block.data
    val bitmap by produceState<ImageBitmap?>(null, data) {
        value = if (data.isNullOrBlank()) {
            null
        } else {
            withContext(Dispatchers.Default) {
                runCatching {
                    val bytes = Base64.getDecoder().decode(data)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                }.getOrNull()
            }
        }
    }
    val img = bitmap
    if (img != null) {
        Image(
            bitmap = img,
            contentDescription = "Image",
            contentScale = ContentScale.Fit,
            modifier = Modifier.widthIn(max = 280.dp).heightIn(max = 280.dp).clip(RoundedCornerShape(12.dp)),
        )
    } else {
        DocumentChip(DocumentBlock(mediaType = block.mediaType, url = block.url, title = "Image"))
    }
}

@Composable
fun DocumentChip(block: DocumentBlock) {
    Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Description, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(block.title ?: block.mediaType, style = MaterialTheme.typography.labelMedium)
        }
    }
}
