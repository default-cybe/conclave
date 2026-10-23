package dev.conclave.app.update

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.update.UpdatePrompt
import kotlinx.coroutines.launch

/**
 * The app's own update at app start (client UpdatePrompt): "Conclave X.Y.Z
 * is ready", a short what's new line when the release says one, Update now,
 * Skip this version, and Don't show at startup. It asks once per start;
 * closed without a choice, it asks again at the next start. Skip hides the
 * version until a newer one. Don't show turns the dialog off: the update
 * then shows as a dot on the side panel's account row and in Settings,
 * About, where a switch turns the dialog on again.
 */
@Composable
fun StartupUpdate() {
    val container = LocalAppContainer.current
    val state by container.updates.state.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    // closed once since the app started: not again until the next start
    var shown by rememberSaveable { mutableStateOf(false) }
    var dontShow by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val s = settings ?: return
    val u = state as? UpdateState.Available ?: return
    if (!UpdatePrompt.showDialog(u.version, s.updateSkipped, s.updateAtStartup, shown)) return
    val c = Conclave.colors
    val whatsNew = remember(u.notes) { UpdatePrompt.whatsNew(u.notes) }

    // every way out keeps the box's choice
    fun close(skip: Boolean = false) {
        shown = true
        val off = dontShow
        scope.launch {
            if (skip) container.settings.setUpdateSkipped(u.version)
            if (off) container.settings.setUpdateAtStartup(false)
        }
    }

    AlertDialog(
        onDismissRequest = { close() },
        title = { Text(UpdatePrompt.title(u.version)) },
        text = {
            Column {
                if (whatsNew != null) {
                    Text(whatsNew, style = ConclaveType.body, color = c.fg2)
                    Spacer(Modifier.height(12.dp))
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .toggleable(value = dontShow, role = Role.Checkbox, onValueChange = { dontShow = it }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // the row toggles it, so the box itself takes no taps of its own
                    Checkbox(checked = dontShow, onCheckedChange = null)
                    Spacer(Modifier.width(12.dp))
                    Text("Don't show at startup", style = ConclaveType.body, color = c.fg)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                close()
                container.updates.install(u.version, u.apk)
            }) { Text("Update now") }
        },
        dismissButton = {
            TextButton(onClick = { close(skip = true) }) { Text("Skip this version") }
        },
    )
}
