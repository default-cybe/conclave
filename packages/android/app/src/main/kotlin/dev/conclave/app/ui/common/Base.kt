package dev.conclave.app.ui.common

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.conclave.app.AppContainer
import dev.conclave.app.data.HubRepository
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.logic.RemoteWords
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import java.io.IOException

/** Process-wide container, provided by MainActivity. */
val LocalAppContainer = staticCompositionLocalOf<AppContainer> { error("AppContainer not provided") }

/** Readable text for an exception. Never includes the token. */
fun errorText(e: Throwable): String = when (e) {
    is ConclaveApiException -> when (e.status) {
        401 -> "The hub rejected this device. Pair again."
        404 -> e.message ?: "Not found"
        // too many failed tries from this address: say how long to wait
        429 -> if (e.retryAfterSeconds != null) RemoteWords.waitText(e.retryAfterSeconds) else e.message ?: RemoteWords.waitText(null)
        // 403 from the network check says what to do; show it as it is
        else -> e.message ?: "Hub error ${e.status}"
    }
    is IOException -> e.message ?: "Network error"
    is kotlinx.serialization.SerializationException -> "Unexpected reply from the hub"
    else -> e.message ?: e.javaClass.simpleName
}

/** Base for screens that call the hub: one-shot messages go to a snackbar. */
abstract class HubViewModel(protected val hub: HubRepository) : ViewModel() {
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    protected fun say(text: String) {
        _messages.tryEmit(text)
    }

    /** Runs [block] and reports failures (and optionally success) as a message. */
    protected fun action(success: String? = null, block: suspend () -> Unit): Job = viewModelScope.launch {
        try {
            block()
            if (success != null) say(success)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            say(errorText(e))
        }
    }
}
