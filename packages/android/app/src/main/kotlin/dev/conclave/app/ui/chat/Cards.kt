@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.chat

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Timelapse
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.common.CodeBox
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.Motion
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.LocalExtraColors
import dev.conclave.client.logic.Asks
import dev.conclave.client.logic.Inbox
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.ApprovalResponse
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.Todo
import dev.conclave.client.model.TodoStatus
import dev.conclave.client.motion.Gap
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

private val PrettyJson = Json { prettyPrint = true }

/** The box an approval or a question sits in at the end of the transcript: a hairline, 20dp corners. */
private val PromptShape = RoundedCornerShape(20.dp)

/**
 * An approval at the end of the transcript, like a permission prompt
 * (MOBILE-V2 5): the question ("Run this command?", "Edit redirect.ts?"),
 * the command or file in a mono block, the agent's reason under it in
 * curly quotes, then full width buttons: Allow once, Allow for this chat,
 * Deny. Always allow and the call's details are in the more menu. A
 * decision confirms in place before the prompt goes.
 *
 * A subagent's or a workflow agent's request shows in the chat the owner is
 * in (Asks.kt): a quiet line above the box says who asks ("Subagent email
 * asks"), and the session answer reads "Allow for this subagent", as it
 * applies to the session that asked.
 */
@Composable
fun ApprovalPrompt(
    approval: ApprovalRequest,
    onDecide: (ApprovalResponse) -> Unit,
    modifier: Modifier = Modifier,
    /** The session's folder, so a file reads relative to it. */
    cwd: String? = null,
    /** Called with the approval's id the moment a decision is tapped, so the list holds it while it confirms. */
    onConfirm: (String) -> Unit = {},
    /** The conversation the prompt shows in: a subagent's request there says who asks, above it. */
    viewing: String? = null,
) {
    val c = Conclave.colors
    val reduced = reducedMotion()
    var menu by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    var decided by remember(approval.id) { mutableStateOf<Decision?>(null) }
    // still here well after the decision (the hub refused it): ready to decide again
    LaunchedEffect(decided) {
        if (decided != null) {
            delay(4_000)
            decided = null
        }
    }
    val edge by animateColorAsState(
        when (decided) {
            null -> c.rule2
            Decision.DENY -> c.fg3
            else -> c.ok
        },
        tween(if (reduced) 0 else Gap.CONFIRM_MS, easing = Motion.Ease),
        label = "approval-edge",
    )
    fun decide(d: Decision, r: ApprovalResponse) {
        if (decided != null) return
        decided = d
        onConfirm(approval.id)
        onDecide(r)
    }
    val title = remember(approval.tool, approval.summary, approval.input) { Inbox.approvalTitle(approval.tool, approval.summary, approval.input) }
    val subject = remember(approval.tool, approval.summary, approval.input, cwd) { Inbox.approvalSubject(approval.tool, approval.summary, approval.input, cwd) }
    val (_, line) = remember(approval.tool, approval.summary, approval.input) { Inbox.approvalLines(approval.tool, approval.summary, approval.input) }
    val reason = remember(approval.input, line) { Inbox.approvalReason(approval.input, line) }
    // a push or a pull request is said in words, and asks each time (docs/DESIGN.md 30)
    val mono = Inbox.approvalMono(approval.tool)
    val wider = Inbox.approvalWider(approval.tool, approval.noAlways)
    val from = viewing?.let { Asks.fromLine(approval, it) }
    Column(modifier.fillMaxWidth()) {
        if (from != null) AskFromLine(from)
        Column(
            Modifier.fillMaxWidth().clip(PromptShape).background(c.bgRaise).border(1.dp, edge, PromptShape).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = ConclaveType.title, color = c.fg, modifier = Modifier.weight(1f))
                Box {
                    IconButton(onClick = { menu = true }, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Outlined.MoreHoriz, contentDescription = "More choices", tint = c.fg3, modifier = Modifier.size(20.dp))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (wider) {
                            DropdownMenuItem(text = { Text("Always allow") }, enabled = decided == null, onClick = {
                                menu = false
                                decide(Decision.ALWAYS, ApprovalResponse.allowAlways(approval.suggestedRule))
                            })
                        }
                        DropdownMenuItem(text = { Text(if (details) "Hide details" else "Details") }, onClick = {
                            menu = false
                            details = !details
                        })
                    }
                }
            }
            if (mono) {
                // the command or the file, in mono, scrolling sideways when long
                Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.bgSunk).horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp)) {
                    Text(subject, style = CodeStyle.copy(fontSize = 14.sp, lineHeight = 20.sp), color = c.fg, softWrap = false)
                }
            } else {
                Text(subject, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg)
            }
            // the agent's own words for it, quoted
            if (reason != null) Text(reason, style = ConclaveType.body, color = c.fg2)
            if (details) {
                CodeBox(PrettyJson.encodeToString(JsonObject.serializer(), approval.input), maxLines = 30)
                approval.suggestedRule?.let { Text("Always allow adds the rule $it", style = ConclaveType.meta, color = c.fg3) }
            }
            val open = decided == null
            Column(Modifier.fillMaxWidth().padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { decide(Decision.ONCE, ApprovalResponse.allowOnce()) },
                    enabled = open || decided == Decision.ONCE,
                    colors = solidButtonColors(),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) { Confirmed(decided == Decision.ONCE || decided == Decision.ALWAYS, "Allow once", if (decided == Decision.ALWAYS) "Always allowed" else "Allowed") }
                if (wider) {
                    OutlinedButton(
                        onClick = { decide(Decision.SESSION, ApprovalResponse.allowSession()) },
                        enabled = open || decided == Decision.SESSION,
                        colors = outlineButtonColors(),
                        border = outlineButtonBorder(),
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                    ) { Confirmed(decided == Decision.SESSION, Asks.sessionLabel(approval), Asks.sessionDone(approval)) }
                }
                OutlinedButton(
                    onClick = { decide(Decision.DENY, ApprovalResponse.deny()) },
                    enabled = open || decided == Decision.DENY,
                    colors = outlineButtonColors(),
                    border = outlineButtonBorder(),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) { Confirmed(decided == Decision.DENY, "Deny", "Denied") }
            }
        }
    }
}

