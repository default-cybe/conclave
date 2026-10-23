@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.friends

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.data.CodeDefaults
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.rememberClock
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.conversation.ChoiceRow
import dev.conclave.app.ui.conversation.CodeWhereSheet
import dev.conclave.app.ui.conversation.OptionLabel
import dev.conclave.app.ui.conversation.OptionRow
import dev.conclave.app.ui.conversation.deviceLabel
import dev.conclave.app.ui.conversation.folderLabel
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.applyShare
import dev.conclave.client.handoffDraft
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.model.ApplyShareInput
import dev.conclave.client.model.ApplySharePlan
import dev.conclave.client.model.ApplyShareResult
import dev.conclave.client.model.ForkShareInput
import dev.conclave.client.model.HandoffDraft
import dev.conclave.client.model.HandoffShareInput
import dev.conclave.client.model.ReceivedShareDto
import dev.conclave.client.model.ShareViewCode
import dev.conclave.client.planApplyShare
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/*
 * What the owner does with a share a friend sent, once accepted (docs/
 * design/FRIENDS.md, phase 3; the web's ShareActions.tsx): Continue as
 * fork, Handoff (a fresh session from a brief the owner edits first), Use
 * as reference, and Apply code (a plan the hub checks, then an approval,
 * then a new branch). A fork's and a handoff's first turn asks before any
 * tool runs, whatever the permission mode.
 */

/** A sheet with a title, its body scrolling, and its buttons at the foot. */
@Composable
private fun ActionSheet(title: String, onDismiss: () -> Unit, buttons: @Composable RowScope.() -> Unit, content: @Composable () -> Unit) {
    val c = Conclave.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding()) {
            Text(title, style = ConclaveType.title, color = c.fg, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) { content() }
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                buttons()
            }
        }
    }
}

/** Where a new session runs: the hub's own device until the owner picks another. */
@Composable
private fun rememberWhere(): androidx.compose.runtime.MutableState<CodeDefaults> {
    val hub = LocalAppContainer.current.hub
    return remember { mutableStateOf(CodeDefaults(device = if (hub.devices.value.any { it.id == "local" }) "local" else null)) }
}

@Composable
private fun WhereRow(where: CodeDefaults, onPick: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val devices by hub.devices.collectAsStateWithLifecycle()
    Column(Modifier.bleed(20.dp)) {
        OptionRow(
            "Runs on",
            if (where.device == null) "The hub picks" else "${deviceLabel(where.device, devices)}, ${if (where.cwd == null) "its usual folder" else folderLabel(where.cwd)}",
            onClick = onPick,
        )
    }
}

// ---------------------------------------------------------------------------
// Continue as fork
// ---------------------------------------------------------------------------

