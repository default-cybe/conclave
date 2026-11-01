package dev.conclave.client.logic

import dev.conclave.client.model.Message
import dev.conclave.client.model.Role
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.string

/*
 * The words of a turn's tool calls. A stretch of thoughts and calls between
 * two pieces of text is one row (Work.kt, CHAT-AND-MOTION 6.3) that sums
 * them up, "Thought for 15s, ran git log" or "Ran 6 commands, read 2
 * files" ([workSummary]), says what it does now while it works ("Running
 * bun test", [working]), and opens to plain rows: the verb, the file or the
 * command, "+2 −0" for an edit ([steps]). The one sentence of MOBILE-V2 5,
 * "Read redirect.ts, edited it, ran bun test" ([sentence]), is left for
 * what a share card says a turn did.
 */

/** One tool call as a row of the open tool line, and how the sentence says it. */
data class ToolStep(
    /** The tool use id. */
    val id: String,
    /** The row's verb, sentence case: "Read", "Edited", "Ran"; while it runs "Running", "Reading". */
    val verb: String,
    /** What the row names: a file name, the whole command, a host, a query. */
    val target: String? = null,
    /** [target] is a file name or a command, so it reads in mono. */
    val code: Boolean = false,
    /** Lines an edit added and removed ("+2 −0"). */
    val added: Int? = null,
    val removed: Int? = null,
    val failed: Boolean = false,
    /** It runs now: the working line says it, the sentence leaves it out. */
    val running: Boolean = false,
    /** The sentence's verb, lower case: "read", "ran", "searched for". */
    val say: String = verb.lowercase(),
    /** What the sentence names after [say]: "redirect.ts", "bun test". */
    val short: String? = target,
    /** The sentence's words when it failed: "bun test failed", "could not edit redirect.ts". */
    val fail: String? = null,
    /** The file's full path, so a next step on the same file says "it". */
    val file: String? = null,
) {
    /** "+2 −0" for an edit, else null. */
    val counts: String? get() = if (added == null && removed == null) null else "+${added ?: 0} −${removed ?: 0}"
}

/** A step of a stretch of work as its summary counts it: a call, or a thought with how long it took (live while it is written). */
sealed class WorkStep {
    data class Call(val use: ToolUseBlock) : WorkStep()
    data class Thought(val ms: Long? = null, val live: Boolean = false) : WorkStep()
}

object ToolLines {

    /** How many steps the sentence names before "and 4 more". */
    const val SHOWN = 3

    /** Every tool call of [messages] (a turn), in order. */
    fun uses(messages: List<Message>): List<ToolUseBlock> =
        messages.filter { it.role == Role.ASSISTANT }.flatMap { m -> m.content.filterIsInstance<ToolUseBlock>() }

    /**
     * The steps of a turn's tool calls. With no result a call runs while the
     * turn is [live]; after that it simply did not finish.
     */
    fun steps(uses: List<ToolUseBlock>, results: Map<String, ToolResultBlock>, cwd: String? = null, live: Boolean = false): List<ToolStep> =
        uses.map { step(it, results[it.id], cwd, live && results[it.id] == null) }

