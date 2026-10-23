@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.FolderZip
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.CyberAccess
import dev.conclave.client.logic.Attach
import dev.conclave.client.logic.ContextUse
import dev.conclave.client.logic.Effort
import dev.conclave.client.logic.EffortFollow
import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.Start
import dev.conclave.client.model.Attachment
import dev.conclave.client.model.ChatSettings
import dev.conclave.client.model.CommandDef
import dev.conclave.client.model.Device
import dev.conclave.client.model.ModelEffort
import dev.conclave.client.model.PermissionMode
import dev.conclave.client.model.ThinkingLevel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * Parts of the composer, shaped like Claude Code's (docs/DESIGN.md 40, web
 * features/conversation/ComposerParts.tsx): under the box one quiet row,
 * the permission mode (and Code's folder) at the left, the model with its
 * effort as one picker ("Opus 5.5 Medium") and a small context ring at the
 * right. Everything else is under "+" or "/". The sheets' rows live here
 * too, so every screen's "+" reads the same. The files over the field are
 * one row that scrolls sideways at a fixed height (AttachmentStrip).
 */

/** The permission modes in words, as the session's sheet and Code say them. */
fun permissionLabel(p: PermissionMode): String = when (p) {
    PermissionMode.DEFAULT -> "Ask"
    PermissionMode.ACCEPT_EDITS -> "Accept edits"
    PermissionMode.PLAN -> "Plan only"
    PermissionMode.BYPASS -> "Bypass"
}

/** One line on what a permission mode does. */
fun permissionDetail(p: PermissionMode): String = when (p) {
    PermissionMode.DEFAULT -> "Asks before commands and edits"
    PermissionMode.ACCEPT_EDITS -> "Edits files, asks before commands"
    PermissionMode.PLAN -> "Reads and plans, changes nothing"
    PermissionMode.BYPASS -> "Never asks"
}

/** The one line under Ultra (the same words as the web). */
const val ULTRA_LINE = "Plans and runs workflows for real tasks. Uses many more tokens."

/** The chat's "+" switches, with the web's words. */
const val WEB_HELP = "Look things up and cite sources."
const val MEMORY_HELP = "Read what it knows about you and save what you tell it. Off: this chat leaves no trace in memory."

/** A device's name, the hub as "homelab (hub)" (Start.placeName), with "offline" after a computer that is away. */
fun deviceLabel(id: String?, devices: List<Device>, hubName: String? = null): String {
    val d = devices.firstOrNull { it.id == id }
    return when {
        id == null -> "Not set"
        id == Start.HUB || d == null || d.online -> Start.placeName(id, devices, hubName)
        else -> "${Start.placeName(id, devices, hubName)}, offline"
    }
}

/** A folder as a row names it: its last part, "Home folder" for ~. */
fun folderLabel(cwd: String?): String = when {
    cwd == null -> "Not set"
    cwd.isBlank() || cwd == "~" || Paths.folderName(cwd).isEmpty() -> "Home folder"
    else -> Paths.folderName(cwd)
}

// ---------------------------------------------------------------------------
// The quiet row
// ---------------------------------------------------------------------------

/** The row under the box: [left] (permission mode, folder, device) scrolls if it must; [right] keeps its width. */
@Composable
fun QuietRow(left: (@Composable RowScope.() -> Unit)?, right: @Composable RowScope.() -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            if (left != null) left()
        }
        Row(verticalAlignment = Alignment.CenterVertically, content = right)
    }
}

/** A word in the quiet row that opens its picker: fg-3 text and a small chevron, 40dp to touch. */
@Composable
fun QuietChip(
    text: String,
    onClickLabel: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    maxWidth: Dp = 180.dp,
    strong: Boolean = false,
) {
    val c = Conclave.colors
    Row(
        modifier
            .heightIn(min = 40.dp)
            .widthIn(max = maxWidth)
            .clip(RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClickLabel = onClickLabel, role = Role.Button, onClick = onClick)
            .padding(start = 8.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = ConclaveType.meta,
            color = if (strong) c.fg2 else c.fg3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(14.dp), tint = c.fg3)
    }
}

