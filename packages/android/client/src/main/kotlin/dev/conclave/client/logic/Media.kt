package dev.conclave.client.logic

import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.ToolResultBlock
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** How the in-app viewer (MediaViewer.kt) draws a file. */
enum class MediaKind { IMAGE, ANIMATED, SVG, VIDEO, PDF, TEXT }

/*
 * The in-app viewer's choices: which files it can show and how, which of a
 * message's files its pager swipes through, and the pictures a tool's result
 * carries (a browser screenshot, a Read of a PNG) for the transcript's
 * thumbnails. Anything it cannot show keeps "Open with" (ACTION_VIEW).
 */
object Media {

    /** Settings, "Show pictures from tools in the transcript": on until the owner turns it off on this phone. */
    const val TOOL_PICTURES_DEFAULT = true

    /** Most of a text or code file the viewer lays out (one Text); past it, it says so and offers Open with. */
    const val TEXT_MAX = 512L * 1024

    private val TEXT_TYPES = setOf(
        "application/json", "application/xml", "application/javascript", "application/x-javascript",
        "application/x-yaml", "application/yaml", "application/toml", "application/x-sh", "application/sql",
    )

    private val CODE_EXTENSIONS = setOf(
        "txt", "md", "log", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "conf", "cfg", "env",
        "kt", "kts", "java", "py", "ts", "tsx", "js", "jsx", "mjs", "go", "rs", "c", "h", "cpp", "hpp", "cs", "rb",
        "php", "swift", "sh", "bash", "zsh", "sql", "html", "css", "scss", "gradle", "diff", "patch",
    )

    /** How the viewer shows a file of [mediaType] named [name], or null when it cannot (a ZIP, a Word document). */
    fun kind(mediaType: String, name: String): MediaKind? {
        val t = mediaType.substringBefore(';').trim().lowercase(Locale.US)
        val ext = name.substringAfterLast('.', "").lowercase(Locale.US)
        return when {
            t == "image/gif" || t == "image/webp" -> MediaKind.ANIMATED
            t == "image/png" || t == "image/jpeg" -> MediaKind.IMAGE
            t == "image/svg+xml" -> MediaKind.SVG
            t.startsWith("video/") -> MediaKind.VIDEO
            t == "application/pdf" -> MediaKind.PDF
            t.startsWith("text/") || t in TEXT_TYPES -> MediaKind.TEXT
            // a script or source file sent as octet-stream: its extension says it is text
            (t.isEmpty() || t == "application/octet-stream") && ext in CODE_EXTENSIONS -> MediaKind.TEXT
            else -> null
        }
    }

    /** A file card the viewer can show. */
    fun viewable(c: FileCardData): Boolean = kind(c.mediaType, c.name) != null

    /**
     * What the pager swipes through when [tapped] is opened: the viewable
     * files of the same message, in order, and where [tapped] is in them.
     * A tapped file the viewer cannot show is not opened (empty list).
     */
    fun pager(cards: List<FileCardData>, tapped: FileCardData): Pair<List<FileCardData>, Int> {
        if (!viewable(tapped)) return emptyList<FileCardData>() to 0
        val list = cards.filter { viewable(it) }.distinctBy { it.toolUseId to it.image }
        val i = list.indexOfFirst { it.toolUseId == tapped.toolUseId && it.image == tapped.image }
        return if (i < 0) listOf(tapped) to 0 else list to i
    }

    /**
     * The pictures a tool's result carries, in order: the hub's
     * {type:image, mediaType, data} and Anthropic's {type:image, source:
     * {type:base64, media_type, data}} (imported chats). Only ones with data;
     * a failed call has none.
     */
    fun toolImages(result: ToolResultBlock?): List<ImageBlock> {
        val list = (result?.takeUnless { it.isError }?.content as? JsonArray) ?: return emptyList()
        return list.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            if (o.str("type") != "image") return@mapNotNull null
            val src = o["source"] as? JsonObject
            val data = (o.str("data") ?: src?.str("data"))?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val type = o.str("mediaType") ?: src?.str("media_type") ?: src?.str("mediaType") ?: "image/png"
            if (FileCards.extension(type) == null) return@mapNotNull null
            ImageBlock(mediaType = type, data = data)
        }
    }

    /** The thumbnails under a tool's row: its pictures while the setting is on, none when it is off. */
    fun toolPictures(enabled: Boolean, result: ToolResultBlock?): List<ImageBlock> = if (enabled) toolImages(result) else emptyList()

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}