@Composable
fun ForkSheet(s: ReceivedShareDto, vm: FriendsViewModel, onDone: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Conclave.colors
    val busy by vm.busy.collectAsStateWithLifecycle()
    var where by rememberWhere()
    var picking by remember { mutableStateOf(false) }
    var prompt by remember { mutableStateOf("") }
    val chat = s.kind == "chat"
    val starting = "fork:${s.id}" in busy
    ActionSheet("Continue as fork", onDismiss, buttons = {
        TextButton(onClick = onDismiss, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Cancel", color = c.fg2) }
        Button(
            onClick = {
                vm.forkShare(
                    s,
                    ForkShareInput(device = if (chat) null else where.device, cwd = if (chat) null else where.cwd, prompt = prompt.trim().ifEmpty { null }),
                    onDone = { onDone(it.id) },
                )
            },
            enabled = !starting,
            colors = solidButtonColors(),
            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
        ) { Swap(on = starting, off = { Text("Continue as fork") }) { Text("Starting") } }
    }) {
        Text(
            "A new ${if (chat) "chat" else "session"} on your models, with ${s.friendName}'s turns quoted. ${ShareWords.FORK_LINE} ${s.friendName}'s copy stays as it is.",
            style = ConclaveType.body,
            color = c.fg2,
        )
        if (!chat) WhereRow(where, onPick = { picking = true })
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it },
            label = { Text("First message, optional") },
            placeholder = { Text("Carry on from here") },
            minLines = 2,
            maxLines = 8,
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Empty: read it first and write when you are ready.", style = ConclaveType.meta, color = c.fg3)
    }
    if (picking) CodeWhereSheet(where, onChange = { where = it }, onDone = { picking = false }, onDismiss = { picking = false }, done = "Done")
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

@Composable
fun HandoffSheet(s: ReceivedShareDto, vm: FriendsViewModel, onDone: (String) -> Unit, onDismiss: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val c = Conclave.colors
    val busy by vm.busy.collectAsStateWithLifecycle()
    var draft by remember { mutableStateOf<HandoffDraft?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var title by remember { mutableStateOf("") }
    var brief by remember { mutableStateOf("") }
    var where by rememberWhere()
    var picking by remember { mutableStateOf(false) }
    LaunchedEffect(s.id) {
        try {
            val d = hub.api { it.handoffDraft(s.id) }
            draft = d
            title = d.title
            brief = d.brief
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = errorText(e)
        }
    }
    val starting = "handoff:${s.id}" in busy
    ActionSheet("Handoff", onDismiss, buttons = {
        TextButton(onClick = onDismiss, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Cancel", color = c.fg2) }
        Button(
            onClick = {
                vm.handoffShare(
                    s,
                    HandoffShareInput(brief = brief.trim(), title = title.trim().ifEmpty { null }, device = where.device, cwd = where.cwd),
                    onDone = { onDone(it.id) },
                )
            },
            enabled = draft != null && brief.isNotBlank() && !starting,
            colors = solidButtonColors(),
            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
        ) { Swap(on = starting, off = { Text("Start session") }) { Text("Starting") } }
    }) {
        Text("A fresh session on your models starts from this brief. Edit it first: it is the session's first message. ${ShareWords.FORK_LINE}", style = ConclaveType.body, color = c.fg2)
        error?.let { Text(it, style = ConclaveType.body, color = c.fault) }
        val d = draft
        if (d == null && error == null) Text("Writing the brief", style = ConclaveType.body, color = c.fg3)
        if (d != null) {
            OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = brief, onValueChange = { brief = it }, label = { Text("Brief") }, minLines = 8, maxLines = 18, textStyle = ConclaveType.body, modifier = Modifier.fillMaxWidth())
            if (d.files.isNotEmpty()) {
                Column {
                    Text("Files it names", style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg2)
                    d.files.take(12).forEach { Text(it, style = CodeStyle, color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    if (d.files.size > 12) Text("and ${d.files.size - 12} more", style = ConclaveType.meta, color = c.fg3)
                }
            }
            WhereRow(where, onPick = { picking = true })
        }
    }
    if (picking) CodeWhereSheet(where, onChange = { where = it }, onDone = { picking = false }, onDismiss = { picking = false }, done = "Done")
}

// ---------------------------------------------------------------------------
// Use as reference
// ---------------------------------------------------------------------------

@Composable
fun ReferenceDialog(s: ReceivedShareDto, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    ConfirmDialog(
        title = "Use as reference?",
        text = "A read only copy your agents can find with past chat search, marked as ${s.friendName}'s and quoted. It never runs, and memory never learns from it. If ${s.friendName} unsends it, it goes.",
        confirmLabel = "Keep as reference",
        onConfirm = onConfirm,
        onDismiss = onDismiss,
    )
}

// ---------------------------------------------------------------------------
// Apply code
// ---------------------------------------------------------------------------

private enum class ApplyStep { WHERE, PLAN, DONE }

/**
 * The share's code onto a new branch: pick a device and a folder in the
 * repository there; the hub checks it and shows the plan; the owner
 * approves it; the branch is made without checking anything out.
 */
@Composable
fun ApplySheet(s: ReceivedShareDto, code: ShareViewCode?, onDismiss: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val c = Conclave.colors
    val context = LocalContext.current
    val devicesAll by hub.devices.collectAsStateWithLifecycle()
    val devices = remember(devicesAll) { devicesAll.sortedWith(compareByDescending<dev.conclave.client.model.Device> { it.online }.thenBy { it.name.lowercase() }) }
    val scope = rememberCoroutineScope()
    val clock = rememberClock()
    var step by remember { mutableStateOf(ApplyStep.WHERE) }
    // a device that is on, a computer before the hub's own
    var device by remember { mutableStateOf(devices.firstOrNull { it.online && it.id != "local" }?.id ?: devices.firstOrNull { it.online }?.id ?: "") }
    var cwd by remember { mutableStateOf("") }
    var branch by remember { mutableStateOf("") }
    var plan by remember { mutableStateOf<ApplySharePlan?>(null) }
    var done by remember { mutableStateOf<ApplyShareResult?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val dev = devices.firstOrNull { it.id == device }
    val hint = ShareWords.branchHint(s.friendName, s.title)

    fun check() = scope.launch {
        busy = true
        error = null
        try {
            plan = hub.api { it.planApplyShare(s.id, ApplyShareInput(device, cwd.trim(), branch.trim().ifEmpty { null })) }
            step = ApplyStep.PLAN
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = errorText(e)
        } finally {
            busy = false
        }
    }

    fun apply() = scope.launch {
        val p = plan ?: return@launch
        busy = true
        error = null
        try {
            done = hub.api { it.applyShare(s.id, p.planId) }
            step = ApplyStep.DONE
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = errorText(e)
        } finally {
            busy = false
        }
    }

    val title = when (step) {
        ApplyStep.WHERE -> "Apply code"
        ApplyStep.PLAN -> "Approve the code"
        ApplyStep.DONE -> "Applied"
    }
    ActionSheet(title, onDismiss, buttons = {
        when (step) {
            ApplyStep.WHERE -> {
                TextButton(onClick = onDismiss, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Cancel", color = c.fg2) }
                Button(onClick = { check() }, enabled = device.isNotEmpty() && cwd.isNotBlank() && !busy, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Swap(on = busy, off = { Text("Check") }) { Text("Checking") }
                }
            }
            ApplyStep.PLAN -> {
                TextButton(onClick = { step = ApplyStep.WHERE }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Back", color = c.fg2) }
                Button(onClick = { apply() }, enabled = plan?.check?.ok == true && !busy, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Swap(on = busy, off = { Text("Apply to the new branch", maxLines = 1, overflow = TextOverflow.Ellipsis) }) { Text("Applying") }
                }
            }
            ApplyStep.DONE -> Button(onClick = onDismiss, colors = solidButtonColors(), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Done") }
        }
    }) {
        error?.let { Text(it, style = ConclaveType.body, color = c.fault) }
        when (step) {
            ApplyStep.WHERE -> {
                Text(
                    (if (code != null) "${ShareWords.codeWords(code.kind, code.files.size, code.branch)} from ${s.friendName}" else "The code ${s.friendName} sent") +
                        " goes onto a new branch in a repository you pick. The hub checks it first and shows you the plan. Nothing changes until you approve it.",
                    style = ConclaveType.body,
                    color = c.fg2,
                )
                Column(Modifier.bleed(20.dp)) {
                    OptionLabel("Device")
                    devices.forEach { d ->
                        ChoiceRow(
                            if (d.online) d.name.ifBlank { d.id } else "${d.name.ifBlank { d.id }}, offline",
                            selected = device == d.id,
                            onClick = { if (d.online) device = d.id },
                        )
                    }
                }
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    label = { Text("Folder in the repository") },
                    placeholder = { Text("~/code/project", style = CodeStyle) },
                    textStyle = CodeStyle,
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                dev?.roots?.take(6)?.forEach { r ->
                    TextButton(onClick = { cwd = r }, modifier = Modifier.heightIn(min = 44.dp)) { Text(r, style = CodeStyle, color = c.fg3) }
                }
                OutlinedTextField(
                    value = branch,
                    onValueChange = { branch = it },
                    label = { Text("Branch, optional") },
                    placeholder = { Text(hint, style = CodeStyle) },
                    textStyle = CodeStyle,
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            ApplyStep.PLAN -> plan?.let { p ->
                Text(ShareWords.planSentence(p), style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg)
                if (p.check.ok) {
                    Text("It applies cleanly.", style = ConclaveType.body, color = c.ok)
                } else {
                    Text("It would not apply: ${p.check.error ?: "the hub could not say why"}", style = ConclaveType.body, color = c.fault)
                }
                if (p.runsCode.isNotEmpty()) {
                    Barred(c.warn) {
                        Text("These can run code once you check out or build. Read them first.", style = ConclaveType.body, color = c.warn)
                        p.runsCode.forEach { Text(it, style = CodeStyle, color = c.fg) }
                    }
                }
                Column {
                    Text("Files", style = ConclaveType.meta.copy(fontSize = 14.sp), color = c.fg2)
                    p.files.take(60).forEach { f -> Text(f, style = CodeStyle, color = if (f in p.runsCode) c.warn else c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    if (p.files.size > 60) Text("and ${p.files.size - 60} more", style = ConclaveType.meta, color = c.fg3)
                }
                Text("Nothing is checked out and your working tree stays as it is. No hook or script from the share runs.", style = ConclaveType.body, color = c.fg2)
                Text(ShareWords.planUntil(p, clock), style = ConclaveType.meta, color = c.fg3)
            }
            ApplyStep.DONE -> done?.let { r ->
                Text("${r.branch} is at ${r.commit.take(12)}.", style = ConclaveType.body.copy(fontSize = 16.sp), color = c.fg)
                Text("Nothing was checked out. To look at it in ${r.root}:", style = ConclaveType.body, color = c.fg2)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("git switch ${r.branch}", style = CodeStyle, color = c.fg, modifier = Modifier.weight(1f))
                    TextButton(onClick = { copyText(context, "git switch ${r.branch}", "Command") }) { Text("Copy", color = c.fg) }
                }
            }
        }
    }
}
