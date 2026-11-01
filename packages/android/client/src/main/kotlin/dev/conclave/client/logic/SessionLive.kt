package dev.conclave.client.logic

import dev.conclave.client.model.Message
import dev.conclave.client.model.Role
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonPrimitive

/**
 * What a running session turn is doing, for the live line under its last
 * event (docs/design/CHAT-AND-MOTION.md 1.9, the web's MessageList
 * LiveLine): the Knot thinks while nothing streams, and holds with a light
 * running along it while a tool runs or text streams, with the step in
 * words next to it ("Running bun test", "Reading src/auth.ts", "Writing").
 */
sealed class SessionActivity {
    /** The request is out, a tool result just went back, or a thought streams. */
    data class Thinking(val streaming: Boolean) : SessionActivity()

    /** A tool runs. [id] changes when the step changes. */
    data class Tool(val verb: String, val target: String?, val id: String) : SessionActivity()

    data object Writing : SessionActivity()
}

object SessionLive {

    /**
     * The newest running tool wins; then the message that still streams
     * (no stop reason yet) says whether it thinks or writes; otherwise the
     * model is thinking. Looks back over the last few messages only.
     */
    fun activity(messages: List<Message>, running: Set<String>): SessionActivity {
        val recent = messages.takeLast(6).asReversed()
        for (m in recent) {
            for (b in m.content.asReversed()) {
                if (b is ToolUseBlock && b.id in running) {
                    val (verb, target) = step(b)
                    return SessionActivity.Tool(verb, target, b.id)
                }
            }
            if (m.role == Role.ASSISTANT && m.stopReason == null) {
                val last = m.content.lastOrNull { !(it is TextBlock && it.text.isEmpty()) }
                if (last is TextBlock) return SessionActivity.Writing
                if (last is ThinkingBlock) return SessionActivity.Thinking(streaming = true)
            }
        }
        return SessionActivity.Thinking(streaming = false)
    }

    /** The verb and its target for a running tool, as the web says them. */
    fun step(use: ToolUseBlock): Pair<String, String?> {
        val i = use.input
        fun s(key: String) = i.string(key)?.trim()?.lineSequence()?.firstOrNull()?.ifBlank { null }
        val path = s("file_path") ?: s("path") ?: s("notebook_path")
        return when {
            use.name == "WebSearch" -> "Searching the web" to s("query")
            use.name == "WebFetch" -> "Reading" to s("url")?.let { ChatSources.host(it) }
            use.name.startsWith("Memory") -> "Checking memory" to null
            use.name == "TodoWrite" -> "Planning" to null
            use.name == "Bash" -> "Running" to s("command")
            use.name == "Read" || use.name == "NotebookRead" -> "Reading" to path
            use.name in EDITS -> "Editing" to path
            use.name == "Glob" || use.name == "Grep" -> "Searching" to s("pattern")
            use.name == "LS" -> "Searching" to path
            use.name == "Task" -> "Subagent working on" to s("description")
            use.name == "Delegate" -> (if (s("to") == "assistant") "Assistant working on" else "Code working on") to (s("description") ?: s("prompt"))
            use.name == "Browser" -> "Fetching" to (s("url")?.let { ChatSources.host(it) } ?: s("action"))
            use.name.startsWith("mcp__") -> {
                val parts = use.name.removePrefix("mcp__").split("__")
                "Running" to parts.joinToString(" ").ifBlank { use.name }
            }
            use.name == "Skill" -> "Running" to (s("skill") ?: s("name") ?: use.name)
            use.name in MapsCards.TOOLS -> (MapsCards.working(use.name) ?: "Running") to null
            else -> {
                // the tool's name, then the first text it was given
                val first = i.values.firstNotNullOfOrNull { v -> (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.lineSequence()?.firstOrNull()?.trim()?.ifBlank { null } }
                "Running" to (if (first != null) "${use.name} $first" else use.name)
            }
        }
    }

    private val EDITS = setOf("Write", "Edit", "MultiEdit", "NotebookEdit")
}
