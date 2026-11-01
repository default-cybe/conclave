@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.friends

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.conversation.ChoiceRow
import dev.conclave.app.ui.motion.KnotRope
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.logic.RangeStop
import dev.conclave.client.logic.ReviewChoices
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.model.RedactionItem
import dev.conclave.client.model.SentShareDto
import dev.conclave.client.model.SharePreview
import dev.conclave.client.previewShare
import dev.conclave.client.sendShare
import dev.conclave.client.updateShare
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class Step { PICK, REVIEW, SENT }

/**
 * Send to friend (docs/design/FRIENDS.md, phase 2; the web's SendDialog.tsx):
 * pick friends, review what goes (the hub answers every change, so the
 * counts are what would go), send, then the sent state with the rope
 * pulling out through the knot. With [update], a share sent before: no
 * pick, the review starts from its choices, and Send is a new revision.
 */
@Composable
fun SendToFriendSheet(
    sessionId: String,
    title: String,
    chat: Boolean,
    onDismiss: () -> Unit,
    update: SentShareDto? = null,
    onOpenFriend: ((String) -> Unit)? = null,
) {
    val hub = LocalAppContainer.current.hub
    val c = Conclave.colors
    val friends by hub.friends.collectAsStateWithLifecycle()
    val targets = remember(friends) { FriendWords.shareTargets(friends) }
    val kind = if (chat) "chat" else "session"
    val scope = rememberCoroutineScope()
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var step by remember { mutableStateOf(if (update != null) Step.REVIEW else Step.PICK) }
    var picked by remember { mutableStateOf(update?.recipients?.map { it.friendId } ?: if (targets.size == 1) listOf(targets[0].id) else emptyList()) }
    var shareTitle by remember { mutableStateOf(update?.title ?: "") }
    var note by remember { mutableStateOf(update?.note ?: "") }
    var choices by remember { mutableStateOf(ShareWords.reviewStart(kind, update?.options)) }
    var preview by remember { mutableStateOf<SharePreview?>(null) }
    var checking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf<SentShareDto?>(null) }
    var stops by remember { mutableStateOf<List<RangeStop>>(emptyList()) }
    // the title is filled from the first review only, so a title cleared on purpose stays cleared
    var titled by remember { mutableStateOf(update != null) }
    var ask by remember { mutableIntStateOf(0) }

    // where the share can stop: after each turn but the last
    LaunchedEffect(sessionId) {
        try {
            stops = ShareWords.rangeStops(hub.api { it.messages(sessionId) })
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }
    // the review: the hub answers each change, the latest answer wins
    LaunchedEffect(step, choices) {
        if (step != Step.REVIEW) return@LaunchedEffect
        val n = ++ask
        checking = true
        if (preview != null) delay(250)
        try {
            val p = hub.api { it.previewShare(ShareWords.previewInput(sessionId, choices)) }
            if (n == ask) {
                preview = p
                error = null
                // the title starts as the session's, as the review gives it
                if (!titled) {
                    titled = true
                    if (shareTitle.isBlank()) shareTitle = p.title
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (n == ask) error = errorText(e)
        } finally {
            if (n == ask) checking = false
        }
    }

    val names = picked.map { id -> friends.firstOrNull { it.id == id }?.name ?: "a friend" }
    val send: () -> Unit = {
        scope.launch {
            sending = true
            try {
                if (update != null) {
                    val s = hub.api { it.updateShare(update.id, ShareWords.updateInput(choices, shareTitle, note)) }
                    hub.putSentShare(s)
                    onDismiss()
                } else {
                    val s = hub.api { it.sendShare(ShareWords.sendInput(sessionId, choices, picked, shareTitle, note)) }
                    hub.putSentShare(s)
                    sent = s
                    step = Step.SENT
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = errorText(e)
            } finally {
                sending = false
            }
        }
    }

    val heading = when {
        update != null -> "Update '${update.title}'"
        step == Step.PICK -> "Send to friend"
        step == Step.REVIEW -> "Send to ${ShareWords.namesWords(names)}"
        else -> "Sent"
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding()) {
            Text(heading, style = ConclaveType.title, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
                when (step) {
                    Step.PICK -> Pick(targets.map { it.id to it }, picked, title.ifBlank { "this $kind" }, onPick = { picked = it })
                    Step.REVIEW -> Review(
                        kind = kind,
                        preview = preview,
                        choices = choices,
                        onChoices = { choices = it },
                        stops = stops,
                        title = shareTitle,
                        onTitle = { shareTitle = it },
                        note = note,
                        onNote = { note = it },
                        checking = checking && preview != null,
                        error = error,
                    )
                    Step.SENT -> sent?.let { SentState(it, names) }
                }
            }
            // the buttons, at the foot of the sheet
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                when (step) {
                    Step.PICK -> {
                        TextButton(onClick = onDismiss, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Cancel", color = c.fg2) }
                        Button(onClick = { step = Step.REVIEW }, enabled = picked.isNotEmpty(), colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Next") }
                    }
                    Step.REVIEW -> {
                        TextButton(onClick = { if (update != null) onDismiss() else step = Step.PICK }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                            Text(if (update != null) "Cancel" else "Back", color = c.fg2)
                        }
                        Button(onClick = send, enabled = preview != null && error == null && !sending, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                            Swap(on = sending, off = { Text(if (update != null) "Send revision ${update.revision + 1}" else ShareWords.sendLabel(names), maxLines = 1, overflow = TextOverflow.Ellipsis) }) { Text("Sending") }
                        }
                    }
                    Step.SENT -> {
                        if (picked.size == 1 && onOpenFriend != null) {
                            TextButton(onClick = {
                                onDismiss()
                                onOpenFriend(picked[0])
                            }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Open ${names[0]}'s page", color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        } else {
                            Spacer(Modifier.weight(1f))
                        }
                        Button(onClick = onDismiss, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Done") }
                    }
                }
            }
        }
    }
}

/** Friends to send to: active ones, a box each. */
@Composable
private fun Pick(targets: List<Pair<String, dev.conclave.client.model.FriendDto>>, picked: List<String>, what: String, onPick: (List<String>) -> Unit) {
    val c = Conclave.colors
    val now by rememberNow(60_000)
    if (targets.isEmpty()) {
        Text(
            "No friends to send to yet. A friend is someone else's Conclave hub that you both said yes to. Add one under Friends.",
            style = ConclaveType.body,
            color = c.fg2,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        return
    }
    Text("Who gets $what? You see what goes before it goes.", style = ConclaveType.body, color = c.fg2, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
    targets.forEach { (id, f) ->
        val on = id in picked
        Row(
            Modifier.fillMaxWidth().clickable { onPick(if (on) picked - id else picked + id) }.heightIn(min = 52.dp).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = on, onCheckedChange = { onPick(if (on) picked - id else picked + id) })
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(f.name, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (f.verified) VerifiedBadge(Modifier.padding(start = 8.dp))
                }
                Text(ShareWords.seenWords(f, now), style = ConclaveType.meta, color = c.fg3)
            }
        }
    }
}

/** The review before a share goes: the title and a note, what goes, and what the sanitizer took out. */
@Composable
private fun Review(
    kind: String,
    preview: SharePreview?,
    choices: ReviewChoices,
    onChoices: (ReviewChoices) -> Unit,
    stops: List<RangeStop>,
    title: String,
    onTitle: (String) -> Unit,
    note: String,
    onNote: (String) -> Unit,
    checking: Boolean,
    error: String?,
) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(
            value = title,
            onValueChange = { onTitle(it.take(200)) },
            label = { Text("Title") },
            placeholder = { Text(preview?.title ?: "Title") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = note,
            onValueChange = { onNote(it.take(2000)) },
            label = { Text("Note, optional") },
            placeholder = { Text("What you want them to look at") },
            minLines = 2,
            maxLines = 6,
            modifier = Modifier.fillMaxWidth(),
        )

        Heading("What goes")
        Label("Range")
        Segmented(
            value = if (choices.upTo == null) "whole" else "part",
            options = listOf("whole" to "Whole", "part" to "Up to a message"),
            onChange = { v -> if (v == "whole") onChoices(choices.copy(upTo = null)) else if (stops.isNotEmpty()) onChoices(choices.copy(upTo = stops.last().id)) },
            modifier = Modifier.fillMaxWidth(),
        )
        preview?.let { Help(ShareWords.rangeWords(it)) }
        if (choices.upTo != null) {
            Label("Stop after the reply to")
            Column(Modifier.bleed(20.dp)) {
                stops.forEachIndexed { i, s ->
                    ChoiceRow("${i + 1}. ${s.label}", selected = choices.upTo == s.id, onClick = { onChoices(choices.copy(upTo = s.id)) })
                }
            }
        }
        Label("Tool output")
        Segmented(
            value = choices.toolOutput,
            options = listOf("full" to "Full", "summary" to "Summary", "none" to "None"),
            onChange = { onChoices(choices.copy(toolOutput = it)) },
            modifier = Modifier.fillMaxWidth(),
        )
        when (choices.toolOutput) {
            "summary" -> Help("The first lines of each result.")
            "none" -> Help("A placeholder in place of each result.")
        }
        SwitchLine("Attachments", null, choices.attachments) { onChoices(choices.copy(attachments = it)) }
        SwitchLine("Thinking text", if (choices.thinking) "Goes without its signatures." else null, choices.thinking) { onChoices(choices.copy(thinking = it)) }
        if (kind == "session") {
            Label("Code")
            Segmented(
                value = choices.code,
                options = listOf("none" to "None", "diff" to "Diff", "git-bundle" to "Git bundle"),
                onChange = { onChoices(choices.copy(code = it)) },
                modifier = Modifier.fillMaxWidth(),
            )
            val code = preview?.code
            when {
                code?.error != null -> Text(code.error!!, style = ConclaveType.meta, color = c.fault)
                code != null -> {
                    Help((if (code.files.isNotEmpty()) "${ShareWords.codeWords(code.kind, code.files.size, code.branch)}." else "No changes to send.") + " Untracked and credential files never go.")
                    code.files.take(8).forEach { Text(it, style = CodeStyle, color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    if (code.files.size > 8) Help("and ${code.files.size - 8} more")
                    code.excluded.forEach { e -> Help("Stays home: ${e.path} (${e.reason})") }
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { Heading("Taken out" + (preview?.items?.size?.takeIf { it > 0 }?.let { " $it" } ?: "")) }
            if (checking) Text("Checking", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 12.dp))
        }
        when {
            error != null -> Text(error, style = ConclaveType.body, color = c.fault)
            preview == null -> Text("Reading the $kind", style = ConclaveType.body, color = c.fg3)
            else -> {
                Text(ShareWords.reportSentence(preview.report), style = ConclaveType.body, color = c.fg2)
                Help("System reminders, recalled memories and reasoning blobs never go. Each value below goes as shown unless you keep it.")
                preview.items.forEach { item -> FoundRow(item, onKeep = { onChoices(ShareWords.toggleKeep(choices, item.id)) }) }
            }
        }
        preview?.warnings?.forEach { Text(it, style = ConclaveType.meta, color = c.warn) }
        preview?.let { Help("${ShareWords.sizeWords(it.bytes)}. Their hub fetches it only when they accept, for 30 days.") }
    }
}

/** One value the sanitizer found: the rule, how often, the value (hidden until Show), and Keep anyway. */
@Composable
private fun FoundRow(item: RedactionItem, onKeep: () -> Unit) {
    val c = Conclave.colors
    var shown by remember(item.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(ShareWords.ruleWord(item.rule), style = ConclaveType.body.copy(fontWeight = FontWeight.Medium), color = c.fg)
            Spacer(Modifier.width(6.dp))
            Text(ShareWords.timesWords(item.count).lowercase(), style = ConclaveType.body, color = c.fg3)
        }
        Text(if (shown) item.original else ShareWords.maskValue(item.original), style = CodeStyle, color = if (shown) c.fg else c.fg2)
        Text(
            ShareWords.goesAs(item) + if (item.kept && item.rule == "secret") ". Their hub takes a secret out again." else "",
            style = ConclaveType.meta,
            color = if (item.kept) c.warn else c.fg3,
        )
        Row {
            TextButton(onClick = { shown = !shown }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (shown) "Hide" else "Show", color = c.fg2) }
            if (item.kept) {
                OutlinedButton(onClick = onKeep, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.heightIn(min = 48.dp)) { Text("Take out again") }
            } else {
                TextButton(onClick = onKeep, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep anyway", color = c.fg) }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = c.rule)
    }
}

/** After Send: what went to whom, and what happens next. */
@Composable
private fun SentState(share: SentShareDto, names: List<String>) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // the rope pulls out through the knot, the light leading (docs/design/KNOT-MOTION.md 5)
        Box(Modifier.height(36.dp), contentAlignment = Alignment.CenterStart) {
            KnotRope(dev.conclave.client.motion.RopeMoment.SEND, size = 28.dp, label = "Sent")
        }
        Text("Sent '${share.title}' to ${ShareWords.namesWords(names)}.", style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg)
        Text("${ShareWords.summaryText(share.kind, share.summary)}. Their hub fetches it only when they accept, for 30 days.", style = ConclaveType.body, color = c.fg2)
        Text(
            "Update sends a new revision of it. Unsend asks their hub to delete its copy. Both are on " +
                (if (names.size == 1) "${names[0]}'s page" else "each friend's page") + " and under Shares.",
            style = ConclaveType.meta.copy(fontSize = 14.sp),
            color = c.fg3,
        )
    }
}

@Composable
private fun Heading(text: String) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        Text(text, style = ConclaveType.section, color = c.fg, modifier = Modifier.padding(bottom = 6.dp))
        HorizontalDivider(thickness = 1.dp, color = c.rule2)
    }
}

@Composable
private fun Label(text: String) {
    Text(text, style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium, fontSize = 14.sp), color = Conclave.colors.fg2, modifier = Modifier.padding(top = 4.dp))
}

@Composable
private fun Help(text: String) {
    Text(text, style = ConclaveType.meta, color = Conclave.colors.fg3)
}

@Composable
private fun SwitchLine(title: String, help: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = Conclave.colors
    Row(Modifier.fillMaxWidth().clickable { onChange(!checked) }.heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium, fontSize = 14.sp), color = c.fg2)
            help?.let { Text(it, style = ConclaveType.meta, color = c.fg3) }
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