    /** One call as a step. [running]: it has no result yet and the turn goes on. */
    fun step(use: ToolUseBlock, result: ToolResultBlock?, cwd: String? = null, running: Boolean = false): ToolStep {
        val input = use.input
        fun s(key: String) = input.string(key)?.trim()?.lineSequence()?.firstOrNull()?.trim()?.ifEmpty { null }
        val failed = result?.isError == true
        val base = when (use.name) {
            "Read", "NotebookRead" -> fileStep(use, s("file_path") ?: s("notebook_path"), "Read", "read", cwd)
            "Edit", "MultiEdit", "NotebookEdit" -> {
                val (added, removed) = counts(use, result)
                fileStep(use, s("file_path") ?: s("notebook_path"), "Edited", "edited", cwd).copy(added = added, removed = removed)
            }
            "Write" -> {
                val (added, removed) = counts(use, result)
                fileStep(use, s("file_path"), "Wrote", "wrote", cwd).copy(added = added, removed = removed)
            }
            "Bash" -> {
                val command = s("command")
                val short = command?.let { shortCommand(it) }
                ToolStep(use.id, "Ran", command, code = true, say = "ran", short = short, fail = "${short ?: "a command"} failed")
            }
            "Grep" -> ToolStep(use.id, "Searched", s("pattern"), code = true, say = "searched for", fail = "a search failed")
            "Glob" -> ToolStep(use.id, "Listed", s("pattern"), code = true, say = "listed", fail = "a search failed")
            "LS" -> ToolStep(use.id, "Listed", s("path")?.let { Paths.pathIn(it, cwd) }, code = true, say = "listed", fail = "a listing failed")
            "WebSearch" -> ToolStep(use.id, "Searched the web", s("query"), say = "searched the web", short = null, fail = "a web search failed")
            "WebFetch" -> {
                val host = (result?.meta?.url ?: s("url"))?.let { ChatSources.host(it) }
                ToolStep(use.id, "Read", host, say = "read", fail = "could not read ${host ?: "a page"}")
            }
            "Task" -> ToolStep(use.id, "Ran a subagent", s("description"), say = "ran a subagent", short = null, fail = "a subagent failed")
            "Delegate" -> ToolStep(use.id, "Handed on a job", s("description") ?: s("prompt"), say = "handed on a job", short = null, fail = "a job it handed on failed")
            "TodoWrite" -> ToolStep(use.id, "Updated the plan", say = "updated the plan", fail = "the plan did not update")
            "AskUserQuestion" -> ToolStep(use.id, "Asked", s("question"), say = "asked a question", short = null, fail = "a question failed")
            "MemorySearch" -> ToolStep(use.id, "Checked memory", s("query"), say = "checked memory", short = null, fail = "a memory check failed")
            "MemorySave" -> ToolStep(use.id, "Saved to memory", s("content"), say = "saved to memory", short = null, fail = "could not save to memory")
            "MemoryForget" -> ToolStep(use.id, "Retired a note", say = "retired a note", fail = "could not retire a note")
            "Skill" -> ToolStep(use.id, "Used skill", s("skill") ?: s("name"), say = "used skill", fail = "a skill failed")
            "Workflow" -> ToolStep(use.id, "Ran a workflow", s("name") ?: s("workflow"), say = "ran a workflow", short = null, fail = "a workflow failed")
            // maps (MapsCards.kt): the cards under the line say the rest
            "PlaceSearch" -> {
                val q = s("query") ?: s("type")?.replace('_', ' ')
                ToolStep(use.id, "Looked for", q ?: "places", say = "looked for", short = q?.takeIf { it.length <= 24 } ?: "places", fail = "a place search failed")
            }
            "PlaceDetails" -> ToolStep(use.id, "Looked up", "a place", say = "looked up", short = "a place", fail = "a place lookup failed")
            "Directions" -> ToolStep(use.id, "Directions", s("to")?.takeUnless { it.startsWith("ChIJ") || it.startsWith("osm:") }?.let { "to $it" } ?: "to a place", say = "got directions", short = null, fail = "directions failed")
            "MapImage" -> ToolStep(use.id, "Drew", "a map", say = "drew a map", short = null, fail = "a map failed")
            else -> {
                val label = if (use.name.startsWith("mcp__")) use.name.removePrefix("mcp__").split("__").joinToString(" ") else use.name
                val name = label.ifBlank { "a tool" }
                ToolStep(use.id, "Used", name, say = "used", fail = "$name failed")
            }
        }
        if (!running) return base.copy(failed = failed)
        // what runs now says it in the present, as the working line does
        val (verb, _) = SessionLive.step(use)
        return base.copy(verb = verb, running = true)
    }

