package dev.conclave.app.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.model.ChatSettings
import dev.conclave.client.model.ChatSettingsPatch

/** The memory setting of a new chat or Code session (core session/chat.ts). */
enum class MemoryMode(val label: String, val detail: String) {
    SAVE("Use and save", "Recall what it knows and save what you tell it"),
    USE("Use only", "Recall what it knows, save nothing"),
    OFF("Off", "No recall, nothing saved"),
}

/** A session's memory setting from its chat switches (web memoryModeOf). */
fun memoryModeOf(chat: ChatSettings?): MemoryMode = when {
    chat?.memory == false -> MemoryMode.OFF
    chat?.memorySave == false -> MemoryMode.USE
    else -> MemoryMode.SAVE
}

/** The chat patch for a session that exists: Use and save sends memorySave true, which core session/chat.ts clears (web memoryPatch). */
fun memoryPatch(m: MemoryMode): ChatSettingsPatch = ChatSettingsPatch(memory = m != MemoryMode.OFF, memorySave = m != MemoryMode.USE)

/** The memory chip's words. */
fun memoryWords(m: MemoryMode): String = when (m) {
    MemoryMode.SAVE -> "Memory"
    MemoryMode.USE -> "Memory, use only"
    MemoryMode.OFF -> "No memory"
}

/** Incognito (core session/incognito.ts) and the memory setting; Incognito on starts memory at "Use only". */
data class Privacy(val incognito: Boolean = false, val memory: MemoryMode = MemoryMode.SAVE) {
    fun toggled(): Privacy = Privacy(!incognito, if (incognito) MemoryMode.SAVE else MemoryMode.USE)

    /** [base] with the memory switches this setting sends. */
    fun chat(base: ChatSettingsPatch): ChatSettingsPatch = when (memory) {
        MemoryMode.SAVE -> base.copy(memory = true)
        MemoryMode.USE -> base.copy(memory = true, memorySave = false)
        MemoryMode.OFF -> base.copy(memory = false)
    }
}

const val INCOGNITO_LINE = "Not kept: no history, search or summaries, deleted when closed. Messages still go to the model provider."
const val CODE_INCOGNITO_LINE = "Only the conversation is not kept: file changes and commands on the device are real and stay."

/**
 * The top bar's Incognito on a new chat or Code session. Off, a plain icon:
 * a tap turns it on and opens its menu. On, the icon is filled in and a tap
 * opens the menu: the line on what is not kept, the memory setting ("Use
 * only" first) and Turn off. Gone while the first message goes.
 */
@Composable
fun IncognitoAction(p: Privacy, code: Boolean, onChange: (Privacy) -> Unit) {
    val c = Conclave.colors
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(
            onClick = {
                if (!p.incognito) onChange(p.toggled())
                open = true
            },
            modifier = Modifier.size(48.dp).semantics { stateDescription = if (p.incognito) "On" else "Off" },
        ) {
            Box(Modifier.size(36.dp).background(if (p.incognito) c.surface2 else c.bg, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.VisibilityOff, contentDescription = "Incognito", tint = if (p.incognito) c.fg else c.fg2, modifier = Modifier.size(22.dp))
            }
        }
        DropdownMenu(expanded = open && p.incognito, onDismissRequest = { open = false }) {
            Text(
                "Incognito. " + if (code) CODE_INCOGNITO_LINE else INCOGNITO_LINE,
                style = ConclaveType.meta,
                color = c.fg3,
                modifier = Modifier.widthIn(max = 280.dp).padding(horizontal = 16.dp, vertical = 8.dp),
            )
            Text("Memory", style = ConclaveType.meta, color = c.fg2, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            MemoryMode.entries.forEach { m ->
                DropdownMenuItem(
                    text = { Text(m.label) },
                    trailingIcon = { if (p.memory == m) Icon(Icons.Outlined.Check, contentDescription = "Selected", tint = c.fg) },
                    onClick = { onChange(p.copy(memory = m)) },
                )
            }
            HorizontalDivider(thickness = 1.dp, color = c.rule)
            DropdownMenuItem(text = { Text("Turn off incognito") }, onClick = {
                open = false
                onChange(p.toggled())
            })
        }
    }
}

/** The mark under the title of an incognito conversation, for as long as it lasts. */
@Composable
fun IncognitoMark(code: Boolean) {
    val c = Conclave.colors
    Box(Modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
        Text(
            "Incognito",
            style = ConclaveType.meta,
            color = c.fg2,
            modifier = Modifier.semantics { contentDescription = "Incognito. " + if (code) CODE_INCOGNITO_LINE else INCOGNITO_LINE },
        )
    }
}