/** The permission mode at the left of the quiet row; a tap lists the four with a line each. */
@Composable
fun PermissionChip(value: PermissionMode, onChange: (PermissionMode) -> Unit, enabled: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    QuietChip(permissionLabel(value), onClickLabel = "Permissions, ${permissionLabel(value)}", onClick = { open = true }, enabled = enabled)
    if (open) {
        OptionsSheet("Permissions", onDismiss = { open = false }) {
            PermissionMode.entries.forEach { p ->
                ChoiceRow(permissionLabel(p), selected = value == p, detail = permissionDetail(p), onClick = {
                    open = false
                    onChange(p)
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Effort, in the model's picker
// ---------------------------------------------------------------------------

/**
 * The Effort row on top of the model picker: the levels the model has
 * (ModelInfo.effort), the one it runs at marked, the default named under
 * them. With [follow] (a session's agent), unset runs at the agent's level
 * and "Use the coder agent's" goes back to it.
 */
@Composable
fun EffortPicker(effort: ModelEffort, value: ThinkingLevel?, follow: EffortFollow?, onEffort: (ThinkingLevel?) -> Unit) {
    val c = Conclave.colors
    val levels = Effort.choices(effort)
    if (levels.isEmpty()) return
    val shown = Effort.running(value, effort, follow)
    val modelDefault = Effort.defaultOf(effort)
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Effort", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
            if (follow != null) {
                if (value != null) {
                    Text(
                        "Use ${follow.label}'s",
                        style = ConclaveType.meta,
                        color = c.fg2,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(onClickLabel = "Use ${follow.label}'s effort", role = Role.Button) { onEffort(null) }
                            .padding(horizontal = 8.dp, vertical = 10.dp),
                    )
                } else {
                    Text("As ${follow.label} sets", style = ConclaveType.meta, color = c.fg4)
                }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            levels.forEach { level ->
                EffortChip(Effort.label(level, effort), selected = level == shown, onClick = { onEffort(level) })
            }
        }
        if (modelDefault != null) {
            Text(
                "${Effort.label(modelDefault, effort)} is the model's default.",
                style = ConclaveType.meta,
                color = c.fg3,
                modifier = Modifier.padding(top = 6.dp, bottom = 4.dp),
            )
        }
    }
}

/** Cyber access under Effort: Default (sends nothing), then the programs the model takes (core providers/access-programs.ts). */
@Composable
fun CyberPicker(choices: List<String?>, value: String?, onCyber: (String?) -> Unit) {
    if (choices.isEmpty()) return
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)) {
        Text("Cyber access", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.heightIn(min = 40.dp).padding(top = 12.dp))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            choices.forEach { p -> EffortChip(CyberAccess.label(p), selected = p == value, onClick = { onCyber(p) }) }
        }
    }
}

/** One level: an outline, the chosen one raised. Neutral ink, never violet (docs/DESIGN.md 13). */
@Composable
private fun EffortChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = Conclave.colors
    val shape = RoundedCornerShape(20.dp)
    Box(
        Modifier
            .heightIn(min = 40.dp)
            .clip(shape)
            .then(if (selected) Modifier.background(c.bgRaise).border(1.dp, c.edge, shape) else Modifier.border(1.dp, c.rule2, shape))
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = ConclaveType.button.copy(fontSize = 14.sp), color = if (selected) c.fg else c.fg3, maxLines = 1)
    }
}

// ---------------------------------------------------------------------------
// The context ring
// ---------------------------------------------------------------------------

/** A 16dp ring filled by the share of the context window in use, amber past 80%; a tap says the numbers. */
@Composable
fun ContextRing(use: ContextUse, onClick: () -> Unit, enabled: Boolean = true) {
    val c = Conclave.colors
    val track = c.rule2
    val ink = if (use.high) c.warn else c.fg3
    val share = use.share.toFloat()
    Box(
        Modifier
            .size(40.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClickLabel = "Show the context", role = Role.Button, onClick = onClick)
            .semantics { contentDescription = use.label },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(16.dp)) {
            val stroke = 1.75.dp.toPx()
            val inset = stroke / 2f
            val ring = Size(size.width - stroke, size.height - stroke)
            drawArc(color = track, startAngle = 0f, sweepAngle = 360f, useCenter = false, topLeft = Offset(inset, inset), size = ring, style = Stroke(width = stroke))
            if (share > 0f) {
                drawArc(color = ink, startAngle = -90f, sweepAngle = 360f * share, useCenter = false, topLeft = Offset(inset, inset), size = ring, style = Stroke(width = stroke, cap = StrokeCap.Round))
            }
        }
    }
}