    private fun fileStep(use: ToolUseBlock, path: String?, verb: String, say: String, cwd: String?): ToolStep {
        val name = path?.let { Paths.fileName(it) }
        return ToolStep(
            use.id,
            verb,
            name,
            code = name != null,
            say = say,
            short = name,
            fail = "could not ${presentOf(say)} ${name ?: "a file"}",
            file = path?.let { Paths.pathIn(it, cwd) },
        )
    }

    private fun presentOf(say: String): String = when (say) {
        "edited" -> "edit"
        "wrote" -> "write"
        else -> say
    }

    /** Lines added and removed by an edit, from the hub's diff or the call's own input. */
    fun counts(use: ToolUseBlock, result: ToolResultBlock?): Pair<Int?, Int?> {
        val diff = Diffs.forTool(use, result) ?: return null to null
        return diff.count { it.kind == DiffLine.Kind.ADD } to diff.count { it.kind == DiffLine.Kind.DEL }
    }

    /**
     * The sentence: the first [shown] steps that finished ("Read
     * redirect.ts, edited it, ran bun test"), then "and 4 more". A step
     * that repeats the one before it is said once. Empty when nothing
     * finished yet.
     */
    fun sentence(steps: List<ToolStep>, shown: Int = SHOWN): String {
        val done = steps.filterNot { it.running }
        val distinct = done.filterIndexed { i, s -> i == 0 || !repeats(done[i - 1], s) }
        if (distinct.isEmpty()) return ""
        val phrases = ArrayList<String>()
        var file: String? = null
        var capital = true
        distinct.take(shown).forEachIndexed { i, s ->
            val (text, verbFirst) = phrase(s, file)
            if (i == 0) capital = verbFirst
            phrases += text
            file = s.file
        }
        val more = distinct.size - shown
        val text = phrases.joinToString(", ") + if (more > 0) " and $more more" else ""
        // a command or a file name keeps its own case at the start
        return if (capital) text.replaceFirstChar { it.uppercaseChar() } else text
    }

    private fun repeats(a: ToolStep, b: ToolStep): Boolean = a.say == b.say && a.short == b.short && a.file == b.file && a.failed == b.failed

    /** A step's words, and whether they start with a verb (so the sentence can start upper case). */
    private fun phrase(s: ToolStep, previousFile: String?): Pair<String, Boolean> = when {
        s.failed -> (s.fail ?: "${s.say} failed").let { it to !(s.short != null && it.startsWith(s.short)) }
        s.file != null && s.file == previousFile -> "${s.say} it" to true
        s.short != null -> "${s.say} ${s.short}" to true
        else -> s.say to true
    }

    // -----------------------------------------------------------------------
    // A stretch of work as one row (Work.kt, CHAT-AND-MOTION 6.3)
    // -----------------------------------------------------------------------

    /** One call as the row of a group names it, lower case: "ran git log", "read auth.ts", "searched for jwt". */
    fun callPhrase(use: ToolUseBlock): String {
        val s = step(use, null)
        return if (s.short != null) "${s.say} ${s.short}" else s.say
    }

    private class Kind(val key: String, val unit: String?, val phrase: (Int) -> String)

    private fun plural(n: Int, one: String, more: String) = "$n ${if (n == 1) one else more}"

    private fun times(n: Int) = if (n == 1) "once" else "$n times"

    private fun again(n: Int) = if (n > 1) " $n times" else ""

