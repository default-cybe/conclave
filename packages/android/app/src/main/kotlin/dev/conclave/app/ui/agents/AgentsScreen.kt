@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package dev.conclave.app.ui.agents

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.CodeBox
import dev.conclave.app.ui.common.EmptyState
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.KeyModel
import dev.conclave.app.ui.common.KeyValue
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.ModelName
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.model.CreateSessionInput

class AgentsViewModel(hub: HubRepository) : HubViewModel(hub) {
    fun refresh() = action { hub.agents.value = hub.api { it.agents() } }

    fun chatWith(agent: String, onCreated: (String) -> Unit) = action {
        val s = hub.api { it.createSession(CreateSessionInput(agent = agent)) }
        onCreated(s.id)
    }
}

@Composable
fun AgentsScreen(onBack: () -> Unit, onOpenAgent: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: AgentsViewModel = viewModel { AgentsViewModel(hub) }
    val agents by hub.agents.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    LaunchedEffect(Unit) { vm.refresh() }

    Scaffold(
        topBar = {
            TopBar("Agents", onBack = onBack)
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        if (agents.isEmpty()) {
            EmptyState(Icons.Outlined.SmartToy, "No agents", "Agents are markdown files on the hub (.claude/agents style).", Modifier.padding(padding).fillMaxSize())
        } else {
            val unique = agents.distinctBy { it.name }
            val primary = unique.filter { it.primary != false && it.subagent != true }
            val sub = unique - primary.toSet()
            LazyColumn(Modifier.padding(padding).fillMaxSize()) {
                if (primary.isNotEmpty()) {
                    item { SectionHeader("Agents") }
                    items(primary, key = { "p:" + it.name }) { a -> AgentRow(a, onClick = { onOpenAgent(a.name) }) }
                }
                if (sub.isNotEmpty()) {
                    item { SectionHeader("Subagents") }
                    items(sub, key = { "s:" + it.name }) { a -> AgentRow(a, onClick = { onOpenAgent(a.name) }) }
                }
            }
        }
    }
}

/** Agents are words (spec 11.6): name, description, then the default model with its mark. */
@Composable
private fun AgentRow(a: dev.conclave.client.model.AgentDef, onClick: () -> Unit) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 11.dp)) {
        Text(a.name, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (a.description.isNotBlank()) {
            Spacer(Modifier.height(2.dp))
            Text(a.description, style = ConclaveType.meta, color = c.fg2, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(4.dp))
        if (a.model.isNullOrBlank()) {
            Text("Hub default model", style = ConclaveType.meta, color = c.fg3)
        } else {
            ModelName(a.model, size = 13.dp, style = ConclaveType.meta, color = c.fg3)
        }
    }
}

@Composable
fun AgentDetailScreen(name: String, onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: AgentsViewModel = viewModel { AgentsViewModel(hub) }
    val agents by hub.agents.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    val agent = agents.firstOrNull { it.name == name }

    Scaffold(
        topBar = {
            TopBar(name, onBack = onBack)
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        if (agent == null) {
            EmptyState(Icons.Outlined.SmartToy, "Agent not found", null, Modifier.padding(padding).fillMaxSize())
            return@Scaffold
        }
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (agent.description.isNotBlank()) Text(agent.description, style = MaterialTheme.typography.bodyLarge)
            Button(onClick = { vm.chatWith(agent.name, onOpenChat) }) {
                Icon(Icons.AutoMirrored.Outlined.Chat, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("New chat with ${agent.name}")
            }
            Column {
                KeyModel("Model", agent.model)
                agent.mode?.let { KeyValue("Mode", it.wire) }
                agent.permissionMode?.let { KeyValue("Permissions", it.wire) }
                agent.thinking?.let { KeyValue("Effort", it) }
                agent.memory?.let { KeyValue("Memory", it) }
                agent.device?.let { KeyValue("Device", it) }
                KeyValue("Source", agent.plugin?.let { "plugin $it" } ?: agent.source)
                if (agent.untrusted == true) KeyValue("Input", "Untrusted (no shell, no writes)")
            }
            agent.tools?.takeIf { it.isNotEmpty() }?.let { tools ->
                Text("Tools", style = MaterialTheme.typography.labelLarge)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    tools.forEach { AssistChip(onClick = {}, label = { Text(it) }) }
                }
            }
            agent.skills?.takeIf { it.isNotEmpty() }?.let { skills ->
                Text("Skills", style = MaterialTheme.typography.labelLarge)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    skills.forEach { AssistChip(onClick = {}, label = { Text(it) }) }
                }
            }
            if (agent.prompt.isNotBlank()) {
                Text("System prompt", style = MaterialTheme.typography.labelLarge)
                CodeBox(agent.prompt)
            }
        }
    }
}
