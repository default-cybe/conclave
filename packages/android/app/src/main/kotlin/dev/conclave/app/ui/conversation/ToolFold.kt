@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.chat.DiffView
import dev.conclave.app.ui.common.CodeBox
import dev.conclave.app.ui.motion.Motion
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.workflows.LocalOpenWorkflowRun
import dev.conclave.client.logic.ChatSources
import dev.conclave.client.logic.ChatTools
import dev.conclave.client.logic.Diffs
import dev.conclave.client.logic.ToolLines
import dev.conclave.client.logic.ToolStep
import dev.conclave.client.logic.Work
import dev.conclave.client.logic.WorkEntry
import dev.conclave.client.logic.WorkSegment
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.string
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

private val PrettyJson = Json { prettyPrint = true }

/**
 * A stretch of a turn's work: the thoughts and calls between two pieces of
 * text (Work.kt, CHAT-AND-MOTION 6.3), as the Claude app shows them. Two or
 * more are ONE quiet row, "Thought for 24s, read 4 files, ran 1 command",
 * that says what it is doing now while the turn works on it ("Running
 * flutter analyze", "Thinking"). A tap opens the steps in order, a thought
 * as "Thought for 5s" and a call as "Read vault_entry.dart"; a tap on a step
 * opens what it did in a sheet: the thought, the command and its output,
 * the diff. A single call is its own row and opens its sheet; a lone
 * thought is drawn by [thought], as it was. A Workflow or Task call is a
 * compact row of its own (Tasks.kt) that splits the stretch around it; the
 * Task calls of one message are one fan-out card (FanOutCard).
 * Places and routes sit under the stretch, open or not.
 *
 * [live]: the turn works on this stretch now (no text after it yet).
 * [turnLive]: the turn still runs, so a call with no result runs.
 * [measured]: thought times the phone saw, by message, until the hub has them.
 */
@Composable
fun TurnWork(
    entries: List<WorkEntry>,
    results: Map<String, ToolResultBlock>,
    live: Boolean,
    turnLive: Boolean,
    cwd: String?,
    modifier: Modifier = Modifier,
    measured: Map<String, Long> = emptyMap(),
    /** Undo on a note saved to memory: the id, then what to do once it is gone. */
    onForget: ((String, () -> Unit) -> Unit)? = null,
    onOpenMemory: (() -> Unit)? = null,
    thought: @Composable (WorkEntry.Thought) -> Unit,
) {
    val segments = remember(entries) { Work.segment(entries) }
    val calls = remember(entries) { Work.calls(entries) }
    Column(modifier.fillMaxWidth()) {
        segments.forEachIndexed { i, seg ->
            key(seg.key) {
                when (seg) {
                    is WorkSegment.One -> {
                        val use = seg.call.use
                        val result = results[use.id]
                        val callLive = turnLive && result == null
                        when {
                            Work.isWorkflow(use) -> WorkflowRow(use, result, callLive)
                            Work.isTask(use) -> SubagentRow(use, result, callLive)
                            else -> CallRow(use, result, callLive, cwd, onForget, onOpenMemory)
                        }
                    }
                    is WorkSegment.FanOut -> FanOutCard(seg.calls.map { it.use }, results, turnLive)
                    is WorkSegment.Lone -> thought(seg.thought)
                    is WorkSegment.Group -> WorkGroup(seg.entries, results, live && i == segments.lastIndex, turnLive, cwd, measured, onForget, onOpenMemory)
                }
            }
        }
        // places and routes sit under the stretch, open or not (MapsCards.kt)
        MapsCardsView(calls, results)
        // files a ShareFile call handed the owner, the same way (FileCards.kt)
        FileCardsView(calls, results)
    }
}

/**
 * Two or more thoughts and calls as one row: what they did, or what they
 * do now while the turn works on them, then "1 failed" when one did, and a
 * chevron. Closed until you open it; open, the steps in order.
 */
