@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.workflows

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.common.EmptyState
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.StateWordText
import dev.conclave.app.ui.common.clockTime
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.WorkflowWords
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunStatus

/**
 * Workflow runs, newest first (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 5):
 * the workflow, its state word in a fixed place, agents, tokens and cost.
 * A run opens its view. With [sessionId] only that session's runs.
 */
@Composable
fun WorkflowRunsScreen(sessionId: String?, onBack: () -> Unit, onOpenRun: (String) -> Unit, onLaunch: () -> Unit = {}) {
    val hub = LocalAppContainer.current.hub
    val vm: RunsViewModel = viewModel(key = "runs:${sessionId.orEmpty()}") { RunsViewModel(hub, sessionId) }
    val runs by vm.runs.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    val title = if (sessionId != null) "This session's runs" else "Workflow runs"

    Scaffold(
        topBar = {
            TopBar(
                title,
                onBack = onBack,
                actions = {
                    IconButton(onClick = onLaunch) {
                        Icon(Icons.Outlined.PlayArrow, contentDescription = "Run a workflow")
                    }
                },
            )
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        PullToRefreshBox(isRefreshing = refreshing && runs != null, onRefresh = { vm.load() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            val list = runs
            when {
                list == null && error != null -> Column { ErrorBanner(error.orEmpty(), onRetry = { vm.load() }) }
                list == null -> LoadingBox()
                list.isEmpty() -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        EmptyState(
                            Icons.Outlined.AccountTree,
                            "No workflow runs yet",
                            "A workflow runs many agents in phases and checks their work. Ask an agent to run one, or turn on Ultra in a session.",
                        )
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(list, key = { it.id }) { run ->
                        RunRow(run, onClick = { onOpenRun(run.id) })
                        HorizontalDivider(thickness = 1.dp, color = Conclave.colors.rule, modifier = Modifier.padding(horizontal = 16.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun RunRow(run: WorkflowRun, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(run.name.ifBlank { "Workflow" }, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(WorkflowWords.runMeta(run), style = ConclaveType.metaNum, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(12.dp))
        Column(horizontalAlignment = Alignment.End) {
            val at = run.resumeAt
            val word = if (run.status == WorkflowRunStatus.WAITING_RESET && at != null && at > 0) "resumes ${clockTime(at)}" else WorkflowWords.runWord(run.status)
            StateWordText(word, WorkflowWords.runTone(run.status))
            Text(Format.relative(run.finishedAt ?: run.startedAt ?: run.createdAt), style = ConclaveType.metaNum, color = c.fg3, maxLines = 1)
        }
    }
}
