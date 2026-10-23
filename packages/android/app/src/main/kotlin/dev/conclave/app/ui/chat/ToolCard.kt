package dev.conclave.app.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.common.CodeBox
import dev.conclave.app.ui.motion.Knot
import dev.conclave.app.ui.workflows.LocalOpenWorkflowRun
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.LocalExtraColors
import dev.conclave.client.logic.DiffLine
import dev.conclave.client.logic.Diffs
import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.ToolSummary
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.motion.KnotState
import kotlinx.serialization.json.Json

private val PrettyJson = Json { prettyPrint = true }

/** The folder of the session on screen: tool rows name files relative to it ("src/auth/redirect.ts"). */
val LocalSessionCwd = staticCompositionLocalOf<String?> { null }

private fun toolIcon(name: String): ImageVector = when (name) {
    "Bash" -> Icons.Outlined.Terminal
    "Read" -> Icons.Outlined.Description
    "Edit", "Write", "MultiEdit", "NotebookEdit" -> Icons.Outlined.EditNote
    "Grep", "Glob" -> Icons.Outlined.Search
    "WebFetch", "WebSearch" -> Icons.Outlined.Language
    "Task" -> Icons.Outlined.SmartToy
    else -> Icons.Outlined.Build
}

/** One tool call: a summary line, expandable to input and output (or a colored diff for edits). */
@Composable
fun ToolCard(use: ToolUseBlock, result: ToolResultBlock?, running: Boolean, progress: String?) {
    var expanded by rememberSaveable(use.id) { mutableStateOf(false) }
    val cwd = LocalSessionCwd.current
    val summary = remember(use.name, use.input, cwd) {
        if (use.name.isBlank()) "Preparing a tool call" else ToolSummary.of(use.name, use.input, cwd)
    }
    // a file: its verb, then the path with the folders cut before the name
    val file = remember(use.name, use.input, cwd) { ToolSummary.file(use.name, use.input, cwd) }
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(toolIcon(use.name), contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(10.dp))
                if (file != null && !expanded) {
                    FileSummary(file.first, file.second, Modifier.weight(1f))
                } else {
                    Text(
                        summary,
                        style = CodeStyle,
                        maxLines = if (expanded) 4 else 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
                Spacer(Modifier.width(8.dp))
                // State as a word (spec 10.17). A running tool shows the still working Knot: the turn's
                // live line already has the one that moves, and rows never animate a Knot.
                when {
                    result?.isError == true -> Text("failed", style = ConclaveType.meta, color = Conclave.colors.fault)
                    result != null -> Text("done", style = ConclaveType.meta, color = Conclave.colors.fg3)
                    running -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Knot(KnotState.TOOL, size = 12.dp, still = true, surface = MaterialTheme.colorScheme.surfaceContainerLow)
                        Spacer(Modifier.width(6.dp))
                        Text("running", style = ConclaveType.meta, color = Conclave.colors.signal)
                    }
                }
                Spacer(Modifier.width(4.dp))
                Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null, modifier = Modifier.size(18.dp))
            }
            // a Workflow call opens its run: phases, agents and the result
            val openRun = LocalOpenWorkflowRun.current
            val runId = result?.meta?.workflowRunId
            if (use.name == "Workflow" && runId != null && openRun != null) {
                TextButton(onClick = { openRun(runId) }, modifier = Modifier.padding(start = 30.dp)) { Text("Open run") }
            }
            if (running && !progress.isNullOrBlank()) {
                Text(
                    progress.lines().lastOrNull { it.isNotBlank() } ?: progress,
                    style = CodeStyle,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 40.dp, end = 12.dp, bottom = 8.dp),
                )
            }
            if (expanded) {
                Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val diff = remember(use, result) { if (Diffs.isEditTool(use.name)) Diffs.forTool(use, result) else null }
                    if (diff != null) {
                        DiffView(diff)
                    } else {
                        Label("Input")
                        val input = remember(use.input, use.partialInput) {
                            if (use.input.isEmpty() && use.partialInput.isNotEmpty()) use.partialInput
                            else PrettyJson.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), use.input)
                        }
                        CodeBox(input, maxLines = 40)
                    }
                    if (result != null) {
                        Label(if (result.isError) "Error" else "Output")
                        OutputView(result)
                    }
                    result?.meta?.let { meta ->
                        val parts = buildList {
                            meta.exitCode?.let { add("exit $it") }
                            meta.durationMs?.let { add("${it} ms") }
                            if (meta.truncated == true) add("truncated")
                            if (meta.external == true) add("run by the harness")
                        }
                        if (parts.isNotEmpty()) Text(parts.joinToString(", "), style = ConclaveType.metaNum, color = Conclave.colors.fg3)
                    }
                }
            }
        }
    }
}

/**
 * "Read src/auth/redirect.ts" on one line. When the row is too narrow the
 * folders give way first ("src/au…redirect.ts"), the file name last: the
 * name is measured before the weighted folders.
 */
@Composable
private fun FileSummary(verb: String, path: String, modifier: Modifier = Modifier) {
    val (folders, name) = remember(path) { Paths.split(path) }
    Row(modifier) {
        Text("$verb ", style = CodeStyle, maxLines = 1)
        if (folders.isNotEmpty()) {
            Text(folders, style = CodeStyle, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        }
        Text(name, style = CodeStyle, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Label(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun OutputView(result: ToolResultBlock) {
    var all by remember(result) { mutableStateOf(false) }
    val text = remember(result) { result.text }
    val lines = remember(text) { text.lines() }
    val limit = 60
    CodeBox(if (all || lines.size <= limit) text else lines.take(limit).joinToString("\n"))
    if (!all && lines.size > limit) {
        TextButton(onClick = { all = true }) { Text("Show all ${lines.size} lines") }
    }
}

/** Unified diff with added and removed lines tinted. */
@Composable
fun DiffView(lines: List<DiffLine>) {
    val extra = LocalExtraColors.current
    var all by remember(lines) { mutableStateOf(false) }
    val limit = 200
    val shown = if (all) lines else lines.take(limit)
    Surface(
        shape = RoundedCornerShape(5.dp),
        color = extra.codeBg,
        border = BorderStroke(1.dp, Conclave.colors.rule),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 6.dp).width(IntrinsicSize.Max)) {
            val c = Conclave.colors
            shown.forEach { line ->
                // Added and removed lines get a tinted row; only the +/- sign is green or red (spec 10.18).
                val (bg, sign) = when (line.kind) {
                    DiffLine.Kind.ADD -> extra.diffAddBg to extra.diffAddFg
                    DiffLine.Kind.DEL -> extra.diffDelBg to extra.diffDelFg
                    else -> Color.Transparent to Color.Unspecified
                }
                val fg = when (line.kind) {
                    DiffLine.Kind.HUNK, DiffLine.Kind.META -> c.fg3
                    else -> c.fg
                }
                val text = line.text.ifEmpty { " " }
                val styled = if (sign != Color.Unspecified && text.isNotEmpty()) {
                    buildAnnotatedString {
                        withStyle(SpanStyle(color = sign)) { append(text.substring(0, 1)) }
                        append(text.substring(1))
                    }
                } else {
                    AnnotatedString(text)
                }
                Text(
                    styled,
                    style = CodeStyle,
                    color = fg,
                    softWrap = false,
                    modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 10.dp),
                )
            }
        }
    }
    if (!all && lines.size > limit) {
        TextButton(onClick = { all = true }) { Text("Show all ${lines.size} lines") }
    }
}
