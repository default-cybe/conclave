@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.LocalExtraColors
import dev.conclave.client.logic.Format
import dev.conclave.client.model.StartTaskInput
import dev.conclave.client.model.Task
import dev.conclave.client.model.TaskInput
import dev.conclave.client.model.TaskStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class TasksViewModel(hub: HubRepository) : HubViewModel(hub) {
    val refreshing = MutableStateFlow(false)

    fun refresh() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                hub.tasks.value = hub.api { it.tasks() }
            } catch (e: Exception) {
                say(dev.conclave.app.ui.common.errorText(e))
            } finally {
                refreshing.value = false
            }
        }
    }

    private fun upsert(t: Task) {
        hub.tasks.value = hub.tasks.value.filterNot { it.id == t.id } + t
    }

    fun setStatus(t: Task, status: TaskStatus) = action { upsert(hub.api { it.updateTask(t.id, TaskInput(status = status)) }) }

    fun create(title: String, description: String) = action("Task added") {
        upsert(hub.api { it.createTask(TaskInput(title = title, description = description, status = TaskStatus.INBOX)) })
    }

    fun update(t: Task, title: String, description: String) = action {
        upsert(hub.api { it.updateTask(t.id, TaskInput(title = title, description = description)) })
    }

    fun delete(t: Task) = action("Task deleted") {
        hub.api { it.deleteTask(t.id) }
        hub.tasks.value = hub.tasks.value.filterNot { it.id == t.id }
    }

    fun start(t: Task, agent: String?, onStarted: (String) -> Unit) = action {
        val s = hub.api { it.startTask(t.id, StartTaskInput(agent = agent)) }
        onStarted(s.id)
    }
}

@Composable
fun TasksScreen(onOpenChat: (String) -> Unit, onBack: (() -> Unit)? = null) {
    val hub = LocalAppContainer.current.hub
    val vm: TasksViewModel = viewModel { TasksViewModel(hub) }
    val tasks by hub.tasks.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    LaunchedEffect(Unit) { vm.refresh() }

    var creating by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf<Task?>(null) }
    val grouped = remember(tasks) {
        TaskStatus.entries.associateWith { s -> tasks.filter { it.status == s }.sortedWith(compareByDescending<Task> { it.priority }.thenByDescending { it.updatedAt }) }
    }

    Scaffold(
        topBar = {
            TopBar("Tasks", onBack = onBack)
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { creating = true }) { Icon(Icons.Outlined.Add, contentDescription = "New task") }
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            if (tasks.isEmpty()) {
                LazyColumn(Modifier.fillMaxSize()) {
                    item { EmptyState(Icons.Outlined.TaskAlt, "No tasks", "Capture work here, then start it with an agent.") }
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    grouped.forEach { (status, list) ->
                        if (list.isNotEmpty()) {
                            item(key = "h:" + status.wire) { SectionHeader(status.label, trailing = { Text(list.size.toString(), style = ConclaveType.metaNum, color = Conclave.colors.fg3) }) }
                            items(list, key = { it.id }) { t ->
                                TaskRow(t, onClick = { open = t }, onStatus = { vm.setStatus(t, it) })
                            }
                        }
                    }
                    item { Spacer(Modifier.height(88.dp)) }
                }
            }
        }
    }

    if (creating) {
        TaskEditDialog(
            title = "New task",
            initialTitle = "",
            initialDescription = "",
            onDismiss = { creating = false },
            onSave = { title, desc ->
                vm.create(title, desc)
                creating = false
            },
        )
    }

    open?.let { t ->
        TaskSheet(
            task = tasks.firstOrNull { it.id == t.id } ?: t,
            onDismiss = { open = null },
            onStatus = { vm.setStatus(t, it) },
            onSave = { title, desc -> vm.update(t, title, desc) },
            onDelete = {
                vm.delete(t)
                open = null
            },
            onStart = { agent ->
                vm.start(t, agent) { id ->
                    open = null
                    onOpenChat(id)
                }
            },
        )
    }
}

@Composable
private fun TaskRow(t: Task, onClick: () -> Unit, onStatus: (TaskStatus) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val extra = LocalExtraColors.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val pColor = when (t.priority) {
            3 -> MaterialTheme.colorScheme.error
            2 -> extra.warning
            1 -> MaterialTheme.colorScheme.primary
            else -> MaterialTheme.colorScheme.outline
        }
        Box(Modifier.size(8.dp).clip(CircleShape).background(pColor))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(t.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = listOfNotNull(t.agent, t.project, t.labels.takeIf { it.isNotEmpty() }?.joinToString(", "), Format.relative(t.updatedAt))
                .filter { it.isNotBlank() }
                .joinToString(", ")
            if (sub.isNotBlank()) {
                Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Box {
            TextButton(onClick = { menu = true }) { Text(t.status.label) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                TaskStatus.entries.forEach { s ->
                    DropdownMenuItem(text = { Text(s.label) }, onClick = {
                        menu = false
                        if (s != t.status) onStatus(s)
                    })
                }
            }
        }
    }
}

@Composable
private fun TaskEditDialog(
    title: String,
    initialTitle: String,
    initialDescription: String,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var name by remember { mutableStateOf(initialTitle) }
    var desc by remember { mutableStateOf(initialDescription) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Title") }, singleLine = true)
                OutlinedTextField(value = desc, onValueChange = { desc = it }, label = { Text("Description") }, minLines = 3, maxLines = 8)
            }
        },
        confirmButton = { TextButton(onClick = { onSave(name.trim(), desc.trim()) }, enabled = name.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun TaskSheet(
    task: Task,
    onDismiss: () -> Unit,
    onStatus: (TaskStatus) -> Unit,
    onSave: (String, String) -> Unit,
    onDelete: () -> Unit,
    onStart: (String?) -> Unit,
) {
    val hub = LocalAppContainer.current.hub
    val agents by hub.agents.collectAsStateWithLifecycle()
    var agent by remember(task.id) { mutableStateOf(task.agent) }
    var editing by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(task.title, style = MaterialTheme.typography.titleLarge)
            if (task.description.isNotBlank()) Text(task.description, style = MaterialTheme.typography.bodyMedium)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TaskStatus.entries.forEach { s ->
                    FilterChip(selected = task.status == s, onClick = { onStatus(s) }, label = { Text(s.label) })
                }
            }
            Text("Start with agent", style = MaterialTheme.typography.labelLarge)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = agent == null, onClick = { agent = null }, label = { Text("Default") })
                agents.filter { it.subagent != true || it.primary == true }.forEach { a ->
                    FilterChip(selected = agent == a.name, onClick = { agent = a.name }, label = { Text(a.name) })
                }
            }
            Button(onClick = { onStart(agent) }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.PlayArrow, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Start")
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { editing = true }) { Text("Edit") }
                TextButton(onClick = onDelete) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
    if (editing) {
        TaskEditDialog(
            title = "Edit task",
            initialTitle = task.title,
            initialDescription = task.description,
            onDismiss = { editing = false },
            onSave = { t, d ->
                onSave(t, d)
                editing = false
            },
        )
    }
}
