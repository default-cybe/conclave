package dev.conclave.client.logic

import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import java.util.Locale
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/** A file a ShareFile call handed the owner: what its card shows. The bytes come from the hub by [toolUseId]. */
data class FileCardData(val toolUseId: String, val name: String, val mediaType: String, val size: Long, val title: String? = null)

/*
 * File cards on the phone (packages/web/src/features/files/words.ts, the
 * same words): the card a ShareFile result carries in meta.file, its type
 * and size line, and a safe name for the copy Open writes to the cache.
 */
object FileCards {

    const val TOOL = "ShareFile"

    /** The card a result carries, when it is one the app can draw. A failed call has none. */
    fun of(result: ToolResultBlock?): FileCardData? {
        if (result == null || result.isError) return null
        val f = result.meta?.file ?: return null
        val name = (f["name"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
        val type = (f["mediaType"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
        val size = (f["size"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull ?: return null
        if (result.toolUseId.isBlank()) return null
        val title = (f["title"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }
        return FileCardData(result.toolUseId, name, type, size, title)
    }

    /** The cards of a turn's calls, in order: only a ShareFile call's result is a file card. */
    fun cards(uses: List<ToolUseBlock>, results: Map<String, ToolResultBlock>): List<FileCardData> =
        uses.filter { it.name == TOOL }.mapNotNull { of(results[it.id]) }

    /** "512 B", "14.2 KB", "3.1 MB". */
    fun sizeWords(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", n / 1024.0)
        else -> String.format(Locale.US, "%.1f MB", n / 1024.0 / 1024.0)
    }

    private val KIND = mapOf(
        "application/pdf" to "PDF",
        "image/png" to "PNG image",
        "image/jpeg" to "JPEG image",
        "image/gif" to "GIF image",
        "image/webp" to "WebP image",
        "image/svg+xml" to "SVG image",
        "application/zip" to "ZIP archive",
        "text/csv" to "CSV",
        "text/markdown" to "Markdown",
        "text/plain" to "Text",
        "application/json" to "JSON",
        "text/html" to "HTML",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to "Word document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to "Excel sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" to "PowerPoint deck",
    )

    /** Largest file the card shows inline; bigger ones stay a card only. */
    const val INLINE_MAX = 20L * 1024 * 1024

    /** Raster types the card shows inline (FileCard.tsx). SVG has its own path ([svgDocument]); HTML never renders. */
    fun inlineImage(mediaType: String): Boolean =
        mediaType in setOf("image/png", "image/jpeg", "image/webp", "image/gif")

    /** Largest SVG the card draws inline (words.ts SVG_PREVIEW_MAX); bigger ones stay a card only. */
    const val SVG_MAX = 2L * 1024 * 1024

    /** An SVG the card draws inline, in the locked-down WebView, when it is small enough. */
    fun inlineSvg(c: FileCardData): Boolean = c.mediaType == "image/svg+xml" && c.size <= SVG_MAX

    /** The page's policy: nothing loads but the one data: image, and no script at all. */
    const val SVG_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

    /**
     * The page that draws an SVG: one <img> whose source is the bytes as base64
     * data:image/svg+xml, so the SVG is only ever an image (no script, no loads)
     * and its bytes never become markup. The description is escaped for the alt.
     */
    fun svgDocument(bytes: ByteArray, description: String): String {
        val data = java.util.Base64.getEncoder().encodeToString(bytes)
        return "<!doctype html><html><head><meta charset=\"utf-8\">" +
            "<meta http-equiv=\"Content-Security-Policy\" content=\"$SVG_CSP\">" +
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<style>html,body{margin:0;height:100%;background:transparent}img{display:block;width:100%;height:100%;object-fit:contain}</style>" +
            "</head><body><img alt=\"${escapeAttr(description)}\" src=\"data:image/svg+xml;base64,$data\"></body></html>"
    }

    private fun escapeAttr(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")

    /** "PDF, 14.2 KB". */
    fun facts(c: FileCardData): String = "${KIND[c.mediaType] ?: "File"}, ${sizeWords(c.size)}"

    /** The name the cached copy gets: no folders and no dot files, so it stays inside the cache's shared/ folder. */
    fun cacheName(c: FileCardData): String {
        val n = c.name.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._ -]"), "_").trimStart('.').take(120)
        return n.ifBlank { "file" }
    }

    /** The folder under the cache's shared/ for one card, by its call id, so two files of one name never meet. */
    fun cacheFolder(c: FileCardData): String = c.toolUseId.replace(Regex("[^A-Za-z0-9_-]"), "_").take(128).ifBlank { "file" }
}
