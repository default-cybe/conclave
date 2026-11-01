package dev.conclave.client.logic

import dev.conclave.client.ConnectionState
import dev.conclave.client.model.AlertAction
import dev.conclave.client.model.AlertItem
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunStatus
import dev.conclave.client.model.string
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.JsonObject

/*
 * The phone's places (Home, the Inbox, the hub line): the words and lists
 * the screens show, kept here so they are tested without a device.
 */

/** The hub line: in the side panel and on Settings. */
object HubLine {

    /** "home · online", "home · connecting", "home · offline, retrying". */
    fun text(name: String?, state: ConnectionState, noNetwork: Boolean = false): String {
        val hub = name?.trim()?.ifEmpty { null } ?: "Hub"
        val word = when (state) {
            ConnectionState.OPEN -> "online"
            ConnectionState.CONNECTING -> "connecting"
            ConnectionState.CLOSED -> if (noNetwork) "no network" else "offline, retrying"
        }
        return "$hub · $word"
    }

    /** A host and the online devices, for the hub card on You: "hub.example.net · 3 devices online". */
    fun detail(host: String, online: Int): String {
        val devices = when (online) {
            0 -> "no devices online"
            1 -> "1 device online"
            else -> "$online devices online"
        }
        return if (host.isBlank()) devices else "$host · $devices"
    }
}

/** Inbox: what waits on the owner (approvals and questions), then finished work. */
object Inbox {

    /** The web's filter words over the Inbox, in its order. A phone lists everything (MOBILE-V2 6); a wide screen shows them. */
    enum class Filter(val label: String) { ALL("All"), APPROVALS("Approvals"), QUESTIONS("Questions"), ALERTS("Alerts"), FRIENDS("Friends"), RESULTS("Results") }

    /** The count after a filter word ("Approvals 2"): what waits under it, 0 (none shown) for All and Results. */
    fun count(f: Filter, approvals: Int, questions: Int, alerts: Int = 0, friends: Int = 0): Int = when (f) {
        Filter.APPROVALS -> approvals
        Filter.QUESTIONS -> questions
        Filter.ALERTS -> alerts
        Filter.FRIENDS -> friends
        else -> 0
    }

    /** Which kinds of rows a filter shows: approvals, questions, alerts, friends, and what finished (results). */
    data class Shows(val approvals: Boolean, val questions: Boolean, val alerts: Boolean, val friends: Boolean, val results: Boolean)

    fun shows(f: Filter): Shows = when (f) {
        Filter.ALL -> Shows(approvals = true, questions = true, alerts = true, friends = true, results = true)
        Filter.APPROVALS -> Shows(approvals = true, questions = false, alerts = false, friends = false, results = false)
        Filter.QUESTIONS -> Shows(approvals = false, questions = true, alerts = false, friends = false, results = false)
        Filter.ALERTS -> Shows(approvals = false, questions = false, alerts = true, friends = false, results = false)
        Filter.FRIENDS -> Shows(approvals = false, questions = false, alerts = false, friends = true, results = false)
        Filter.RESULTS -> Shows(approvals = false, questions = false, alerts = false, friends = false, results = true)
    }

    /** What an empty Inbox says, by filter. */
    fun emptyWords(f: Filter): String = when (f) {
        Filter.ALL -> "Nothing waits on you. Approvals and questions from running sessions land here, with alerts about stuck sessions or two chats editing one file, and notes and shares from friends."
        Filter.APPROVALS -> "No approvals waiting."
        Filter.QUESTIONS -> "No questions waiting."
        Filter.ALERTS -> "No alerts. A session that stops making progress, or two chats editing one file, shows up here."
        Filter.FRIENDS -> "Nothing from friends. Their notes, shares and requests land here."
        Filter.RESULTS -> "Nothing finished today yet."
    }

