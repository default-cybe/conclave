package dev.conclave.client.logic

import dev.conclave.client.model.Attachment
import dev.conclave.client.model.Session

/**
 * Files and text another app shares to Conclave (Android ACTION_SEND and
 * ACTION_SEND_MULTIPLE): what is taken, the line for what is not, and the
 * conversations the "Share to" picker offers. Kept here so the rules are
 * tested without a device.
 */
object ShareIn {
    /** Extensions the hub reads (core attachments/limits.ts EXT_TYPES): it fixes the type by them on arrival. */
    private val EXTENSIONS = setOf(
        "pdf", "zip", "md", "markdown", "txt", "log", "csv", "json", "xml", "yaml", "yml", "toml",
        "html", "htm", "css", "js", "ts", "tsx", "py", "sh",
    )

    /** Text-like types outside the text types the hub reads as text. */
    private val TEXT_TYPES = setOf(
        "application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml",
        "application/x-sh", "application/javascript", "application/x-javascript",
    )

    /** The line for a file of a kind the hub cannot read (video, audio, Office documents...). */
    fun unsupported(name: String): String = "$name was not added: Conclave takes pictures, PDFs, text and code files, and zips."

    /** The line for a file that could not be read, with the reason ("report.pdf is larger than 8 MB"). */
    fun unreadable(name: String, reason: String?): String = reason?.takeIf { it.isNotBlank() }
        ?.let { if (it.contains(name)) it else "$name: $it" } ?: "$name could not be read."

    /**
     * The shared URIs in order, each once: the list SEND_MULTIPLE carries,
     * the single SEND stream, then any only in the ClipData (some apps put
     * them only there).
     */
    fun <T> uris(stream: T?, streams: List<T>?, clip: List<T>): List<T> =
        (streams.orEmpty() + listOfNotNull(stream) + clip).distinct()

    /** The shared words: subject and text, each once, blank ones left out. */
    fun text(subject: String?, text: String?): String =
        listOfNotNull(subject, text).map { it.trim() }.filter { it.isNotEmpty() }.distinct().joinToString("\n")

    /**
     * Whether the hub can read a file of [mediaType] named [name], as the
     * web's file picker allows (core ACCEPT_FILES): pictures, PDFs, text and
     * code, and zips. The extension decides when the type says nothing.
     */
    fun supported(mediaType: String?, name: String?): Boolean {
        val t = mediaType.orEmpty().substringBefore(';').trim().lowercase()
        val ext = name.orEmpty().substringAfterLast('.', "").lowercase()
        return t.startsWith("image/") || t.startsWith("text/") || t == "application/pdf" || t in TEXT_TYPES ||
            Attach.isZip(t, name) || ext in EXTENSIONS
    }

    /**
     * [incoming] added to [current] in order, each that fits ([Attach.refusal]);
     * the second value is the line for the first one left out, or null.
     */
    fun merge(current: List<Attachment>, incoming: List<Attachment>): Pair<List<Attachment>, String?> {
        val out = current.toMutableList()
        var refused: String? = null
        for (a in incoming) {
            val why = Attach.refusal(out, a)
            if (why == null) out += a else refused = refused ?: why
        }
        return out to refused
    }

    /** [shared] after what is already in the box ([draft]), on its own line. */
    fun draft(draft: String, shared: String): String = listOf(draft, shared).filter { it.isNotBlank() }.joinToString("\n")

    /**
     * What the picker lists: every chat and session the lists show (not
     * archived, no subagents, no workflow agents), newest activity first;
     * [query] matches the title, the agent or the mode's word.
     */
    fun targets(sessions: List<Session>, query: String = ""): List<Session> {
        val needle = query.trim().lowercase()
        return sessions
            .filter { Panel.shown(it) }
            .filter { s ->
                needle.isEmpty() || Panel.title(s).lowercase().contains(needle) ||
                    s.agent.lowercase().contains(needle) || Start.modeOf(s).label.lowercase().contains(needle)
            }
            .sortedByDescending { it.updatedAt }
    }

    /** The picker's summary of what is being shared: "2 files", "A note", "1 file and a note". */
    fun summary(files: Int, text: String): String {
        val note = text.isNotBlank()
        return when {
            files > 0 && note -> Attach.filesWord(files) + " and a note"
            files > 0 -> Attach.filesWord(files)
            note -> "A note"
            else -> "Nothing to add"
        }
    }
}
