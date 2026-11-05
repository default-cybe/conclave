package dev.conclave.app.ui.conversation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.model.ChatSettingsPatch

/** The memory setting of a new chat or Code session (core session/chat.ts). */
enum class MemoryMode(val label: String, val detail: String) {
    SAVE("Use and save", "Recall what it knows and save what you tell it"),
    USE("Use only", "Recall what it knows, save nothing"),
    OFF("Off", "No recall, nothing saved"),
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

/** "+" rows for a new chat or Code session: Incognito, then the three memory settings. */
@Composable
fun PrivacyRows(p: Privacy, code: Boolean, onChange: (Privacy) -> Unit) {
    OptionLabel("Privacy")
    SwitchRow("Incognito", if (code) CODE_INCOGNITO_LINE else INCOGNITO_LINE, p.incognito) { onChange(p.toggled()) }
    OptionLabel("Memory")
    MemoryMode.entries.forEach { m -> ChoiceRow(m.label, selected = p.memory == m, detail = m.detail, onClick = { onChange(p.copy(memory = m)) }) }
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
