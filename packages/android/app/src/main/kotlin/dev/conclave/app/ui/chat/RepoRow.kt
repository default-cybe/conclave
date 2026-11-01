package dev.conclave.app.ui.chat

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.RepoAction
import dev.conclave.client.logic.RepoTone
import dev.conclave.client.logic.RepoWords
import dev.conclave.client.model.RepoSessionDto
import dev.conclave.client.model.SessionRepo

/**
 * A repo session over the composer (docs/DESIGN.md 30): the repository and
 * its branch, then where things stand ([live]'s sentence once the hub
 * answers), and the one action a phone keeps here (Clean up, else Open pull
 * request, else Push); the conversation sheet has the rest. A tap on the
 * words opens the pull request on GitHub.
 */
@Composable
fun RepoRow(
    repo: SessionRepo,
    modifier: Modifier = Modifier,
    live: RepoSessionDto? = null,
    busy: String? = null,
    onAction: ((RepoAction) -> Unit)? = null,
) {
    val c = Conclave.colors
    val context = LocalContext.current
    val link = RepoWords.link(repo)
    val tone = when (RepoWords.tone(repo)) {
        RepoTone.OK -> c.ok
        RepoTone.FAULT -> c.fault
        RepoTone.LIVE -> c.signal
        RepoTone.QUIET -> c.fg3
    }
    Column(modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        HorizontalDivider(thickness = 1.dp, color = c.rule)
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                // a phone with no browser (a work profile, one turned off) has nothing to open it with: that must not close the app
                .then(if (link != null) Modifier.clickable { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) } } else Modifier)
                .padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(repo.repo, style = ConclaveType.body, color = c.fg, maxLines = 1)
                    Text(" on ", style = ConclaveType.body, color = c.fg2, maxLines = 1)
                    Text(RepoWords.branchShort(repo.branch), style = CodeStyle, color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(live?.line?.ifBlank { null } ?: RepoWords.line(repo), style = ConclaveType.meta, color = tone, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            val main = live?.let { RepoWords.mainAction(RepoWords.actions(it)) }
            when {
                main != null && onAction != null -> {
                    val working = when (main) {
                        RepoAction.PUSH -> if (busy == "push") "Pushing" else null
                        RepoAction.OPEN_PR -> if (busy == "draft" || busy == "pr") "Drafting" else null
                        RepoAction.CLEAN_UP -> if (busy == "clean") "Cleaning up" else null
                    }
                    val label = @Composable { Swap(on = working != null, off = { Text(main.label, maxLines = 1) }) { Text(working ?: "", maxLines = 1) } }
                    if (main == RepoAction.PUSH) {
                        OutlinedButton(onClick = { onAction(main) }, enabled = busy == null, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.padding(start = 12.dp).heightIn(min = 44.dp)) { label() }
                    } else {
                        Button(onClick = { onAction(main) }, enabled = busy == null, colors = solidButtonColors(), modifier = Modifier.padding(start = 12.dp).heightIn(min = 44.dp)) { label() }
                    }
                }
                link != null -> Text("View", style = ConclaveType.body, color = c.fg2, modifier = Modifier.padding(start = 12.dp))
            }
        }
    }
}
