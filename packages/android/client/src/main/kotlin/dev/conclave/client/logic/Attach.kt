package dev.conclave.client.logic

import dev.conclave.client.model.Attachment

/**
 * What one message may carry, the same as the web app and the hub (core
 * attachments/limits.ts, docs/design/CHAT-AND-MOTION.md 2.5): any number of
 * files of any type, together less than the hub reads in one request (the
 * app sends them inline). The hub decides what the model reads and saves the
 * rest in the session's folder.
 */
object Attach {
    /** The files of one message together, before base64: the hub reads a 64 MB body at most. */
    const val MAX_TOTAL_BYTES = 45L * 1024 * 1024

    /** The line for a file past [MAX_TOTAL_BYTES]. */
    const val TOO_LARGE = "Files in one message come to 45 MB at most. Send the rest in another message."

    /** Media types a zip comes as (Windows says x-zip-compressed). */
    val ZIP_TYPES = listOf("application/zip", "application/x-zip-compressed", "application/x-zip", "multipart/x-zip")

    /** What the Files picker offers: any file. */
    val PICKER_TYPES = arrayOf("*/*")

    /** A zip, by its media type, or by its name when the type says nothing. */
    fun isZip(mediaType: String?, name: String?): Boolean {
        val t = mediaType.orEmpty().lowercase()
        if (t in ZIP_TYPES) return true
        return (t.isEmpty() || t == "application/octet-stream") && name.orEmpty().lowercase().endsWith(".zip")
    }

    /** The type to send: a zip some app handed over as octet-stream goes as application/zip. */
    fun mediaTypeOf(type: String?, name: String?): String = when {
        isZip(type, name) && type.orEmpty() !in ZIP_TYPES -> "application/zip"
        type.isNullOrBlank() -> "application/octet-stream"
        else -> type
    }

    /** A pasted or keyboard-sent item the composer takes as a file: any picture, a keyboard GIF too. Text stays text. */
    fun isPastedImage(mediaType: String?): Boolean = mediaType.orEmpty().trim().lowercase().startsWith("image/")

    /** A file's size from its base64 (what the composer holds). */
    fun sizeOf(a: Attachment): Long = (a.data?.length ?: 0) * 3L / 4L

    /** Why [next] cannot join [current] ([TOO_LARGE]), or null when it can. */
    fun refusal(current: List<Attachment>, next: Attachment): String? =
        if (current.sumOf { sizeOf(it) } + sizeOf(next) > MAX_TOTAL_BYTES) TOO_LARGE else null

    /** The hub's 409 when a send would lose a file it could not read (core attachments/prepare.ts ATTACHMENT_LOST). */
    const val LOST = "Attachment not included: "

    /** The words to ask "Send without it?" with, when [error] is that 409; null for any other error. */
    fun lostWords(error: String): String? = if (error.startsWith(LOST)) error.removePrefix(LOST) else null

    /** "7 files", "1 file": the count the attachment row shows once it scrolls. */
    fun filesWord(n: Int): String = if (n == 1) "1 file" else "$n files"
}
