package dev.conclave.client.logic

import dev.conclave.client.model.DocumentBlock
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.ToolResultBlock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** Where a picture or document a trimmed page left out lives: block [index] of message [messageId], part [part] of a tool result. */
data class BlockRef(val sessionId: String, val messageId: String, val index: Int, val part: Int? = null) {
    val url: String get() = SCHEME + listOfNotNull(sessionId, messageId, index, part).joinToString("/")

    companion object {
        private const val SCHEME = "conclave-block:"

        /** The ref [url] names, or null for any other url (or none). */
        fun of(url: String?): BlockRef? {
            val parts = url?.takeIf { it.startsWith(SCHEME) }?.removePrefix(SCHEME)?.split('/') ?: return null
            if (parts.size !in 3..4) return null
            val index = parts[2].toIntOrNull() ?: return null
            return BlockRef(parts[0], parts[1], index, parts.getOrNull(3)?.toIntOrNull())
        }
    }
}

/**
 * A transcript page read with trim=1 (hub core session/trim.ts): a block over
 * 100 KB comes without its image or document data, listed in meta.trimmed.
 * Each picture or document it cut gets a [BlockRef] url, so the screen
 * fetches that one block (GET .../messages/:id/blocks/:index) only when it
 * shows or is sent again, and a big chat never holds every screenshot's
 * base64 at once. Cut text stays cut.
 */
object Trimmed {

    fun mark(m: Message): Message {
        val cut = (m.meta?.get("trimmed") as? JsonArray)
            ?.mapNotNull { ((it as? JsonObject)?.get("index") as? JsonPrimitive)?.intOrNull }?.toSet()
        if (cut.isNullOrEmpty()) return m
        val sid = m.sessionId
        return m.copy(content = m.content.mapIndexed { i, b ->
            when {
                i !in cut -> b
                b is ImageBlock && b.data == null && b.url == null -> b.copy(url = BlockRef(sid, m.id, i).url)
                b is DocumentBlock && b.data == null && b.url == null -> b.copy(url = BlockRef(sid, m.id, i).url)
                b is ToolResultBlock && b.content is JsonArray -> b.copy(content = JsonArray(b.content.mapIndexed { k, part ->
                    val o = part as? JsonObject
                    if (o != null && (o["type"] as? JsonPrimitive)?.content == "image" && o["data"] == null && o["url"] == null) {
                        JsonObject(o + ("url" to JsonPrimitive(BlockRef(sid, m.id, i, k).url)))
                    } else part
                }))
                else -> b
            }
        })
    }
}
