@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.common.ModelName
import dev.conclave.app.ui.common.clockTime
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.ApiValue
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.RepoWords
import dev.conclave.client.model.PrState
import dev.conclave.client.model.Session
import dev.conclave.client.model.repo
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One action of the conversation sheet. */
class SheetAction(val label: String, val danger: Boolean = false, val onClick: () -> Unit)

/**
 * The conversation's sheet, a tap on its title (MOBILE-V2 5): the agent,
 * model, device, folder, tokens, cost and when it started, then what can
 * be done with it. Tokens and cost live here, not in the transcript.
 */
@Composable
fun ConversationSheet(session: Session, deviceName: String?, actions: List<SheetAction>, onDismiss: () -> Unit) {
    val c = Conclave.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(bottom = 12.dp)) {
            Text(
                session.title.ifBlank { if (session.isChat) "New chat" else "New session" },
                style = ConclaveType.title,
                color = c.fg,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
            if (session.agent.isNotBlank()) Fact("Agent") { Text(session.agent, style = ConclaveType.body, color = c.fg) }
            Fact("Model") {
                if (session.model.isBlank()) Text("Hub default", style = ConclaveType.body, color = c.fg) else ModelName(session.model, size = 14.dp, style = ConclaveType.body, color = c.fg, asModel = true)
            }
            if (!session.isChat) {
                Fact("Device") { Text(deviceName ?: session.device, style = ConclaveType.body, color = c.fg) }
                // a repo session: its repository, branch and pull request instead of the worktree's path (docs/DESIGN.md 30)
                val repo = session.repo
                if (repo == null) {
                    Fact("Folder") { Text(Paths.shortPath(session.cwd, 3).ifEmpty { "~" }, style = CodeStyle, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                } else {
                    Fact("Repository") { Text(repo.repo, style = ConclaveType.body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    Fact("Branch") { Text(RepoWords.branchShort(repo.branch), style = CodeStyle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    repo.pr?.let { pr -> Fact("Pull request") { Text(RepoWords.prShort(pr) + (RepoWords.ci(repo.ci)?.let { ", ${it.lowercase()}" } ?: ""), style = ConclaveType.body, color = if (pr.state == PrState.MERGED) c.ok else c.fg) } }
                }
            }
            val st = session.stats
            Fact("Tokens") { Text("${Format.tokens(st.inputTokens)} in, ${Format.tokens(st.outputTokens)} out", style = ConclaveType.body, color = c.fg) }
            // a plan's session bills $0: what its calls are worth at API prices goes beside it
            Fact("Cost") { Text(Format.usd(st.costUsd) + (ApiValue.worthLine(st.costUsd, st.apiValueUsd)?.let { ", $it" } ?: ""), style = ConclaveType.body, color = c.fg) }
            if (session.createdAt > 0) Fact("Started") { Text(startedText(session.createdAt), style = ConclaveType.body, color = c.fg) }
            HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(vertical = 8.dp))
            actions.forEach { a -> SheetRow(a.label, danger = a.danger, onClick = a.onClick) }
        }
    }
}

/** A fact of the sheet: its name in fg-3, the value after it. */
@Composable
private fun Fact(name: String, value: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 36.dp).padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(name, style = ConclaveType.body, color = Conclave.colors.fg3, modifier = Modifier.width(96.dp))
        value()
    }
}

/** "Today, 8:53 PM" or "17 October, 8:53 PM". */
@Composable
private fun startedText(ts: Long): String {
    val zone = ZoneId.systemDefault()
    val day = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()
    val date = if (day == LocalDate.now(zone)) "Today" else day.format(DateTimeFormatter.ofPattern("d MMMM", Locale.ENGLISH))
    return "$date, ${clockTime(ts)}"
}
