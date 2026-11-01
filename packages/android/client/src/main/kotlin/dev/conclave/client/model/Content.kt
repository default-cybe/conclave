package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Anthropic-style content blocks, polymorphic on "type".
 * Mirrors ContentBlock in packages/core/src/types.ts.
 * Unknown block types decode to [UnknownBlock] (see ConclaveJson).
 */
@Serializable
sealed class ContentBlock

@Serializable
@SerialName("text")
data class TextBlock(val text: String = "") : ContentBlock()

@Serializable
@SerialName("thinking")
data class ThinkingBlock(
    val thinking: String = "",
    val signature: String? = null,
    /** How long the model thought, in ms ("Thought for 12s"). Set by the hub when the block ends. */
    val durationMs: Long? = null,
) : ContentBlock()

@Serializable
@SerialName("redacted_thinking")
data class RedactedThinkingBlock(val data: String = "") : ContentBlock()

@Serializable
@SerialName("image")
data class ImageBlock(
    val mediaType: String = "",
    /** base64 without the data: prefix */
    val data: String? = null,
    val url: String? = null,
) : ContentBlock()

@Serializable
@SerialName("document")
data class DocumentBlock(
    val mediaType: String = "",
    val data: String? = null,
    val url: String? = null,
    val title: String? = null,
) : ContentBlock()

@Serializable
@SerialName("tool_use")
data class ToolUseBlock(
    val id: String = "",
    val name: String = "",
    val input: JsonObject = JsonObject(emptyMap()),
    /** Raw JSON streamed by message.delta (kind tool_input) before the block is final. Client side only. */
    @Transient val partialInput: String = "",
) : ContentBlock()

@Serializable
@SerialName("tool_result")
data class ToolResultBlock(
    val toolUseId: String = "",
    /** string or array of text/image blocks */
    val content: JsonElement = JsonPrimitive(""),
    val isError: Boolean = false,
    val meta: ToolResultMeta? = null,
) : ContentBlock() {
    /** Plain text view of [content]. Images become "[image]". */
    val text: String
        get() = when (val c = content) {
            is JsonPrimitive -> c.contentOrNull ?: ""
            is JsonArray -> c.joinToString("\n") { el ->
                val obj = el as? JsonObject
                when ((obj?.get("type") as? JsonPrimitive)?.contentOrNull) {
                    "text" -> (obj?.get("text") as? JsonPrimitive)?.contentOrNull ?: ""
                    "image" -> "[image]"
                    else -> el.toString()
                }
            }
            is JsonObject -> c.toString()
        }
}

@Serializable
data class ToolResultMeta(
    /** Unified diff for edits. */
    val diff: String? = null,
    val path: String? = null,
    val outputId: String? = null,
    val truncated: Boolean? = null,
    val durationMs: Long? = null,
    val exitCode: Int? = null,
    val external: Boolean? = null,
    /** WebSearch: the search provider, the number of results and the results themselves (for citations). */
    val provider: String? = null,
    val count: Int? = null,
    val results: List<SearchResultRef>? = null,
    /** Workflow: the run this call started. */
    val workflowRunId: String? = null,
    /** Task: the subagent's own session, its agent, and whether it goes on in the background. */
    val sessionId: String? = null,
    val agent: String? = null,
    val background: Boolean? = null,
    /** Delegate: where the job ran (to, device, deviceName, folder, readOnly, permissionMode). */
    val delegate: JsonObject? = null,
    /** WebFetch: the page it read. */
    val url: String? = null,
    /** MemorySave: the note it wrote, which Undo deletes. */
    val memoryId: String? = null,
    /** PlaceSearch, PlaceDetails, Directions, MapImage: the card the app draws (Maps.kt). */
    val maps: MapsCardData? = null,
    /** ShareFile: the file it shared (name, mediaType, size, title), read by FileCards.kt; a JsonObject so a bad one never breaks the message. */
    val file: JsonObject? = null,
)

/** One web search result in [ToolResultMeta.results]. */
@Serializable
data class SearchResultRef(
    val title: String = "",
    val url: String = "",
    val date: String? = null,
)

/** Fallback for block types this app does not know yet. Never encoded. */
@Serializable
@SerialName("unknown")
class UnknownBlock : ContentBlock() {
    override fun equals(other: Any?): Boolean = other is UnknownBlock
    override fun hashCode(): Int = 0
    override fun toString(): String = "UnknownBlock"
}

/** Concatenated text of all text blocks. */
fun List<ContentBlock>.plainText(): String =
    filterIsInstance<TextBlock>().joinToString("\n\n") { it.text }.trim()

/** Context the hub adds to a user message for the model (recalled notes): "<system-reminder>...". */
fun ContentBlock.isReminder(): Boolean = this is TextBlock && text.startsWith("<system-reminder>")

/** What the person wrote: the text blocks without the hub's reminders. Edit and Retry send this again. */
fun List<ContentBlock>.visibleText(): String =
    filterIsInstance<TextBlock>().filterNot { it.isReminder() }.joinToString("\n\n") { it.text }.trim()

/** Reads a string field from a tool input object. */
fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** Reads a field from a JSON object if it is itself an object. */
fun JsonObject.obj(key: String): JsonObject? = runCatching { this[key]?.jsonObject }.getOrNull()