@Composable
private fun WorkGroup(
    entries: List<WorkEntry>,
    results: Map<String, ToolResultBlock>,
    live: Boolean,
    turnLive: Boolean,
    cwd: String?,
    measured: Map<String, Long>,
    onForget: ((String, () -> Unit) -> Unit)?,
    onOpenMemory: (() -> Unit)?,
) {
    val c = Conclave.colors
    val calls = remember(entries) { Work.calls(entries) }
    val steps = remember(calls, results, cwd, turnLive) { ToolLines.steps(calls, results, cwd, turnLive).associateBy { it.id } }
    val summary = remember(entries, measured) { ToolLines.workSummary(Work.steps(entries, measured)) }
    val now = Work.now(entries, results, live)
    var open by rememberSaveable(entries.first().key) { mutableStateOf(false) }
    var detail by remember { mutableStateOf<WorkEntry?>(null) }
    val failed = steps.values.count { it.failed }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 40.dp)
                .clip(RoundedCornerShape(5.dp))
                .clickable(onClickLabel = if (open) "Fold the steps" else "Show the steps") { open = !open }
                .semantics { stateDescription = if (open) "Open" else "Folded" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                now ?: summary,
                style = ConclaveType.body.copy(fontSize = 14.sp),
                color = if (now != null) c.signal else c.fg3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (failed > 0 && now == null) {
                Spacer(Modifier.width(8.dp))
                Text("$failed failed", style = ConclaveType.meta, color = c.fault, maxLines = 1)
            }
            Spacer(Modifier.width(4.dp))
            Chevron(open)
        }
        AnimatedVisibility(open, enter = fadeIn(tween(if (reducedMotion()) 0 else Motion.DUR_2)), exit = ExitTransition.None) {
            Column(Modifier.padding(start = 2.dp, bottom = 4.dp)) {
                entries.forEach { e ->
                    key(e.key) {
                        when (e) {
                            is WorkEntry.Call -> steps[e.use.id]?.let { s -> StepRow(s, onClick = { detail = e }) }
                            is WorkEntry.Thought -> ThoughtStep(e, measured[e.message.id], onClick = { detail = e })
                        }
                    }
                }
            }
        }
    }
    when (val d = detail) {
        is WorkEntry.Call -> {
            val step = steps[d.use.id]
            if (step != null) ToolSheet(d.use, step, results[d.use.id], onDismiss = { detail = null }, onForget = onForget, onOpenMemory = onOpenMemory)
        }
        // the thought as it streams, or as it was
        is WorkEntry.Thought -> {
            val current = entries.firstOrNull { it.key == d.key } as? WorkEntry.Thought ?: d
            ThoughtSheet(current, measured[current.message.id], onDismiss = { detail = null })
        }
        null -> Unit
    }
}

/** A single call on its own row: the verb, the file or the command, "+2 −0" for an edit. A tap opens what it did. */
@Composable
private fun CallRow(
    use: ToolUseBlock,
    result: ToolResultBlock?,
    running: Boolean,
    cwd: String?,
    onForget: ((String, () -> Unit) -> Unit)?,
    onOpenMemory: (() -> Unit)?,
) {
    val step = remember(use, result, cwd, running) { ToolLines.step(use, result, cwd, running) }
    var detail by remember { mutableStateOf(false) }
    StepRow(step, onClick = { detail = true })
    if (detail) ToolSheet(use, step, result, onDismiss = { detail = false }, onForget = onForget, onOpenMemory = onOpenMemory)
}

/** A thought among the steps: "Thought for 5s", "Thinking" while it is written. A tap opens it. */
@Composable
private fun ThoughtStep(t: WorkEntry.Thought, measured: Long?, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).clip(RoundedCornerShape(5.dp)).clickable(enabled = !t.redacted, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            Work.thoughtLabel(t, measured),
            style = ConclaveType.body.copy(fontSize = 14.sp),
            color = if (t.streaming) c.signal else c.fg2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A thought in full, as it streams or as it was. */
@Composable
private fun ThoughtSheet(t: WorkEntry.Thought, measured: Long?, onDismiss: () -> Unit) {
    val c = Conclave.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(Work.thoughtLabel(t, measured), style = ConclaveType.title, color = if (t.streaming) c.signal else c.fg)
            if (t.text.isNotEmpty()) {
                ChatProse(t.text, streaming = t.streaming, color = c.fg2, style = ConclaveType.meta.copy(lineHeight = ConclaveType.meta.fontSize * 1.6f))
            }
        }
    }
}

/** A chevron that turns a quarter when open. */
@Composable
private fun Chevron(open: Boolean) {
    val turn by animateFloatAsState(if (open) 90f else 0f, tween(if (reducedMotion()) 0 else Motion.DUR_1), label = "tool-chevron")
    Icon(
        Icons.AutoMirrored.Outlined.KeyboardArrowRight,
        contentDescription = null,
        modifier = Modifier.size(16.dp).graphicsLayer { rotationZ = turn },
        tint = Conclave.colors.fg4,
    )
}

