package dev.conclave.app.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.ModelRefs
import dev.conclave.client.logic.SwitchWords
import dev.conclave.client.model.SwitchEstimate
import kotlinx.coroutines.launch

/**
 * The step a model switch takes in a big chat (docs/DESIGN.md 44, the web's
 * SwitchChoice.tsx): what it costs once and when it pays back, Full history
 * (the default) or Short handover, and Ask once. Short handover is
 * remembered on this phone once picked (AppSettings.switchBrief); Full
 * history forgets it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SwitchSheet(
    model: String,
    estimate: SwitchEstimate,
    onSwitch: (brief: Boolean) -> Unit,
    onAskOnce: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Conclave.colors
    val container = LocalAppContainer.current
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val name = ModelRefs.displayName(model)
    var brief by remember(model, settings?.switchBrief) { mutableStateOf(estimate.brief != null && settings?.switchBrief == true) }
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text("Switch to $name", style = ConclaveType.title, color = c.fg, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            Text(SwitchWords.sizeLine(estimate, name), style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp))
            HowRow("Full history", SwitchWords.priceLine(estimate.full) + ".", selected = !brief) { brief = false }
            estimate.brief?.let { b -> HowRow("Short handover", SwitchWords.priceLine(b) + ". " + SwitchWords.BRIEF_DETAIL, selected = brief) { brief = true } }
            SwitchWords.suggestion(estimate, brief)?.let { Text(it, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = {
                        if (estimate.brief != null) scope.launch { container.settings.setSwitchBrief(brief) }
                        onSwitch(brief && estimate.brief != null)
                    },
                    colors = solidButtonColors(),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("Switch") }
                TextButton(onClick = onAskOnce, modifier = Modifier.heightIn(min = 48.dp)) { Text("Ask once") }
            }
            Text(SwitchWords.askLine(estimate, name), style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp))
        }
    }
}

/** One way to switch: its name, its price line under it, a check on the chosen one. */
@Composable
private fun HowRow(label: String, detail: String, selected: Boolean, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = ConclaveType.rowTitle, color = if (selected) c.fg else c.fg2)
            Text(detail, style = ConclaveType.meta, color = c.fg3)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", modifier = Modifier.size(16.dp), tint = c.fg)
    }
}