/** Who asks, quiet, above a subagent's prompt: "Subagent email asks". */
@Composable
private fun AskFromLine(text: String) {
    Text(text, style = ConclaveType.meta, color = Conclave.colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
}

private enum class Decision { ONCE, SESSION, ALWAYS, DENY }

/** A decision's label that swaps to its confirmed words with a check (Swap, 120ms). */
@Composable
private fun Confirmed(on: Boolean, label: String, done: String, color: Color = Color.Unspecified) {
    Swap(on = on, off = { Text(label, color = color) }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(done)
        }
    }
}

/**
 * A question at the end of the transcript (MOBILE-V2 5): the question,
 * its options as full width outlined rows (one, or several when it asks
 * for several), an "Other answer" field, and Send. A subagent's question
 * says who asks above it, as an approval does.
 */
@Composable
fun QuestionPrompt(
    request: QuestionRequest,
    onAnswer: (Map<String, String>) -> Unit,
    modifier: Modifier = Modifier,
    /** The conversation the prompt shows in: a subagent's question there says who asks, above it. */
    viewing: String? = null,
) {
    val selected = remember(request.id) { mutableStateMapOf<Int, Set<String>>() }
    val other = remember(request.id) { mutableStateMapOf<Int, String>() }
    val c = Conclave.colors
    val from = viewing?.let { Asks.fromLine(request, it) }
    Column(modifier.fillMaxWidth()) {
        if (from != null) AskFromLine(from)
        Column(
            Modifier.fillMaxWidth().clip(PromptShape).background(c.bgRaise).border(1.dp, c.rule2, PromptShape).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            request.questions.forEachIndexed { qi, q ->
                q.header?.let { Text(it, style = ConclaveType.meta, color = c.fg3) }
                Text(q.question, style = ConclaveType.chat, color = c.fg)
                q.options.forEach { opt ->
                    val current = selected[qi] ?: emptySet()
                    val on = opt.label in current
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (on) c.surface2 else Color.Transparent)
                            .border(1.dp, if (on) c.fg3 else c.rule2, RoundedCornerShape(12.dp))
                            .selectable(selected = on, role = if (q.multiSelect) Role.Checkbox else Role.RadioButton, onClick = {
                                selected[qi] = if (q.multiSelect) {
                                    if (on) current - opt.label else current + opt.label
                                } else {
                                    setOf(opt.label)
                                }
                            })
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(opt.label, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg)
                            opt.description?.let { Text(it, style = ConclaveType.meta, color = c.fg3) }
                        }
                        if (on) Icon(Icons.Outlined.Check, contentDescription = null, tint = c.fg, modifier = Modifier.size(18.dp))
                    }
                }
                OutlinedTextField(
                    value = other[qi] ?: "",
                    onValueChange = { other[qi] = it },
                    placeholder = { Text("Other answer") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            val ready = request.questions.indices.all { (selected[it]?.isNotEmpty() == true) || !other[it].isNullOrBlank() }
            Button(
                enabled = ready,
                colors = solidButtonColors(),
                modifier = Modifier.fillMaxWidth().height(48.dp),
                onClick = {
                    val answers = request.questions.mapIndexed { i, q ->
                        val text = other[i]?.trim().takeUnless { it.isNullOrEmpty() }
                            ?: (selected[i] ?: emptySet()).joinToString(", ")
                        q.question to text
                    }.toMap()
                    onAnswer(answers)
                },
            ) { Text("Send") }
        }
    }
}

@Composable
fun TodoSheet(todos: List<Todo>, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Text("Todo list", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            LazyColumn {
                items(todos) { t ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        val (icon, tint) = when (t.status) {
                            TodoStatus.COMPLETED -> Icons.Outlined.CheckCircle to LocalExtraColors.current.success
                            TodoStatus.IN_PROGRESS -> Icons.Outlined.Timelapse to MaterialTheme.colorScheme.primary
                            TodoStatus.PENDING -> Icons.Outlined.RadioButtonUnchecked to MaterialTheme.colorScheme.outline
                        }
                        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(12.dp))
                        Text(
                            if (t.status == TodoStatus.IN_PROGRESS) t.activeForm ?: t.content else t.content,
                            style = MaterialTheme.typography.bodyLarge,
                            textDecoration = if (t.status == TodoStatus.COMPLETED) TextDecoration.LineThrough else null,
                            color = if (t.status == TodoStatus.COMPLETED) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
            Spacer(Modifier.size(24.dp))
        }
    }
}
