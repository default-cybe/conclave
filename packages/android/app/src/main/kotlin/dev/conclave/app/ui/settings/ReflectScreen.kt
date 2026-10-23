@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.ReflectWords
import dev.conclave.client.model.MemoryEntry
import dev.conclave.client.model.ReflectInfo
import dev.conclave.client.model.ReflectPatch
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * Settings > Reflect (docs/ASSISTANT.md, Nightly reflection), as on the web:
 * the switch (the same setting as the hub's Settings > Assistant), Reflect
 * now, what the last run did, and the notes it keeps, each with Delete. The
 * time and the model are set on the web.
 */
class ReflectViewModel(hub: HubRepository) : HubViewModel(hub) {
    val info = MutableStateFlow<ReflectInfo?>(null)
    val refreshing = MutableStateFlow(false)
    val busy = MutableStateFlow(false)

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                info.value = hub.api { it.reflect() }
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                refreshing.value = false
            }
        }
    }

    fun setEnabled(on: Boolean) = action { info.value = hub.api { it.setReflect(ReflectPatch(enabled = on)) } }

    /** One reflection now; while it runs, read the page again every few seconds until it is done. */
    fun reflectNow() = action {
        busy.value = true
        try {
            val out = hub.api { it.reflectNow() }
            info.value = out.reflect
            val skipped = out.skipped
            if (skipped != null) {
                say("Nothing to reflect on. $skipped.")
                return@action
            }
            say("Reflecting now. The notes show up here when it is done.")
            repeat(40) {
                delay(3_000)
                val next = hub.api { it.reflect() }
                info.value = next
                if (next.last?.status != "running") return@action
            }
        } finally {
            busy.value = false
        }
    }

    fun delete(note: MemoryEntry) = action("Deleted.") {
        hub.api { it.deleteMemory(note.id) }
        info.value = info.value?.let { r -> r.copy(notes = r.notes.filter { it.id != note.id }) }
    }
}

@Composable
fun ReflectScreen(onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: ReflectViewModel = viewModel { ReflectViewModel(hub) }
    val info by vm.info.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    var deleting by remember { mutableStateOf<MemoryEntry?>(null) }
    val c = Conclave.colors

    Scaffold(topBar = { TopBar("Reflect", onBack = onBack) }, snackbarHost = { ToastHost(snackbar) }, containerColor = c.bg) { padding ->
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
                Text(ReflectWords.LINE, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
                val r = info ?: return@Column
                // the switch: the same setting as Settings, Assistant on the hub
                Row(
                    Modifier.fillMaxWidth().clickable { vm.setEnabled(!r.enabled) }.heightIn(min = 56.dp).padding(start = 20.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Reflect each night", style = ConclaveType.body, color = c.fg)
                        Text(ReflectWords.time(r), style = ConclaveType.meta, color = c.fg3)
                    }
                    Spacer(Modifier.width(12.dp))
                    Switch(checked = r.enabled, onCheckedChange = { vm.setEnabled(it) })
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Last run", style = ConclaveType.body, color = c.fg)
                        Text(ReflectWords.lastRun(r.last), style = ConclaveType.meta, color = c.fg3)
                    }
                    Spacer(Modifier.width(12.dp))
                    OutlinedButton(onClick = { vm.reflectNow() }, enabled = !busy && r.last?.status != "running") { Text("Reflect now") }
                }
                Text("${ReflectWords.model(r.model)}. Change the time and the model on the web, in Settings, Reflect.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))

                HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                Text("Notes on how to work with you", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 4.dp))
                if (r.notes.isEmpty()) {
                    Text("No notes yet. After a night with chats, up to 3 show up here.", style = ConclaveType.body, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                }
                r.notes.forEach { n ->
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.Top) {
                        Text(n.content, style = ConclaveType.body, color = c.fg, modifier = Modifier.weight(1f).padding(top = 10.dp))
                        TextButton(onClick = { deleting = n }) { Text("Delete", color = c.fg3) }
                    }
                }
            }
        }
    }

    deleting?.let { n ->
        ConfirmDialog(
            title = "Delete this note?",
            text = "\"${n.content}\" leaves memory. The assistant stops reading it.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                deleting = null
                vm.delete(n)
            },
            onDismiss = { deleting = null },
        )
    }
}
