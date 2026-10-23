@file:OptIn(ExperimentalMaterial3Api::class, FlowPreview::class)

package dev.conclave.app.ui.memory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import dev.conclave.app.ui.common.Pill
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.client.logic.Format
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.MemoryEntry
import dev.conclave.client.model.MemoryInput
import dev.conclave.client.model.MemoryKind
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class MemoryViewModel(hub: HubRepository) : HubViewModel(hub) {
    val query = MutableStateFlow("")
    val kind = MutableStateFlow<MemoryKind?>(null)
    val entries = MutableStateFlow<List<MemoryEntry>>(emptyList())
    val loading = MutableStateFlow(false)

    init {
        viewModelScope.launch {
            combine(query.debounce(300), kind) { q, k -> q.trim() to k }.collect { (q, k) -> load(q, k) }
        }
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.MemoryUpdated -> entries.update { list -> list.map { if (it.id == e.entry.id) e.entry else it } }
                    is EngineEvent.MemoryDeleted -> entries.update { list -> list.filterNot { it.id == e.id } }
                    else -> Unit
                }
            }
        }
    }

    private suspend fun load(q: String, k: MemoryKind?) {
        loading.value = true
        try {
            entries.value = hub.api { c ->
                if (q.isNotEmpty()) c.searchMemory(q, 50).filter { k == null || it.kind == k } else c.memories(kind = k, limit = 200)
            }
        } catch (e: Exception) {
            say(errorText(e))
        } finally {
            loading.value = false
        }
    }

    fun save(existing: MemoryEntry?, content: String, tags: List<String>, kind: MemoryKind) = action("Saved") {
        val saved = if (existing == null) {
            hub.api { it.saveMemory(MemoryInput(content = content, kind = kind, tags = tags)) }
        } else {
            hub.api { it.updateMemory(existing.id, MemoryInput(content = content, kind = kind, tags = tags)) }
        }
        entries.update { list -> listOf(saved) + list.filterNot { it.id == saved.id } }
    }

    fun delete(entry: MemoryEntry) = action("Deleted") {
        hub.api { it.deleteMemory(entry.id) }
        entries.update { list -> list.filterNot { it.id == entry.id } }
    }
}

@Composable
fun MemoryScreen(onBack: () -> Unit, onImport: () -> Unit = {}) {
    val hub = LocalAppContainer.current.hub
    val vm: MemoryViewModel = viewModel { MemoryViewModel(hub) }
    val entries by vm.entries.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val kind by vm.kind.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    var editing by remember { mutableStateOf<MemoryEntry?>(null) }
    var creating by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            // past Claude Code, Codex and Gemini CLI chats: import them, learn from them, or both
            TopBar("Memory", onBack = onBack, actions = { TextButton(onClick = onImport) { Text("Import", color = Conclave.colors.fg2) } })
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { creating = true }) { Icon(Icons.Outlined.Add, contentDescription = "Add memory") }
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = query,
                onValueChange = { vm.query.value = it },
                placeholder = { Text("Search memory") },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            )
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = kind == null, onClick = { vm.kind.value = null }, label = { Text("All") })
                MemoryKind.entries.forEach { k ->
                    FilterChip(selected = kind == k, onClick = { vm.kind.value = k }, label = { Text(k.wire) })
                }
            }
            if (entries.isEmpty()) {
                EmptyState(Icons.Outlined.Memory, "No memories", "Facts, procedures and episodes the agents keep across chats.", Modifier.fillMaxSize())
            } else {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(entries, key = { it.id }) { m ->
                        Surface(
                            shape = RoundedCornerShape(14.dp),
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier.fillMaxWidth().clickable { editing = m },
                        ) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(m.content, style = MaterialTheme.typography.bodyMedium, maxLines = 4, overflow = TextOverflow.Ellipsis)
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Pill(m.kind.wire, MaterialTheme.colorScheme.primary)
                                    Pill(m.scope.wire + (m.scopeKey?.let { ": $it" } ?: ""), MaterialTheme.colorScheme.tertiary)
                                    m.tags.take(3).forEach { Pill("#$it", MaterialTheme.colorScheme.secondary) }
                                }
                                Text(
                                    "updated ${Format.relative(m.updatedAt)}, used ${m.useCount} times",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.outline,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (creating || editing != null) {
        MemoryEditDialog(
            entry = editing,
            onDismiss = {
                creating = false
                editing = null
            },
            onSave = { content, tags, k ->
                vm.save(editing, content, tags, k)
                creating = false
                editing = null
            },
            onDelete = editing?.let { e ->
                {
                    vm.delete(e)
                    editing = null
                }
            },
        )
    }
}

@Composable
private fun MemoryEditDialog(
    entry: MemoryEntry?,
    onDismiss: () -> Unit,
    onSave: (String, List<String>, MemoryKind) -> Unit,
    onDelete: (() -> Unit)?,
) {
    var content by remember(entry?.id) { mutableStateOf(entry?.content.orEmpty()) }
    var tags by remember(entry?.id) { mutableStateOf(entry?.tags?.joinToString(", ").orEmpty()) }
    var kind by remember(entry?.id) { mutableStateOf(entry?.kind ?: MemoryKind.FACT) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (entry == null) "New memory" else "Edit memory") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = content, onValueChange = { content = it }, label = { Text("Content") }, minLines = 4, maxLines = 12)
                OutlinedTextField(value = tags, onValueChange = { tags = it }, label = { Text("Tags (comma separated)") }, singleLine = true)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    MemoryKind.entries.forEach { k -> FilterChip(selected = kind == k, onClick = { kind = k }, label = { Text(k.wire) }) }
                }
                if (onDelete != null) {
                    TextButton(onClick = onDelete) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = content.isNotBlank(),
                onClick = { onSave(content.trim(), tags.split(',').map { it.trim() }.filter { it.isNotEmpty() }, kind) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