    /**
     * Finished work: agent sessions that came to rest today (done or failed),
     * newest first, since the owner last cleared them. Chats, subagents and
     * archived sessions are left out.
     */
    fun results(sessions: List<Session>, now: Long, zone: ZoneId, clearedAt: Long = 0, limit: Int = 20): List<Session> {
        val dayStart = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
        val from = maxOf(dayStart, clearedAt)
        return sessions
            .filter { !it.isChat && !it.archived && !Delegated.underParent(it) && it.updatedAt > from }
            .filter { it.status == SessionStatus.IDLE || it.status == SessionStatus.ERROR }
            .sortedByDescending { it.updatedAt }
            .take(limit)
    }

    /** A finished session's state, the first word of the line under its title: "Finished" or "Failed". */
    fun resultWord(s: Session): String = if (s.status == SessionStatus.ERROR) "Failed" else "Finished"

    private val RUN = Regex("""^(run|bash)\s*:\s*""", RegexOption.IGNORE_CASE)

    /**
     * An approval card's label and its line: "Wants to run" with the command
     * for a shell call, else "Wants to use Edit" with the hub's summary. The
     * hub's summary of a shell call is the agent's description when it gave
     * one, so the command comes from [input] when it is there.
     */
    fun approvalLines(tool: String, summary: String, input: JsonObject? = null): Pair<String, String> {
        val s = summary.trim()
        if (tool == PULL_REQUEST) return askLine(tool, summary, input) to pullRequestWords(summary, input)
        val command = input?.string("command")?.trim()?.ifEmpty { null }
        if (tool.equals("Bash", ignoreCase = true) || RUN.containsMatchIn(s)) return "Wants to run" to (command ?: s.replace(RUN, "").ifBlank { tool })
        return "Wants to use ${tool.ifBlank { "a tool" }}" to s.ifBlank { tool }
    }

    /**
     * The agent's reason under an approval's line, in curly quotes
     * (“Push fix/login”): the call's description, reason or justification,
     * as the web reads it. None when it only repeats the line.
     */
    fun approvalReason(input: JsonObject, line: String): String? {
        val reason = listOf("description", "reason", "justification").firstNotNullOfOrNull { input.string(it)?.trim()?.ifEmpty { null } } ?: return null
        return if (reason == line.trim()) null else "“$reason”"
    }

    private val EDITS = setOf("Edit", "MultiEdit", "NotebookEdit")

    /** A repo session's push or pull request (docs/DESIGN.md 30): it asks in words, never in a code block. */
    const val PULL_REQUEST = "PullRequest"

