package dev.conclave.app.ui.common

import dev.conclave.client.logic.DraftStore
import dev.conclave.client.model.Attachment
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.dropWhile
import kotlinx.coroutines.launch
import kotlin.concurrent.thread

/**
 * Keeps a composer's [text] and [files] for [sessionId] in [drafts], so they
 * survive Android closing the app: read back once, then every change is
 * saved (text after a 300 ms pause). Used by the session screen and the Chat
 * tab. [failed] shows why a draft could not be kept.
 */
class ComposerDraft(
    scope: CoroutineScope,
    private val drafts: DraftStore,
    private val sessionId: String,
    private val text: MutableStateFlow<String>,
    private val files: MutableStateFlow<List<Attachment>>,
    private val failed: (String) -> Unit,
) {
    /** True once the saved draft is read, false again when the chat is deleted: nothing writes the disk outside that. */
    @Volatile private var keep = false

    /** The store's sign-in this draft belongs to: after sign out every save is refused. */
    @Volatile private var generation = -1

    init {
        scope.launch(Dispatchers.IO) {
            generation = drafts.generation
            val t = drafts.text(sessionId)
            val f = drafts.files(sessionId)
            // anything typed or attached before the read wins
            text.compareAndSet("", t)
            files.compareAndSet(emptyList(), f)
            keep = true
            // a send clears the box and a failed send puts it back, so both reach the disk from here
            launch { text.dropWhile { it == t }.collectLatest { delay(300); save { drafts.saveText(sessionId, it, generation) } } }
            launch { files.dropWhile { it == f }.collect { save { drafts.saveFiles(sessionId, it, generation) } } }
        }
    }

    /** The chat was deleted: its draft is not written again. */
    fun forget() {
        keep = false
    }

    /** Leaving the chat cancels a text save still waiting out its pause: save it now, off the main thread. */
    fun flush() {
        if (!keep) return
        val t = text.value
        thread(name = "draft-flush") { runCatching { drafts.saveText(sessionId, t, generation) } }
    }

    private fun save(write: () -> Unit) {
        if (!keep) return
        try {
            write()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // Throwable: encoding many big files can run out of memory, which must not crash the app
            failed("Draft not kept: the phone could not store it (too big, or storage is full). Send it before you close the app.")
        }
    }
}
