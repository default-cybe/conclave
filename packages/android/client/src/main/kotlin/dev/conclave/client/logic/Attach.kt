package dev.conclave.client.logic

import dev.conclave.client.model.Attachment

/**
 * What one message may carry, the same as the web app and the hub (core
 * attachments/limits.ts, docs/design/CHAT-AND-MOTION.md 2.5): 15 files at
 * most, and together less than the hub reads in one request. A zip counts
 * as one file; the hub unpacks it.
 */
object Attach {
    /** Files in one message. */
    const val MAX = 15

    /** The line for a file past [MAX], as the web app and the hub say it. */
    const val TOO_MANY = "Up to 15 files per message. Zip the rest."

    /** The files of one message together, before base64: the hub reads a 64 MB body at most. */
    const val MAX_TOTAL_BYTES = 45L * 1024 * 1024

    /** The line for a file past [MAX_TOTAL_BYTES]. */
    const val TOO_LARGE = "Files in one message come to 45 MB at most. Send the rest in another message."

    /** Media types a zip comes as (Windows says x-zip-compressed). */
    val ZIP_TYPES = listOf("application/zip", "application/x-zip-compressed", "application/x-zip", "multipart/x-zip")

    /** What the Files picker offers: pictures, PDFs, text and code, and zips. */
    val PICKER_TYPES = arrayOf("image/*", "application/pdf", "text/*", "application/json", "application/zip", "application/x-zip-compressed")

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

    /** How many more files fit after [current]. */
    fun room(current: Int): Int = (MAX - current).coerceAtLeast(0)

    /** A file's size from its base64 (what the composer holds). */
    fun sizeOf(a: Attachment): Long = (a.data?.length ?: 0) * 3L / 4L

    /** Why [next] cannot join [current] ([TOO_MANY] or [TOO_LARGE]), or null when it can. */
    fun refusal(current: List<Attachment>, next: Attachment): String? = when {
        current.size >= MAX -> TOO_MANY
        current.sumOf { sizeOf(it) } + sizeOf(next) > MAX_TOTAL_BYTES -> TOO_LARGE
        else -> null
    }

    /** The hub's 409 when a send would lose a file it could not read (core attachments/prepare.ts ATTACHMENT_LOST). */
    const val LOST = "Attachment not included: "

    /** The words to ask "Send without it?" with, when [error] is that 409; null for any other error. */
    fun lostWords(error: String): String? = if (error.startsWith(LOST)) error.removePrefix(LOST) else null

    /** "7 files", "1 file": the count the attachment row shows once it scrolls. */
    fun filesWord(n: Int): String = if (n == 1) "1 file" else "$n files"
}