/** What the ring stands for: the context against the window, the tokens and the cost, and Usage. */
@Composable
fun ContextSheet(use: ContextUse, onUsage: (() -> Unit)?, onDismiss: () -> Unit) {
    val c = Conclave.colors
    OptionsSheet("Context", onDismiss) {
        FactRow("Context", use.contextLine)
        if (use.session) {
            FactRow("Tokens", use.tokensLine)
            FactRow("Cost", use.costLine)
        }
        if (onUsage != null) {
            HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(top = 8.dp))
            OptionRow("Usage", null, onClick = {
                onDismiss()
                onUsage()
            })
        }
    }
}

@Composable
private fun FactRow(name: String, value: String) {
    val c = Conclave.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(name, style = ConclaveType.body, color = c.fg3, modifier = Modifier.weight(1f))
        Text(value, style = ConclaveType.body.copy(fontFeatureSettings = "tnum"), color = c.fg)
    }
}

// ---------------------------------------------------------------------------
// "/" and "+"
// ---------------------------------------------------------------------------

/** The hub's commands that match what was typed after "/": a tap puts "/name " in the box. */
@Composable
fun SlashMenu(matches: List<CommandDef>, onPick: (CommandDef) -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .clip(shape)
            .background(c.bgRaise)
            .border(1.dp, c.rule2, shape)
            .heightIn(max = 264.dp)
            .verticalScroll(rememberScrollState())
            .padding(vertical = 4.dp),
    ) {
        matches.forEach { cmd ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .clickable(onClickLabel = "Use /${cmd.name}") { onPick(cmd) }
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("/" + cmd.name, style = CodeStyle.copy(fontSize = 14.sp), color = c.fg, maxLines = 1)
                val hint = cmd.argumentHint?.ifBlank { null }
                if (hint != null) Text(" $hint", style = CodeStyle.copy(fontSize = 14.sp), color = c.fg3, maxLines = 1)
                val about = cmd.description?.ifBlank { null }
                if (about != null) {
                    Spacer(Modifier.width(10.dp))
                    Text(about, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

/** A chat's "+" after the files: search the web and use memory. */
@Composable
fun ChatSwitches(sw: ChatSettings, onWeb: (Boolean) -> Unit, onMemory: (Boolean) -> Unit) {
    SwitchRow("Search the web", WEB_HELP, sw.webSearch, onWeb)
    SwitchRow("Use memory", MEMORY_HELP, sw.memory, onMemory)
}

// ---------------------------------------------------------------------------
// Sheet rows
// ---------------------------------------------------------------------------

/** A sheet of the composer's choices, with its title; rows go in [content]. */
@Composable
fun OptionsSheet(title: String, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val c = Conclave.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(bottom = 12.dp)) {
            Text(title, style = ConclaveType.title, color = c.fg, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            content()
        }
    }
}

/** A row of the options sheet: its name, the value on the right and a chevron. */
@Composable
fun OptionRow(title: String, value: String?, onClick: () -> Unit, valueContent: (@Composable () -> Unit)? = null) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 52.dp).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = ConclaveType.rowTitle, color = c.fg, modifier = Modifier.weight(1f))
        when {
            valueContent != null -> valueContent()
            value != null -> Text(value, style = ConclaveType.body, color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
        }
        Spacer(Modifier.width(8.dp))
        Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.fg3)
    }
}

/** A row with a check on the chosen one. */
@Composable
fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit, detail: String? = null) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 48.dp).padding(horizontal = 20.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = ConclaveType.body, color = if (selected) c.fg else c.fg2)
            if (detail != null) Text(detail, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", modifier = Modifier.size(16.dp), tint = c.fg)
    }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * The files over the field (docs/design/CHAT-AND-MOTION.md 2.5; the web's
 * ComposerParts.tsx AttachmentStrip): one row of chips, left to right, that
 * scrolls sideways at a fixed height, so the field stays on screen with any
 * number of files (15 at most, Attach.MAX). A picture is a thumbnail,
 * another file its name and size; each has an x. Once the row scrolls,
 * "7 files" sits at its right.
 */