/** One step: the verb, what it worked on (mono for a file or a command) and "+2 −0" for an edit. */
@Composable
private fun StepRow(s: ToolStep, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).clip(RoundedCornerShape(5.dp)).clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            s.verb,
            style = ConclaveType.body.copy(fontSize = 14.sp),
            color = when {
                s.failed -> c.fault
                s.running -> c.signal
                else -> c.fg2
            },
            maxLines = 1,
        )
        val target = s.target
        if (target != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                target,
                style = if (s.code) CodeStyle.copy(fontSize = 13.sp) else ConclaveType.body.copy(fontSize = 14.sp),
                color = c.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        val added = s.added
        val removed = s.removed
        if (added != null || removed != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = c.ok)) { append("+${added ?: 0}") }
                    append(" ")
                    withStyle(SpanStyle(color = c.fault)) { append("−${removed ?: 0}") }
                },
                style = ConclaveType.metaNum,
                maxLines = 1,
            )
        }
        if (s.failed) {
            Spacer(Modifier.width(8.dp))
            Text("failed", style = ConclaveType.meta, color = c.fault, maxLines = 1)
        }
    }
}

/** What a step did: the diff of an edit, a command's output, a search's results, a saved note. */
@Composable
private fun ToolSheet(
    use: ToolUseBlock,
    step: ToolStep,
    result: ToolResultBlock?,
    onDismiss: () -> Unit,
    onForget: ((String, () -> Unit) -> Unit)?,
    onOpenMemory: (() -> Unit)?,
) {
    val c = Conclave.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(step.verb, style = ConclaveType.title, color = c.fg)
                step.target?.let { t ->
                    Spacer(Modifier.width(8.dp))
                    Text(t, style = if (step.code) CodeStyle.copy(fontSize = 14.sp) else ConclaveType.title, color = c.fg2, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (step.running) Text("Running now.", style = ConclaveType.meta, color = c.signal)
            when {
                Diffs.isEditTool(use.name) -> {
                    val diff = remember(use, result) { Diffs.forTool(use, result) }
                    if (diff != null) DiffView(diff) else Text("No changes to show.", style = ConclaveType.meta, color = c.fg3)
                    if (result?.isError == true) CodeBox(result.text, maxLines = 40)
                }
                use.name == "Bash" -> {
                    CodeBox(use.input.string("command").orEmpty(), maxLines = 12)
                    if (result != null) Output(result)
                }
                use.name == "WebSearch" -> {
                    val list = result?.meta?.results.orEmpty()
                    if (list.isEmpty()) {
                        Text(if (result == null) "No results yet." else "Nothing found.", style = ConclaveType.meta, color = c.fg3)
                    } else {
                        list.forEach { r ->
                            Column {
                                Text(r.title.ifBlank { ChatSources.host(r.url) }, style = ConclaveType.body, color = c.fg)
                                Text(ChatSources.host(r.url), style = ConclaveType.meta, color = c.fg3)
                            }
                        }
                    }
                }
                use.name == "MemorySearch" -> {
                    val notes = ChatTools.notes(result)
                    if (notes.isEmpty()) Text("No notes found.", style = ConclaveType.meta, color = c.fg3)
                    notes.forEach { n -> Text(n.text, style = ConclaveType.body, color = c.fg2) }
                }
                use.name == "MemorySave" -> {
                    var undone by rememberSaveable(use.id) { mutableStateOf(false) }
                    val id = result?.meta?.memoryId
                    Text(
                        use.input.string("content").orEmpty(),
                        style = ConclaveType.chat,
                        color = if (undone) c.fg3 else c.fg,
                        textDecoration = if (undone) TextDecoration.LineThrough else null,
                    )
                    Row {
                        if (id != null && !undone && onForget != null) TextButton(onClick = { onForget(id) { undone = true } }) { Text("Undo") }
                        if (onOpenMemory != null) {
                            TextButton(onClick = {
                                onDismiss()
                                onOpenMemory()
                            }) { Text("Open memory") }
                        }
                    }
                }
                else -> {
                    if (use.input.isNotEmpty()) CodeBox(PrettyJson.encodeToString(JsonObject.serializer(), use.input), maxLines = 30)
                    if (result != null) Output(result)
                }
            }
            // a Workflow call opens its run: phases, agents and the result
            val openRun = LocalOpenWorkflowRun.current
            val runId = result?.meta?.workflowRunId
            if (use.name == "Workflow" && runId != null && openRun != null) {
                TextButton(onClick = {
                    onDismiss()
                    openRun(runId)
                }) { Text("Open run") }
            }
        }
    }
}

/** A result's text, the first 60 lines until asked for all. */
@Composable
private fun Output(result: ToolResultBlock) {
    var all by remember(result) { mutableStateOf(false) }
    val text = remember(result) { result.text }
    val lines = remember(text) { text.lines() }
    if (text.isBlank()) return
    CodeBox(if (all || lines.size <= 60) text else lines.take(60).joinToString("\n"))
    if (!all && lines.size > 60) TextButton(onClick = { all = true }) { Text("Show all ${lines.size} lines") }
}
