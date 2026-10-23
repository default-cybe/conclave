package dev.conclave.app.ui.chat

import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.ModelPickerSheet
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.string
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** Separate from reply retry: no rewind, no resubmitted prompt, no completed tool replay. */
@Composable
fun RetryProvider(session: Session?, messages: List<Message>, groups: List<ModelGroup>) {
    val notice = dev.conclave.client.logic.NextModel.providerFailure(messages) ?: return
    if (session?.status != SessionStatus.ERROR || notice.kind != MessageKind.NOTICE ||
        notice.meta?.string("type") != "provider_error" ||
        (notice.meta?.get("canRetry") as? JsonPrimitive)?.booleanOrNull != true) return
    val hub = LocalAppContainer.current.hub
    val scope = rememberCoroutineScope()
    var picking by remember(notice.id) { mutableStateOf(false) }
    var busy by remember(notice.id) { mutableStateOf(false) }
    var error by remember(notice.id) { mutableStateOf<String?>(null) }
    TextButton(enabled = !busy, onClick = { picking = true }) {
        Text(if (busy) "Retrying" else "Retry with another model")
    }
    error?.let { Text(it) }
    if (picking) ModelPickerSheet(
        title = "Retry with another model",
        groups = groups.filter { it.type != "acp" && it.configured },
        current = session.model,
        onDismiss = { picking = false },
        onPick = { model ->
            if (!busy) {
                busy = true
                picking = false
                scope.launch {
                    try {
                        hub.api { it.retryProvider(session.id, notice.id, model) }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        busy = false
                        error = e.message ?: "Retry failed. Nothing was rerun."
                    }
                }
            }
        },
    )
}