@Composable
fun AttachmentStrip(files: List<Attachment>, onRemove: (Attachment) -> Unit, modifier: Modifier = Modifier) {
    if (files.isEmpty()) return
    val c = Conclave.colors
    val scroll = rememberScrollState()
    // a file just added comes into view at the end of the row
    val seen = remember { intArrayOf(files.size) }
    LaunchedEffect(files.size) {
        if (files.size > seen[0]) {
            withFrameNanos { }
            scroll.scrollTo(scroll.maxValue)
        }
        seen[0] = files.size
    }
    Row(modifier.fillMaxWidth().height(STRIP_HEIGHT), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).horizontalScroll(scroll).semantics { contentDescription = "Attachments, ${Attach.filesWord(files.size)}" },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            files.forEach { a -> AttachmentChip(a, onRemove = { onRemove(a) }) }
        }
        if (scroll.maxValue > 0) {
            Text(Attach.filesWord(files.size), style = ConclaveType.metaNum, color = c.fg3, maxLines = 1, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

/** The strip's height: one row of 48dp chips and room for an x on a thumbnail's corner. */
val STRIP_HEIGHT = 60.dp

/** One file in the strip: a 48dp thumbnail for a picture, else its icon, name and size; an x to take it off. */
@Composable
private fun AttachmentChip(a: Attachment, onRemove: () -> Unit) {
    val c = Conclave.colors
    val image = a.mediaType.startsWith("image/")
    val target = with(LocalDensity.current) { 96.dp.roundToPx() }
    val bitmap by produceState<ImageBitmap?>(null, a.data, target) {
        val data = a.data
        // decoded off the main thread at about the size it shows (Reply.kt)
        value = if (!image || data == null) null else withContext(Dispatchers.Default) { decodeScaled(data, target) }
    }
    val name = a.name ?: a.mediaType
    val shape = RoundedCornerShape(8.dp)
    Box {
        val b = bitmap
        if (b != null) {
            Image(b, contentDescription = name, contentScale = ContentScale.Crop, modifier = Modifier.size(48.dp).clip(shape).border(1.dp, c.rule, shape))
        } else {
            Row(
                Modifier.heightIn(min = 48.dp).widthIn(max = 200.dp).clip(shape).background(c.bgRaise).border(1.dp, c.rule, shape).padding(start = 10.dp, end = 34.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (Attach.isZip(a.mediaType, a.name)) Icons.Outlined.FolderZip else Icons.Outlined.Description, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.fg3)
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f, fill = false)) {
                    Text(name, style = ConclaveType.meta, color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(sizeLabel(Attach.sizeOf(a)), style = ConclaveType.metaNum, color = c.fg3, maxLines = 1)
                }
            }
        }
        // the x: 20dp to see, 32dp to touch, in the thumbnail's corner or at the chip's end
        Box(
            Modifier
                .align(if (b != null) Alignment.TopEnd else Alignment.CenterEnd)
                .size(32.dp)
                .clip(CircleShape)
                .clickable(onClickLabel = "Remove $name", role = Role.Button, onClick = onRemove),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(20.dp).clip(CircleShape).background(c.bgRaise).border(1.dp, c.rule, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Close, contentDescription = "Remove $name", modifier = Modifier.size(12.dp), tint = c.fg3)
            }
        }
    }
}

/** "1.2 MB", "340 KB", "12 B". */
fun sizeLabel(bytes: Long): String = when {
    bytes >= 1_000_000 -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1_000_000.0)
    bytes >= 1_000 -> "${bytes / 1_000} KB"
    else -> "$bytes B"
}

/** A group label inside the sheet ("Effort", "Permission"). */
@Composable
fun OptionLabel(text: String) {
    Text(text, style = ConclaveType.meta, color = Conclave.colors.fg3, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 4.dp))
}

@Composable
fun SwitchRow(title: String, help: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.heightIn(min = 52.dp).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = ConclaveType.rowTitle, color = c.fg)
            if (help != null) Text(help, style = ConclaveType.meta, color = c.fg3)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
