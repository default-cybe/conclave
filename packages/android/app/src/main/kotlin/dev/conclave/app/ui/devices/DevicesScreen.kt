@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package dev.conclave.app.ui.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.EmptyState
import dev.conclave.app.ui.common.HarnessName
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.Pill
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.LocalExtraColors
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.ModelRefs
import dev.conclave.client.model.Device
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class DevicesViewModel(hub: HubRepository) : HubViewModel(hub) {
    val refreshing = MutableStateFlow(false)

    fun refresh() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                hub.devices.value = hub.api { it.devices() }
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                refreshing.value = false
            }
        }
    }
}

/**
 * Devices: the computers that run work for you, and Pair a device, a code
 * for another app or a computer (PairSheet). Owner and members alike: the
 * list and the code are the signed in person's own.
 */
@Composable
fun DevicesScreen(onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: DevicesViewModel = viewModel { DevicesViewModel(hub) }
    val pair: PairViewModel = viewModel { PairViewModel(hub) }
    val devices by hub.devices.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    LaunchedEffect(Unit) { vm.refresh() }
    var pairing by rememberSaveable { mutableStateOf(false) }
    val openPair = { pairing = true }

    Scaffold(
        topBar = {
            TopBar("Devices", onBack = onBack, actions = {
                TextButton(onClick = openPair) { Text("Pair", color = Conclave.colors.fg2) }
            })
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            if (devices.isEmpty()) {
                LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        EmptyState(Icons.Outlined.Computer, "No devices", "Run the Conclave daemon on a PC and pair it to run tools there.") {
                            OutlinedButton(onClick = openPair, colors = outlineButtonColors(), border = outlineButtonBorder()) { Text("Pair a device") }
                        }
                    }
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(devices.sortedWith(compareByDescending<Device> { it.online }.thenBy { it.name.lowercase() }), key = { it.id }) { d ->
                        DeviceCard(d)
                    }
                }
            }
        }
    }
    if (pairing) PairSheet(pair, onDismiss = { pairing = false })
}

@Composable
private fun DeviceCard(d: Device) {
    val extra = LocalExtraColors.current
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Computer, contentDescription = null)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(d.name.ifBlank { d.id }, style = MaterialTheme.typography.titleSmall)
                    val info = d.info
                    val sub = listOfNotNull(info?.hostname, info?.let { "${it.platform} ${it.arch}".trim() }).filter { it.isNotBlank() }.joinToString(", ")
                    if (sub.isNotBlank()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (d.online) {
                    Pill("Online", extra.success)
                } else {
                    Pill(d.lastSeenAt?.let { "Seen ${Format.relative(it)}" } ?: "Offline", MaterialTheme.colorScheme.outline)
                }
            }
            val clis = d.info?.clis.orEmpty()
            if (clis.isNotEmpty()) {
                // Coding agents with their harness mark, other tools as plain words.
                val c = Conclave.colors
                val (agents, tools) = clis.toSortedMap().entries.partition { ModelRefs.cliHarness(it.key) != null }
                if (agents.isNotEmpty()) {
                    Text("Coding agents", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        agents.forEach { (name, version) ->
                            HarnessName(
                                ModelRefs.cliHarness(name),
                                size = 14.dp,
                                style = ConclaveType.body,
                                color = c.fg,
                                suffix = if (version.isBlank() || version == "unknown") "" else " $version",
                            )
                        }
                    }
                }
                if (tools.isNotEmpty()) {
                    Text("Tools", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        tools.joinToString(", ") { (name, version) -> if (version.isBlank() || version == "unknown") name else "$name $version" },
                        style = ConclaveType.body,
                        color = c.fg2,
                    )
                }
            }
            val caps = d.info?.capabilities.orEmpty()
            if (caps.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    caps.forEach { Pill(it, MaterialTheme.colorScheme.tertiary) }
                }
            }
            if (d.roots.isNotEmpty()) {
                Text("Allowed folders", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                d.roots.forEach { Text(it, style = CodeStyle) }
            }
        }
    }
}