    /** How calls of one kind read together: a key, what is counted (a distinct file, or each call), and the phrase. */
    private fun kindOf(use: ToolUseBlock): Kind {
        val i = use.input
        fun s(key: String) = i.string(key)?.trim()?.ifEmpty { null }
        val path = s("file_path") ?: s("path") ?: s("notebook_path")
        return when (Work.name(use.name, use.input)) {
            "Bash" -> Kind("bash", null) { "ran ${plural(it, "command", "commands")}" }
            "Read", "NotebookRead" -> Kind("read", path) { "read ${plural(it, "file", "files")}" }
            "Edit", "MultiEdit", "NotebookEdit" -> Kind("edit", path) { "edited ${plural(it, "file", "files")}" }
            "Write" -> Kind("write", path) { "wrote ${plural(it, "file", "files")}" }
            "Grep", "Glob" -> Kind("search", null) { "searched ${times(it)}" }
            "LS" -> Kind("list", path) { "listed ${plural(it, "folder", "folders")}" }
            "WebSearch" -> Kind("web", null) { "searched the web ${times(it)}" }
            "WebFetch" -> Kind("fetch", s("url")) { "read ${plural(it, "page", "pages")}" }
            "Browser" -> Kind("browse", null) { "used the browser ${times(it)}" }
            "Task" -> Kind("agent", null) { "ran ${plural(it, "subagent", "subagents")}" }
            "Workflow" -> Kind("workflow", null) { "ran ${plural(it, "workflow", "workflows")}" }
            "TodoWrite" -> Kind("plan", null) { "updated the plan" }
            "AskUserQuestion" -> Kind("ask", null) { "asked you" + again(it) }
            "Skill" -> {
                val skill = s("skill") ?: s("name")
                Kind("skill", skill) { n -> if (n == 1 && skill != null) "used the $skill skill" else "used ${plural(n, "skill", "skills")}" }
            }
            "MemorySearch" -> Kind("recall", null) { "checked memory" + again(it) }
            "MemorySave" -> Kind("save", null) { "saved ${plural(it, "note", "notes")}" }
            "MemoryForget" -> Kind("forget", null) { "retired ${plural(it, "note", "notes")}" }
            "PlaceSearch" -> Kind("places", null) { "looked for places" + again(it) }
            "PlaceDetails" -> Kind("place", null) { "looked up ${plural(it, "place", "places")}" }
            "Directions" -> Kind("route", null) { "got directions" + again(it) }
            "MapImage" -> Kind("map", null) { "drew ${plural(it, "map", "maps")}" }
            else -> when {
                use.name.startsWith("browser_") -> Kind("browse", null) { "used the browser ${times(it)}" }
                use.name.startsWith("mcp__") -> {
                    val server = use.name.removePrefix("mcp__").substringBefore("__").ifBlank { "a server" }
                    Kind("mcp:$server", null) { "used $server" + again(it) }
                }
                else -> {
                    val name = use.name.ifBlank { "a tool" }
                    Kind("tool:$name", null) { "used $name" + again(it) }
                }
            }
        }
    }

    /**
     * Calls as counts by kind, in the order each kind first ran: "Ran 6
     * commands, read 2 files, searched 3 times". A file counts once however
     * often it was read or edited; commands and searches count each call.
     * Empty without calls.
     */
    fun groupSummary(uses: List<ToolUseBlock>): String {
        class Row(val phrase: (Int) -> String, val units: LinkedHashSet<String> = LinkedHashSet(), var bare: Int = 0)
        val kinds = LinkedHashMap<String, Row>()
        for (u in uses) {
            val k = kindOf(u)
            val row = kinds.getOrPut(k.key) { Row(k.phrase) }
            if (k.unit != null) row.units += k.unit else row.bare++
        }
        val text = kinds.values.joinToString(", ") { it.phrase(it.units.size + it.bare) }
        return text.replaceFirstChar { it.uppercaseChar() }
    }

    /**
     * A stretch of work as one summary: "Thought for 15s, ran git log",
     * "Ran 6 commands, read 2 files, thought for 40s". The thinking is one
     * phrase with its total time, first when the work starts with a thought,
     * else last. One call is named, several are counted. "thinking" while a
     * thought is written, "reasoned" when no time is known. Empty without steps.
     */
    fun workSummary(steps: List<WorkStep>): String {
        val calls = steps.filterIsInstance<WorkStep.Call>().map { it.use }
        val thoughts = steps.filterIsInstance<WorkStep.Thought>()
        if (thoughts.isEmpty()) return groupSummary(calls)
        val ms = thoughts.sumOf { it.ms ?: 0L }
        val thinking = when {
            thoughts.any { it.live } -> "thinking"
            ms > 0 -> ChatLive.thoughtFor(ms).replaceFirstChar { it.lowercaseChar() }
            else -> "reasoned"
        }
        val doing = when (calls.size) {
            0 -> ""
            1 -> callPhrase(calls[0])
            else -> groupSummary(calls).replaceFirstChar { it.lowercaseChar() }
        }
        val parts = if (steps.first() is WorkStep.Thought) listOf(thinking, doing) else listOf(doing, thinking)
        return parts.filter { it.isNotEmpty() }.joinToString(", ").replaceFirstChar { it.uppercaseChar() }
    }

