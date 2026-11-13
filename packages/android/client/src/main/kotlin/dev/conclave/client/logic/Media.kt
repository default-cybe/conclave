package dev.conclave.client.logic

import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.string
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** How the in-app viewer (MediaViewer.kt) draws a file. */
enum class MediaKind { IMAGE, ANIMATED, SVG, VIDEO, PDF, TEXT }

/**
 * One thumbnail under a row of work (ToolFold.kt): a picture a call returned,
 * its bytes inline in [block], or a picture or video ShareFile handed the
 * owner ([shared]: the viewer fetches it from the hub by [card]'s call id).
 * Both at once: a shared picture a call also returned, drawn from [block] and
 * opened from the hub. [tool] names the call that returned the picture.
 */
data class Thumbnail(val key: String, val card: FileCardData, val block: ImageBlock? = null, val tool: String? = null, val shared: Boolean = false) {
    val caption: String? get() = FileCards.caption(card)
}

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
    const val TEXT_MAX = 64L * 1024

    /** Largest video the viewer plays: it holds the whole file in memory first. A bigger one goes to Open with. */
    const val VIDEO_MAX = 100L * 1024 * 1024

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
    fun viewable(c: FileCardData): Boolean = when (kind(c.mediaType, c.name)) {
        null -> false
        MediaKind.VIDEO -> c.size <= VIDEO_MAX
        else -> true
    }

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

    /**
     * A shared file that shows as a thumbnail, not a card: a PNG, JPEG, WebP
     * or GIF small enough to fetch whole, or a video the viewer plays. An SVG,
     * PDF, code, a ZIP or a bigger file stays a compact card (FileCards.kt).
     */
    fun thumbnail(c: FileCardData): Boolean = when (kind(c.mediaType, c.name)) {
        MediaKind.IMAGE, MediaKind.ANIMATED -> c.size <= FileCards.INLINE_MAX
        MediaKind.VIDEO -> viewable(c)
        else -> false
    }

    private val PICTURE_EXTENSIONS = setOf("png", "jpg", "jpeg", "webp", "gif")

    /** The picture file a call read or fetched, by the last part of its path or URL ("shot.png"); null when it names none. */
    fun pictureSource(use: ToolUseBlock): String? =
        listOf("file_path", "path", "filePath", "url").firstNotNullOfOrNull { use.input.string(it)?.takeIf { s -> s.isNotBlank() } }
            ?.substringBefore('?')?.substringBefore('#')?.trimEnd('/')?.substringAfterLast('/')
            ?.takeIf { it.substringAfterLast('.', "").lowercase(Locale.US) in PICTURE_EXTENSIONS }

    private fun same(name: String) = name.substringAfterLast('/').trim().lowercase(Locale.US)

    /**
     * The thumbnail rows of a stretch of work, one per group of calls: the
     * group's tool pictures first, then the pictures and videos its ShareFile
     * calls handed the owner. Each file shows once in the stretch, matched by
     * file name (or a URL's last part): a shared picture a call also returned
     * (a Read of the PNG, then ShareFile) is the tool picture, which takes the
     * shared card's name, size and title and opens the shared file. A shared
     * file whose call is in no group goes in the last row.
     */
    fun rows(groups: List<List<ToolUseBlock>>, results: Map<String, ToolResultBlock>, enabled: Boolean): List<List<Thumbnail>> {
        val shared = FileCards.cards(groups.flatten(), results).filter { thumbnail(it) }.distinctBy { same(it.name) }
        val byName = shared.associateBy { same(it.name) }
        val shown = mutableSetOf<String>()
        val rows = groups.map { uses ->
            uses.flatMap { u ->
                val src = pictureSource(u)
                toolPictures(enabled, results[u.id]).mapIndexedNotNull { i, b ->
                    // only the first picture of a call is the file it names
                    val name = src?.takeIf { i == 0 }
                    if (name != null && !shown.add(same(name))) return@mapIndexedNotNull null
                    val match = name?.let { byName[same(it)] }
                    if (match != null) {
                        Thumbnail("${u.id}:$i", match, b, u.name, shared = true)
                    } else {
                        val card = FileCardData("${u.id}-$i", FileCards.pictureName(name ?: "${u.name}-${i + 1}", b.mediaType), b.mediaType, (b.data?.length ?: 0) * 3L / 4)
                        Thumbnail("${u.id}:$i", card, b, u.name)
                    }
                }
            }.toMutableList()
        }
        if (rows.isEmpty()) return rows
        shared.filterNot { same(it.name) in shown }.forEach { s ->
            val g = groups.indexOfFirst { us -> us.any { it.id == s.toolUseId } }.takeIf { it >= 0 } ?: rows.lastIndex
            rows[g].add(Thumbnail("${s.toolUseId}:", s, shared = true))
        }
        return rows
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}
