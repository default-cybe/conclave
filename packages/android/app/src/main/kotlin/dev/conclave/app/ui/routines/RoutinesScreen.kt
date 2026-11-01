@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.routines

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.EmptyState
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.CardPanelHost
import dev.conclave.app.ui.motion.PanelCard
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.LocalExtraColors
import dev.conclave.client.logic.Format
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Routine
import dev.conclave.client.model.RoutineInput
import dev.conclave.client.model.RoutineRun
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class RoutinesViewModel(hub: HubRepository) : HubViewModel(hub) {
    val routines = MutableStateFlow<List<Routine>>(emptyList())
    val runs = MutableStateFlow<Map<String, List<RoutineRun>>>(emptyMap())
    val refreshing = MutableStateFlow(false)

    init {
        refresh()
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.RoutineUpdated -> routines.update { list -> list.filterNot { it.id == e.routine.id } + e.routine }
                    is EngineEvent.RoutineDeleted -> routines.update { list -> list.filterNot { it.id == e.routineId } }
                    is EngineEvent.RoutineRunEvent -> runs.update { m ->
                        val list = m[e.run.routineId].orEmpty().filterNot { it.id == e.run.id }
                        m + (e.run.routineId to (listOf(e.run) + list))
                    }
                    else -> Unit
                }
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                routines.value = hub.api { it.routines() }
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                refreshing.value = false
            }
        }
    }

    fun loadRuns(id: String) = action {
        val list = hub.api { it.routineRuns(id) }
        runs.update { it + (id to list) }
    }

    fun setEnabled(r: Routine, enabled: Boolean) = action {
        val updated = hub.api { it.updateRoutine(r.id, RoutineInput(enabled = enabled)) }
        routines.update { list -> list.map { if (it.id == updated.id) updated else it } }
    }

    fun runNow(r: Routine) = action("Started ${r.name}") {
        val run = hub.api { it.runRoutine(r.id) }
        runs.update { m -> m + (r.id to (listOf(run) + m[r.id].orEmpty().filterNot { it.id == run.id })) }
    }
}

@Composable
fun RoutinesScreen(onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: RoutinesViewModel = viewModel { RoutinesViewModel(hub) }
    val routines by vm.routines.collectAsStateWithLifecycle()
    val runs by vm.runs.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)

    Scaffold(
        topBar = {
            TopBar("Routines", onBack = onBack)
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        // a routine card grows into its panel (card to panel)
        CardPanelHost(Modifier.padding(padding).fillMaxSize()) {
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.fillMaxSize()) {
                if (routines.isEmpty()) {
                    LazyColumn(Modifier.fillMaxSize()) {
                        item { EmptyState(Icons.Outlined.Schedule, "No routines", "Scheduled prompts (morning brief, nightly checks) appear here.") }
                    }
                } else {
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(routines.sortedBy { it.name.lowercase() }, key = { it.id }) { r ->
                            PanelCard(
                                key = r.id,
                                label = r.name,
                                shape = CardShape,
                                panel = { close ->
                                    RoutinePanel(
                                        routine = r,
                                        runs = runs[r.id],
                                        onRun = { vm.runNow(r) },
                                        onLoad = { vm.loadRuns(r.id) },
                                        onOpenChat = onOpenChat,
                                        onClose = close,
                                    )
                                },
                            ) {
                                RoutineCard(routine = r, onToggle = { vm.setEnabled(r, it) })
                            }
                        }
                    }
                }
            }
        }
    }
}

private val CardShape = RoundedCornerShape(16.dp)

/** One routine as a card: its name, schedule and switch, when it runs next, and the start of its prompt. */
@Composable
private fun RoutineCard(routine: Routine, onToggle: (Boolean) -> Unit) {
    Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            RoutineHead(routine, onToggle)
            Text(routine.prompt, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun RoutineHead(routine: Routine, onToggle: ((Boolean) -> Unit)?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(routine.name, style = MaterialTheme.typography.titleSmall)
            Text(routine.schedule + (routine.timezone?.let { " ($it)" } ?: ""), style = CodeStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (onToggle != null) Switch(checked = routine.enabled, onCheckedChange = onToggle)
    }
    val meta = buildList {
        routine.nextRunAt?.let { if (routine.enabled) add("next ${Format.relative(it)}") }
        routine.lastRunAt?.let { add("last ${Format.relative(it)}") }
        if (routine.agent.isNotBlank()) add(routine.agent)
    }
    if (meta.isNotEmpty()) Text(meta.joinToString(", "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** The routine in full: the whole prompt, Run now, and its last runs. */
@Composable
private fun RoutinePanel(
    routine: Routine,
    runs: List<RoutineRun>?,
    onRun: () -> Unit,
    onLoad: () -> Unit,
    onOpenChat: (String) -> Unit,
    onClose: () -> Unit,
) {
    LaunchedEffect(routine.id) { if (runs == null) onLoad() }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        RoutineHead(routine, null)
        Text(routine.prompt, style = MaterialTheme.typography.bodyMedium)
        Row(verticalAlignment = Alignment.CenterVertically) {
            FilledTonalButton(onClick = onRun) {
                Icon(Icons.Outlined.PlayArrow, contentDescription = null)
                Spacer(Modifier.width(6.dp))
                Text("Run now")
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onClose) { Text("Close") }
        }
        Text("History", style = MaterialTheme.typography.labelLarge)
        when {
            runs == null -> Text("Loading runs", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            runs.isEmpty() -> Text("No runs yet", style = MaterialTheme.typography.bodySmall)
            else -> runs.take(10).forEach { run -> RunRow(run, onOpenChat) }
        }
    }
}

@Composable
private fun RunRow(run: RoutineRun, onOpenChat: (String) -> Unit) {
    val extra = LocalExtraColors.current
    val (icon, tint) = when (run.status) {
        "ok" -> Icons.Outlined.CheckCircle to extra.success
        "error" -> Icons.Outlined.ErrorOutline to MaterialTheme.colorScheme.error
        "skipped" -> Icons.Outlined.RemoveCircleOutline to MaterialTheme.colorScheme.outline
        else -> Icons.Outlined.Schedule to MaterialTheme.colorScheme.primary
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = run.sessionId != null) { run.sessionId?.let(onOpenChat) }
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = run.status, tint = tint, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("${run.trigger}, ${Format.relative(run.startedAt)}", style = MaterialTheme.typography.bodySmall)
            (run.error ?: run.summary)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