    /**
     * What a call does while it runs, in a word or two: "Running bun test",
     * "Reading redirect.ts", "Searching the web". Null for a call these
     * words do not know.
     */
    fun workingOrNull(use: ToolUseBlock): String? {
        val i = use.input
        fun s(key: String) = i.string(key)?.trim()?.lineSequence()?.firstOrNull()?.trim()?.ifEmpty { null }
        val file = (s("file_path") ?: s("path") ?: s("notebook_path"))?.let { Paths.fileName(it) }
        val name = Work.name(use.name, use.input)
        return when (name) {
            "Bash" -> s("command")?.let { "Running ${shortCommand(it)}" } ?: "Running a command"
            "Read", "NotebookRead" -> file?.let { "Reading $it" } ?: "Reading"
            "Edit", "MultiEdit", "NotebookEdit", "Write" -> file?.let { "Editing $it" } ?: "Editing"
            "Grep", "Glob" -> s("pattern")?.let { "Searching for ${cut(it, 40)}" } ?: "Searching"
            "LS" -> "Searching"
            "WebSearch" -> "Searching the web"
            "WebFetch" -> s("url")?.let { "Reading ${ChatSources.host(it)}" } ?: "Reading"
            "Task" -> "Subagent working"
            "Workflow" -> "Running ${WorkflowWords.workflowName(use.input)}"
            "TodoWrite" -> "Planning"
            "AskUserQuestion" -> "Asking you"
            "MemorySearch" -> "Checking memory"
            "MemorySave" -> "Saving to memory"
            "Skill" -> (s("skill") ?: s("name"))?.let { "Using the $it skill" }
            else -> when {
                name in MapsCards.TOOLS -> MapsCards.working(name)
                use.name.startsWith("browser_") -> "Reading the page"
                use.name.startsWith("mcp__") -> "Using " + use.name.removePrefix("mcp__").split("__").joinToString(" ")
                else -> null
            }
        }
    }

    /** [workingOrNull], or "Working". */
    fun working(use: ToolUseBlock): String = workingOrNull(use) ?: "Working"

    /** [s] cut to [max] characters with an ellipsis. */
    fun cut(s: String, max: Int): String = if (s.length > max) s.take(max - 1).trimEnd() + "…" else s

    private val SPLIT = Regex("""&&|\|\||;|\|""")
    private val ENV = Regex("""^[A-Za-z_][A-Za-z0-9_]*=.*""")
    private val WORD = Regex("""^[a-z][a-z0-9_:-]*$""")
    private val RUNNERS = setOf("run", "exec", "x")

    /**
     * A command as a sentence names it: the program and what it was asked
     * to do ("git push", "bun test", "npm run build"), past a leading
     * "cd somewhere &&" and variable settings. Flags and paths end it.
     */
    fun shortCommand(command: String): String {
        val line = command.trim().lineSequence().firstOrNull()?.trim().orEmpty()
        val parts = line.split(SPLIT).map { it.trim() }.filter { it.isNotEmpty() }
        val main = parts.firstOrNull { it != "cd" && !it.startsWith("cd ") } ?: parts.firstOrNull() ?: return line
        val words = main.split(Regex("""\s+""")).dropWhile { ENV.matches(it) }
        if (words.isEmpty()) return main
        val out = arrayListOf(words[0])
        for (w in words.drop(1)) {
            if (!WORD.matches(w)) break
            out += w
            if (w !in RUNNERS) break
        }
        return out.joinToString(" ")
    }
}
