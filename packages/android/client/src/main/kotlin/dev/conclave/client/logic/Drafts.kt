package dev.conclave.client.logic

import dev.conclave.client.ConclaveJson
import dev.conclave.client.model.Attachment
import kotlinx.serialization.builtins.ListSerializer
import java.io.File

/**
 * A chat's unsent composer text and files, kept on disk per session so they
 * survive Android closing the app, like the web's IndexedDB draft. Text and
 * files are separate files, so typing never rewrites the files. Saving an
 * empty text or no files removes that file; every write goes through a temp
 * file and a rename, so a kill mid-write keeps the last whole draft.
 */
class DraftStore(private val dir: File) {
    private val list = ListSerializer(Attachment.serializer())

    /**
     * Goes up at every sign out. A save made with an older one is refused,
     * so a screen closing after sign out cannot write its draft back.
     */
    @Volatile
    var generation = 0
        private set

    fun text(sessionId: String): String = read(sessionId, "txt") ?: ""

    fun files(sessionId: String): List<Attachment> =
        read(sessionId, "files")?.let { runCatching { ConclaveJson.decodeFromString(list, it) }.getOrNull() } ?: emptyList()

    fun saveText(sessionId: String, text: String, gen: Int = generation) = write(sessionId, "txt", text.ifBlank { null }, gen)

    fun saveFiles(sessionId: String, files: List<Attachment>, gen: Int = generation) =
        write(sessionId, "files", if (files.isEmpty()) null else ConclaveJson.encodeToString(list, files), gen)

    /** The chat was deleted. */
    fun clear(sessionId: String) {
        write(sessionId, "txt", null, generation)
        write(sessionId, "files", null, generation)
    }

    /** Sign out: no draft outlives the account. */
    @Synchronized
    fun clearAll() {
        generation++
        dir.deleteRecursively()
    }

    // session ids are the hub's; anything else in one cannot leave the folder
    private fun file(sessionId: String, ext: String) = File(dir, sessionId.replace(Regex("[^A-Za-z0-9_-]"), "_") + "." + ext)

    private fun read(sessionId: String, ext: String): String? =
        file(sessionId, ext).takeIf { it.isFile }?.let { runCatching { it.readText() }.getOrNull() }

    @Synchronized
    private fun write(sessionId: String, ext: String, body: String?, gen: Int) {
        if (gen != generation) return
        val f = file(sessionId, ext)
        if (body == null) {
            f.delete()
            return
        }
        dir.mkdirs()
        val tmp = File(dir, f.name + ".tmp")
        tmp.writeText(body)
        if (!tmp.renameTo(f)) {
            f.delete()
            if (!tmp.renameTo(f)) {
                tmp.delete()
                throw java.io.IOException("could not save the draft")
            }
        }
    }
}
