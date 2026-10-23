package dev.conclave.client.logic

import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One line of a unified diff, classified for coloring. */
data class DiffLine(val kind: Kind, val text: String) {
    enum class Kind { ADD, DEL, HUNK, META, CONTEXT }
}

object Diffs {

    fun parse(diff: String): List<DiffLine> = diff.lines().let { lines ->
        // Drop one trailing empty line from a final newline.
        if (lines.isNotEmpty() && lines.last().isEmpty()) lines.dropLast(1) else lines
    }.map { line ->
        val kind = when {
            line.startsWith("+++") || line.startsWith("---") -> DiffLine.Kind.META
            line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") -> DiffLine.Kind.META
            line.startsWith("@@") -> DiffLine.Kind.HUNK
            line.startsWith("+") -> DiffLine.Kind.ADD
            line.startsWith("-") -> DiffLine.Kind.DEL
            else -> DiffLine.Kind.CONTEXT
        }
        DiffLine(kind, line)
    }

    /**
     * Diff to show for an Edit/Write/MultiEdit call: the hub's unified diff when
     * the result carries one, else a simple one built from the tool input.
     */
    fun forTool(use: ToolUseBlock, result: ToolResultBlock?): List<DiffLine>? {
        result?.meta?.diff?.takeIf { it.isNotBlank() }?.let { return parse(it) }
        val input = use.input
        return when (use.name) {
            "Edit" -> {
                val old = input.string("old_string") ?: return null
                val new = input.string("new_string") ?: return null
                simple(old, new)
            }
            "MultiEdit" -> {
                val edits = input["edits"] as? JsonArray ?: return null
                edits.mapNotNull { it as? JsonObject }.flatMapIndexed { i, e ->
                    val head = listOf(DiffLine(DiffLine.Kind.HUNK, "@@ edit ${i + 1} @@"))
                    head + simple(e.string("old_string") ?: "", e.string("new_string") ?: "")
                }
            }
            "Write" -> {
                val content = input.string("content") ?: return null
                content.lines().map { DiffLine(DiffLine.Kind.ADD, "+$it") }
            }
            else -> null
        }
    }

    private fun simple(old: String, new: String): List<DiffLine> =
        old.lines().filter { old.isNotEmpty() }.map { DiffLine(DiffLine.Kind.DEL, "-$it") } +
            new.lines().filter { new.isNotEmpty() }.map { DiffLine(DiffLine.Kind.ADD, "+$it") }

    fun isEditTool(name: String): Boolean = name == "Edit" || name == "Write" || name == "MultiEdit" || name == "NotebookEdit"
}

object ToolSummary {

    /**
     * A file tool's verb and its file as the session shows it: ("Read",
     * "src/auth/redirect.ts"), relative to [cwd] when the file is inside it
     * (Paths.pathIn). Null for other tools.
     */
    fun file(name: String, input: JsonObject, cwd: String? = null): Pair<String, String>? {
        val verb = when (name) {
            "Read" -> "Read"
            "Write" -> "Write"
            "Edit", "MultiEdit", "NotebookEdit" -> "Edit"
            else -> return null
        }
        val path = input.string(if (name == "NotebookEdit") "notebook_path" else "file_path")?.trim()?.lineSequence()?.firstOrNull()?.ifEmpty { null } ?: return null
        return verb to Paths.pathIn(path, cwd)
    }

    /** One readable line for a tool call card. With [cwd], a file reads relative to the session's folder. */
    fun of(name: String, input: JsonObject, cwd: String? = null): String {
        fun s(key: String) = input.string(key)?.trim()?.lineSequence()?.firstOrNull()
        file(name, input, cwd)?.let { (verb, path) -> return "$verb $path" }
        val detail = when (name) {
            "Bash" -> s("command")?.let { "Run: $it" }
            "Glob" -> s("pattern")?.let { "Find $it" }
            "Grep" -> s("pattern")?.let { "Search \"$it\"" }
            "WebFetch" -> s("url")?.let { "Fetch $it" }
            "WebSearch" -> s("query")?.let { "Web search \"$it\"" }
            "Task" -> s("description")?.let { "Subagent: $it" }
            "Delegate" -> (s("description") ?: s("prompt"))?.let { "${if (s("to") == "assistant") "Assistant" else "Code"}: $it" }
            "TodoWrite" -> "Update todo list"
            "AskUserQuestion" -> "Ask a question"
            "Skill" -> s("skill")?.let { "Use skill $it" }
            else -> null
        }
        if (detail != null) return detail
        val firstString = input.entries.firstOrNull { (_, v) -> v is JsonPrimitive && v.isString }
            ?.let { (it.value as JsonPrimitive).content.lineSequence().firstOrNull() }
        return if (firstString.isNullOrBlank()) name else "$name: $firstString"
    }
}