    /**
     * What a push or a pull request does, in plain words: "Push
     * fix-login-ab12 to acme/widgets.", "Open a pull request from
     * fix-login-ab12 into main: Fix the login redirect (draft)."
     */
    fun pullRequestWords(summary: String, input: JsonObject?): String {
        val repo = input?.string("repo")
        val branch = input?.string("branch")?.let { RepoWords.branchShort(it) }
        if (repo == null || branch == null) return summary.trim().ifEmpty { "Publish this session's branch on GitHub." }
        if (input.string("action") != "open") return "Push $branch to $repo."
        val title = input.string("title")?.trim()?.ifEmpty { null }
        val draft = (input["draft"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true"
        return "Open a pull request from $branch into ${input.string("base") ?: "the base branch"}" + (title?.let { ": $it" } ?: "") + (if (draft) " (draft)." else ".")
    }

    /** The approval's subject goes in a mono block: a command, a file, a page. A push or a pull request is words. */
    fun approvalMono(tool: String): Boolean = tool != PULL_REQUEST

    /**
     * Whether the prompt offers more than once: "Allow for this chat" and
     * "Always allow". Not when the hub counts them as once ([noAlways]: an
     * untrusted session) or for a push or a pull request, which asks each time.
     */
    fun approvalWider(tool: String, noAlways: Boolean): Boolean = !noAlways && tool != PULL_REQUEST

    private fun pathOf(input: JsonObject?): String? =
        (input?.string("file_path") ?: input?.string("notebook_path"))?.trim()?.ifEmpty { null }

    /** The command a shell approval runs: from its input, else the hub's summary without "Run:". */
    private fun commandOf(summary: String, input: JsonObject?): String =
        input?.string("command")?.trim()?.ifEmpty { null } ?: summary.trim().replace(RUN, "")

    private fun isShell(tool: String, summary: String): Boolean = tool.equals("Bash", ignoreCase = true) || RUN.containsMatchIn(summary.trim())

    /**
     * An approval prompt's title, as a question (MOBILE-V2 5): "Run this
     * command?", "Edit redirect.ts?", "Read caddyserver.com?", "Use Browser?".
     */
    fun approvalTitle(tool: String, summary: String, input: JsonObject? = null): String {
        val file = pathOf(input)?.let { Paths.fileName(it) }
        return when {
            tool == PULL_REQUEST -> if (input?.string("action") == "open") "Open a pull request on ${input.string("repo") ?: "GitHub"}?" else "Push to ${input?.string("repo") ?: "GitHub"}?"
            isShell(tool, summary) -> "Run this command?"
            tool in EDITS -> "Edit ${file ?: "a file"}?"
            tool == "Write" -> "Write ${file ?: "a file"}?"
            tool == "Read" -> "Read ${file ?: "a file"}?"
            tool == "WebFetch" -> "Read ${input?.string("url")?.let { ChatSources.host(it) } ?: "a page"}?"
            tool == "WebSearch" -> "Search the web?"
            else -> "Use ${tool.removePrefix("mcp__").replace("__", " ").ifBlank { "a tool" }}?"
        }
    }

    /**
     * What the prompt shows in its mono block: the whole command, the file
     * as the session names it (relative to [cwd]), the page, or the hub's
     * summary.
     */
    fun approvalSubject(tool: String, summary: String, input: JsonObject? = null, cwd: String? = null): String {
        if (tool == PULL_REQUEST) return pullRequestWords(summary, input)
        if (isShell(tool, summary)) return commandOf(summary, input).ifBlank { tool }
        pathOf(input)?.let { return Paths.pathIn(it, cwd) }
        input?.string("url")?.trim()?.ifEmpty { null }?.let { return it }
        return summary.trim().ifBlank { tool }
    }

    /**
     * An Inbox row's one line for an approval: "Wants to run git push",
     * "Wants to edit redirect.ts", "Wants to use Browser".
     */
    fun askLine(tool: String, summary: String, input: JsonObject? = null): String {
        val file = pathOf(input)?.let { Paths.fileName(it) }
        return when {
            tool == PULL_REQUEST -> if (input?.string("action") == "open") "Wants to open a pull request" else "Wants to push"
            isShell(tool, summary) -> "Wants to run " + ToolLines.shortCommand(commandOf(summary, input)).ifBlank { "a command" }
            tool in EDITS -> "Wants to edit ${file ?: "a file"}"
            tool == "Write" -> "Wants to write ${file ?: "a file"}"
            tool == "Read" -> "Wants to read ${file ?: "a file"}"
            tool == "WebFetch" -> "Wants to read ${input?.string("url")?.let { ChatSources.host(it) } ?: "a page"}"
            else -> "Wants to use ${tool.removePrefix("mcp__").replace("__", " ").ifBlank { "a tool" }}"
        }
    }

    /** An Inbox row's one line for a question: "Asks: Keep the old API route?". */
    fun questionLine(q: QuestionRequest): String {
        val first = q.questions.firstOrNull()?.question?.trim()?.lineSequence()?.firstOrNull()?.trim()
        return if (first.isNullOrEmpty()) "Asks a question" else "Asks: $first"
    }

    /** "6 min": whole minutes, at least 1. */
    fun alertMinutes(ms: Long): String = "${maxOf(1L, ms / 60_000)} min"

    /**
     * An alert's sentence, as on the web: a quiet turn's minutes keep
     * counting ("No progress in 'Fix login' for 6 min"); the rest keep the
     * hub's sentence.
     */
    fun alertText(a: AlertItem, now: Long): String {
        val since = a.since
        if (a.kind == "stuck" && !a.isLoop && since != null && since > 0) {
            val title = a.sessions.firstOrNull { it.id == a.sessionId }?.title?.ifBlank { null } ?: "A session"
            return "No progress in '$title' for ${alertMinutes(now - since)}"
        }
        return a.text
    }

    /**
     * An alert row's one line under the session's title: "'Fix login' is
     * editing redirect.ts too", "No progress for 6 min", "Bash failed the
     * same way 3 times".
     */
    fun alertLine(a: AlertItem, now: Long): String {
        if (a.isConflict) {
            val file = Paths.fileName(a.file ?: a.path ?: "a file")
            val other = a.sessions.firstOrNull { it.id != a.sessionId }
            return if (other != null) "'${other.title}' is editing $file too" else "Another chat is editing $file too"
        }
        if (a.isLoop) return "${a.tool ?: "A tool"} failed the same way ${a.count ?: 3} times"
        val since = a.since
        return if (since != null && since > 0) "No progress for ${alertMinutes(now - since)}" else "No progress"
    }

    /** The answers an alert takes, in order: Dismiss for a file conflict, Stop and Keep waiting for a stuck turn. */
    fun alertActions(a: AlertItem): List<AlertAction> =
        if (a.isConflict) listOf(AlertAction.DISMISS) else listOf(AlertAction.STOP, AlertAction.WAIT)

    /** Parts of a meta line joined with a middle dot, blank ones left out: "Coder · MacBook · Fix login redirect". */
    fun meta(vararg parts: String?): String = parts.mapNotNull { it?.trim()?.ifEmpty { null } }.joinToString(" · ")

    /**
     * Under a session on Home's Working now: "Running · 4m · MacBook",
     * "Waiting for you · MacBook", "Resumes 15:04 · MacBook".
     */
    fun workingLine(s: Session, deviceName: String?, now: Long, clock: (Long) -> String): String {
        val state = when (s.status) {
            SessionStatus.RUNNING -> "Running · " + Format.durationShort(now - s.updatedAt)
            SessionStatus.WAITING_APPROVAL, SessionStatus.WAITING_INPUT -> "Waiting for you"
            SessionStatus.WAITING_RESET -> s.resumeAt?.takeIf { it > 0 }?.let { "Resumes ${clock(it)}" } ?: "Waiting for reset"
            SessionStatus.PAUSED -> "Paused"
            SessionStatus.ERROR -> "Failed"
            SessionStatus.IDLE -> "Done"
        }
        return meta(state, deviceName)
    }

    /**
     * Under a workflow run on Home's Working now, its agents folded in:
     * "Workflow · phase 2 of 2 · MacBook", "Workflow · phase 1 of 3 · 3
     * agents · MacBook", "Paused · phase 2 of 2 · MacBook".
     */
    fun runLine(r: WorkflowRun, deviceName: String?): String {
        val state = when (r.status) {
            WorkflowRunStatus.RUNNING, WorkflowRunStatus.QUEUED -> "Workflow"
            else -> WorkflowWords.runWord(r.status).replaceFirstChar { it.uppercaseChar() }
        }
        val phase = when {
            r.phaseIndex >= 0 && r.phases.isNotEmpty() -> "phase ${r.phaseIndex + 1} of ${r.phases.size}"
            r.status == WorkflowRunStatus.QUEUED -> "queued"
            r.status == WorkflowRunStatus.RUNNING -> "starting"
            else -> null
        }
        val agents = if (r.counts.running > 1) WorkflowWords.agents(r.counts.running) else null
        return meta(state, phase, agents, deviceName)
    }
}
