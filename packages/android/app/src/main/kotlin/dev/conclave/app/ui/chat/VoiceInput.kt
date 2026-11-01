package dev.conclave.app.ui.chat

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext

/** Wraps [SpeechRecognizer]: partial results stream into [onText], [onFinal] gets the result. */
class VoiceInput(
    private val context: Context,
    private val onText: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    val listening: MutableState<Boolean> = mutableStateOf(false)
    private var recognizer: SpeechRecognizer? = null

    val available: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)

    fun start() {
        if (listening.value) return
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                listening.value = true
            }

            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() {
                listening.value = false
            }

            override fun onError(error: Int) {
                listening.value = false
                if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    onError("Voice input failed (code $error)")
                }
            }

            override fun onResults(results: Bundle?) {
                listening.value = false
                best(results)?.let(onFinal)
            }

            override fun onPartialResults(partialResults: Bundle?) {
                best(partialResults)?.let(onText)
            }

            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }
        listening.value = true
        r.startListening(intent)
    }

    fun stop() {
        recognizer?.stopListening()
        listening.value = false
    }

    fun release() {
        recognizer?.destroy()
        recognizer = null
        listening.value = false
    }

    private fun best(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }
}

@Composable
fun rememberVoiceInput(onText: (String) -> Unit, onFinal: (String) -> Unit, onError: (String) -> Unit): VoiceInput {
    val context = LocalContext.current
    val text by rememberUpdatedState(onText)
    val final by rememberUpdatedState(onFinal)
    val error by rememberUpdatedState(onError)
    val voice = remember { VoiceInput(context, { text(it) }, { final(it) }, { error(it) }) }
    DisposableEffect(voice) {
        onDispose { voice.release() }
    }
    return voice
}
