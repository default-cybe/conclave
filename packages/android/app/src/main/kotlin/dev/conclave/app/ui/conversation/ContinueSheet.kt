@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.model.PermissionMode
import dev.conclave.client.model.Session
import dev.conclave.client.model.obj
import dev.conclave.client.model.string
import kotlinx.coroutines.launch

/**
 * Continue as a session (CHAT-AND-MOTION 2.9): the conversation so far moves
 * to Sessions with an agent that can work on a device.
 */
@Composable
fun ContinueSheet(chat: Session, onDismiss: () -> Unit, onDone: (Session) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val agents by hub.agents.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val c = Conclave.colors
    val scope = rememberCoroutineScope()
    val pickable = agents.filter { it.name != "chat" && it.primary != false && it.subagent != true }
    // null until the owner picks: then the hub's default agent, else the first one that can work on a device
    var picked by remember { mutableStateOf<String?>(null) }
    var defaults by remember { mutableStateOf<HubDefaults?>(null) }
    LaunchedEffect(Unit) { defaults = runCatching { hubDefaults(hub) }.getOrNull() ?: HubDefaults() }
    val agent = picked ?: pickable.firstOrNull { it.name == defaults?.agent }?.name ?: pickable.firstOrNull()?.name
    val online = (listOf("local") + devices.filter { it.online }.map { it.id }).distinct()
    var pickedDevice by remember { mutableStateOf<String?>(null) }
    val device = pickedDevice ?: defaults?.device?.takeIf { it in online } ?: "local"
    var cwd by remember { mutableStateOf("~") }
    var pickedMode by remember { mutableStateOf<PermissionMode?>(null) }
    val mode = pickedMode ?: defaults?.mode ?: PermissionMode.DEFAULT
    var keep by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Move to Code", style = ConclaveType.title, color = c.fg)
            Text("The conversation so far moves to Code, with an agent that can work on a device.", style = ConclaveType.body, color = c.fg2)
            PickRow("Agent", agent ?: "No agent can work on a device", pickable.map { it.name }, { it }) { picked = it }
            PickRow(
                "Device",
                devices.firstOrNull { it.id == device }?.name?.ifBlank { null } ?: if (device == "local") "Hub" else device,
                online,
                { id -> devices.firstOrNull { it.id == id }?.name?.ifBlank { null } ?: if (id == "local") "Hub" else id },
            ) { pickedDevice = it }
            Column {
                Text("Folder", style = ConclaveType.meta, color = c.fg3)
                Spacer(Modifier.height(4.dp))
                BasicTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    singleLine = true,
                    textStyle = CodeStyle.copy(color = c.fg),
                    cursorBrush = SolidColor(c.signal),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp).background(c.bgSunk, RoundedCornerShape(5.dp))
                        .border(1.dp, c.rule2, RoundedCornerShape(5.dp)).padding(horizontal = 10.dp, vertical = 10.dp),
                )
            }
            PickRow("Permission mode", permissionLabel(mode), PermissionMode.entries.toList(), ::permissionLabel) { pickedMode = it }
            Row(Modifier.fillMaxWidth().clickable { keep = !keep }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = keep, onCheckedChange = { keep = it })
                Text("Keep this chat in Chats", style = ConclaveType.body, color = c.fg)
            }
            problem?.let { Text(it, style = ConclaveType.meta, color = c.fault) }
            Box(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).background(if (busy) c.rule else c.solid, RoundedCornerShape(5.dp))
                    .clickable(enabled = !busy) {
                        if (agent == null) {
                            problem = "Add an agent that can work on a device in Agents, then try again."
                            return@clickable
                        }
                        busy = true
                        problem = null
                        scope.launch {
                            try {
                                onDone(continueAsSession(hub, chat, agent, device, cwd.trim(), mode, keep))
                            } catch (e: Exception) {
                                problem = errorText(e) + " Check the device is online, then try again."
                            } finally {
                                busy = false
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("Move", style = ConclaveType.button, color = if (busy) c.fg3 else c.solidFg)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** What the hub's config says a new session starts with. */
private data class HubDefaults(val agent: String? = null, val device: String? = null, val mode: PermissionMode? = null)

private suspend fun hubDefaults(hub: dev.conclave.app.data.HubRepository): HubDefaults {
    val cfg = hub.api { it.config() }.config
    val mode = cfg.obj("permissions")?.string("mode")?.let { w -> PermissionMode.entries.firstOrNull { it.wire == w } }
    return HubDefaults(agent = cfg.string("defaultAgent"), device = cfg.string("defaultDevice"), mode = mode)
}

/** A label and its value; a tap opens the choices. */
@Composable
private fun <T> PickRow(label: String, value: String, options: List<T>, optionLabel: (T) -> String, onPick: (T) -> Unit) {
    val c = Conclave.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(enabled = options.isNotEmpty()) { open = true },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = ConclaveType.body, color = c.fg3, modifier = Modifier.width(140.dp))
            Text(value, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o ->
                DropdownMenuItem(text = { Text(optionLabel(o)) }, onClick = {
                    open = false
                    onPick(o)
                })
            }
        }
    }
}
