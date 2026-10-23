package dev.conclave.client.logic

import dev.conclave.client.model.ChatSettings
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.SearchResultRef
import dev.conclave.client.model.Session
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ModelEffort
import dev.conclave.client.model.ThinkingLevel
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.plainText
import dev.conclave.client.model.string
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/*
 * How a chat reads on the Chat tab (docs/design/CHAT-AND-MOTION.md 2.6).
 * The same rules as packages/web/src/features/conversation/units.ts, so a
 * chat looks the same on the phone and in the browser.
 */

/** One piece of a chat transcript. */
sealed class ChatUnit {
    abstract val key: String

    /** Your message. [queued]: sent while a reply ran; it goes out when that reply ends. */
    data class User(val message: Message, val queued: Boolean = false) : ChatUnit() {
        override val key get() = message.id
    }

    /** Every assistant message and tool result between two of your messages. */
    data class Reply(val messages: List<Message>, val user: Message?, val model: String?) : ChatUnit() {
        override val key get() = messages.first().id

        /** The reply's text, every text block joined. */
        val text: String
            get() = messages.filter { it.role == Role.ASSISTANT }.map { it.content.plainText() }.filter { it.isNotEmpty() }.joinToString("\n\n")

        /** The last assistant message: what Branch and Ask another model point at. */
        val last: Message get() = messages.lastOrNull { it.role == Role.ASSISTANT } ?: messages.last()

        val lastSeq: Long get() = messages.last().seq

        /** Thinking, tool calls and text in order, across the reply's messages. */
        val blocks: List<ContentBlock>
            get() = messages.filter { it.role == Role.ASSISTANT }.flatMap { it.content }
    }

    /** A second opinion. [pending]: nothing follows it yet, so it offers Continue and Dismiss. */
    data class Aside(val message: Message, val pending: Boolean) : ChatUnit() {
        override val key get() = message.id
    }

    data class Notice(val message: Message) : ChatUnit() {
        override val key get() = message.id
    }

    /** "Switched to GPT-5.5." when a reply's model differs from the one before. */
    data class Switch(val model: String, override val key: String) : ChatUnit()
}

object ChatUnits {

    /**
     * @param hide messages to leave out (an edit or retry is replacing them).
     * @param targets aside id to the message it answers, for second opinions
     *   the hub stored without meta.messageId (the app knows which reply it asked about).
     */
    fun build(messages: List<Message>, hide: Set<String> = emptySet(), targets: Map<String, String> = emptyMap()): List<ChatUnit> {
        val units = ArrayList<ChatUnit>()
        var lastModel: String? = null
        var lastUser: Message? = null
        // the reply being built; its list keeps growing while it is the last one
        var cur: ChatUnit.Reply? = null
        var curMessages: ArrayList<Message>? = null
        // messages sent while `cur` was running: they follow it once it ends
        val deferred = ArrayList<Message>()

        fun ended(): Boolean {
            val list = curMessages ?: return true
            val last = list.lastOrNull { it.role == Role.ASSISTANT }
            return last?.stopReason != null && last.stopReason != "tool_use"
        }

        fun flush(queued: Boolean) {
            for (d in deferred) {
                lastUser = d
                units.add(ChatUnit.User(d, queued))
            }
            if (deferred.isNotEmpty()) {
                cur = null
                curMessages = null
            }
            deferred.clear()
        }

        for (m in messages) {
            if (m.id in hide) continue
            if (m.kind == MessageKind.NOTICE || m.kind == MessageKind.SUMMARY) {
                // "Second opinion from ... added." and other confirmations repeat what the page already shows
                if ((m.meta?.get("level") as? JsonPrimitive)?.contentOrNull == "success") continue
                units.add(ChatUnit.Notice(m))
                continue
            }
            if (m.kind == MessageKind.ASIDE) {
                units.add(ChatUnit.Aside(m, pending = true))
                continue
            }
            if (m.role == Role.USER && ChatItems.isToolResultsOnly(m)) {
                curMessages?.add(m)
                continue
            }
            if (m.role == Role.USER) {
                val queuedMeta = (m.meta?.get("whenBusy") as? JsonPrimitive)?.contentOrNull == "queue"
                if (queuedMeta && cur != null && !ended()) {
                    deferred.add(m)
                    continue
                }
                flush(false)
                lastUser = m
                cur = null
                curMessages = null
                units.add(ChatUnit.User(m))
                continue
            }
            val list = curMessages
            if (list != null && (deferred.isEmpty() || !ended())) {
                list.add(m)
                continue
            }
            flush(false)
            val model = m.model
            if (!model.isNullOrBlank() && lastModel != null && model != lastModel) units.add(ChatUnit.Switch(model, "sw:" + m.id))
            if (!model.isNullOrBlank()) lastModel = model
            val fresh = arrayListOf(m)
            val reply = ChatUnit.Reply(fresh, lastUser, model)
            cur = reply
            curMessages = fresh
            units.add(reply)
        }
        flush(!ended())

        // an aside that names its reply sits right under it (after any asides already there)
        fun replyOf(a: ChatUnit.Aside): String? {
            val target = a.message.meta?.string("messageId") ?: targets[a.message.id] ?: return null
            return (units.firstOrNull { it is ChatUnit.Reply && it.messages.any { m -> m.id == target } } as? ChatUnit.Reply)?.key
        }
        val moving = units.filterIsInstance<ChatUnit.Aside>().mapNotNull { a -> replyOf(a)?.let { a to it } }
        if (moving.isNotEmpty()) {
            val gone = moving.map { it.first.key }.toSet()
            units.removeAll { it is ChatUnit.Aside && it.key in gone }
            for ((aside, replyKey) in moving) {
                var to = units.indexOfFirst { it is ChatUnit.Reply && it.key == replyKey } + 1
                while (to < units.size && units[to] is ChatUnit.Aside) to++
                units.add(to, aside)
            }
        }

        // a second opinion offers Continue and Dismiss until something follows it
        var followed = false
        for (k in units.indices.reversed()) {
            val u = units[k]
            if (u is ChatUnit.Aside) units[k] = u.copy(pending = !followed)
            if (u is ChatUnit.User || u is ChatUnit.Reply) followed = true
        }
        // freeze the reply lists so later edits to the builder lists cannot leak out
        return units.map { if (it is ChatUnit.Reply) it.copy(messages = it.messages.toList()) else it }
    }
}

// ---------------------------------------------------------------------------
// Live phase of the reply being written (CHAT-AND-MOTION 1.3, 3.3)
// ---------------------------------------------------------------------------

/**
 * WAITING  sent, nothing back yet: the mark thinks at the reply's first line
 * THINKING a thinking block streams: "Thinking 4s" and the last line of the thought
 * TOOL     a tool runs: its row says so
 * WRITING  text streams: the mark works at the foot of the reply
 * BETWEEN  a step finished and the next has not started: the mark thinks at the foot
 */
enum class LivePhase { WAITING, THINKING, TOOL, WRITING, BETWEEN }

object ChatLive {

    /**
     * The phase of a running reply. A message streams until the hub sends it
     * whole (with a stop reason); a tool runs until its result arrives.
     */
    fun phase(messages: List<Message>, results: Map<String, ToolResultBlock>): LivePhase {
        var lastBlock: ContentBlock? = null
        var lastMsg: Message? = null
        for (m in messages) {
            if (m.role != Role.ASSISTANT) continue
            for (b in m.content) {
                if (b is TextBlock && b.text.isEmpty()) continue
                if (b is ToolUseBlock && results[b.id] == null) return LivePhase.TOOL
                lastBlock = b
                lastMsg = m
            }
        }
        val streaming = lastMsg?.stopReason == null
        return when {
            lastBlock == null -> LivePhase.WAITING
            lastBlock is ThinkingBlock && streaming -> LivePhase.THINKING
            lastBlock is TextBlock && streaming -> LivePhase.WRITING
            else -> LivePhase.BETWEEN
        }
    }

    /**
     * Where the reply being written sits in [units]: the last reply, while the
     * chat runs, nothing you sent came after it (a notice may, and a message
     * queued behind it does not count) and it has not finished. A reply that
     * ended its turn is done even when the chat runs again: that is the next
     * turn starting. -1 when no reply is being written.
     */
    fun liveIndex(units: List<ChatUnit>, running: Boolean): Int {
        if (!running) return -1
        val at = units.indexOfLast { it is ChatUnit.Reply }
        if (at < 0 || at < lastAsk(units)) return -1
        val reply = units[at] as ChatUnit.Reply
        val last = reply.messages.last()
        val finished = last.role == Role.ASSISTANT && last.stopReason != null && last.stopReason != "tool_use"
        return if (finished) -1 else at
    }

    /** A turn started from something you sent and no reply has come yet: the mark thinks on a line of its own. */
    fun awaiting(units: List<ChatUnit>, running: Boolean): Boolean =
        running && lastAsk(units) > units.indexOfLast { it is ChatUnit.Reply }

    private fun lastAsk(units: List<ChatUnit>): Int = units.indexOfLast { it is ChatUnit.User && !it.queued }

    /** The last sentence of a thought, for the one line under "Thinking 4s" (a very short one keeps the one before it). */
    fun lastLine(thinking: String): String {
        val line = thinking.trim().lines().lastOrNull { it.isNotBlank() }?.trim() ?: return ""
        val parts = line.split(Regex("(?<=[.!?])\\s+")).filter { it.isNotBlank() }
        val last = parts.lastOrNull() ?: return ""
        return if (last.length < 24 && parts.size > 1) parts[parts.size - 2] + " " + last else last
    }

    /** "Thought for 12s", "Thought for 1m 12s" (at least 1s). */
    fun thoughtFor(ms: Long): String {
        val s = maxOf(1L, Math.round(ms / 1000.0))
        return "Thought for " + if (s < 60) "${s}s" else "${s / 60}m ${s % 60}s"
    }
}

// ---------------------------------------------------------------------------
// Sources (CHAT-AND-MOTION 2.6)
// ---------------------------------------------------------------------------

data class Source(val n: Int, val url: String, val host: String, val title: String?)

object ChatSources {

    fun host(url: String): String = try {
        (URI(url).host ?: throw IllegalArgumentException()).removePrefix("www.")
    } catch (_: Exception) {
        url.removePrefix("https://").removePrefix("http://").substringBefore('/')
    }

    private fun norm(url: String): String = url.substringBefore('#').trimEnd('/').lowercase().replaceFirst("://www.", "://")

    /** Results of every WebSearch in a reply, and the pages WebFetch read. */
    fun results(messages: List<Message>, results: Map<String, ToolResultBlock>): List<SearchResultRef> {
        val out = ArrayList<SearchResultRef>()
        for (m in messages) for (b in m.content) {
            if (b !is ToolUseBlock) continue
            val r = results[b.id] ?: continue
            if (r.isError) continue
            if (b.name == "WebSearch") r.meta?.results?.let { out.addAll(it) }
            if (b.name == "WebFetch") {
                val url = r.meta?.url ?: b.input.string("url")
                if (!url.isNullOrBlank()) out.add(SearchResultRef(title = host(url), url = url))
            }
        }
        return out
    }

    private val LINK = Regex("""\]\((https?://[^)\s]+)\)|<(https?://[^>\s]+)>""")

    /**
     * The numbered hosts after a reply: its links that match what it searched
     * or read, in the order it cites them; else every result. One per host.
     */
    fun of(text: String, results: List<SearchResultRef>): List<Source> {
        if (results.isEmpty()) return emptyList()
        val byUrl = results.associateBy { norm(it.url) }
        val cited = LINK.findAll(text).mapNotNull { m ->
            val url = m.groupValues[1].ifEmpty { m.groupValues[2] }
            byUrl[norm(url)]
        }.toList()
        val list = cited.ifEmpty { results }
        val seen = HashSet<String>()
        val out = ArrayList<Source>()
        for (r in list) {
            val h = host(r.url)
            if (!seen.add(h)) continue
            out.add(Source(out.size + 1, r.url, h, r.title.ifBlank { null }))
        }
        return out
    }
}

// ---------------------------------------------------------------------------
// Tool rows (CHAT-AND-MOTION 2.6)
// ---------------------------------------------------------------------------

data class Note(val id: String, val text: String)

/**
 * One tool row: the words and what it opens to. [live] while it runs (the
 * verb gets the letter wave), [failed] in red.
 */
data class ToolLine(
    val words: String,
    val detail: String? = null,
    val live: Boolean = false,
    val failed: Boolean = false,
)

object ChatTools {

    private val NOTE = Regex("""\[([^\]\s]+)\]\s*(?:\([^)\n]*\))?\s*\n?([\s\S]*?)(?=\n\s*\[[^\]\s]+\]|$)""")

    /** Notes in a MemorySearch result: "[id] (kind, scope, date)\ntext". */
    fun notes(result: ToolResultBlock?): List<Note> {
        if (result == null || result.isError) return emptyList()
        return NOTE.findAll(result.text).mapNotNull { m ->
            val body = m.groupValues[2].trim()
            if (body.isEmpty()) null else Note(m.groupValues[1], body)
        }.toList()
    }

    /** An old note's text, from a MemorySearch earlier in the same reply. */
    fun findNote(messages: List<Message>, results: Map<String, ToolResultBlock>, id: String?): String? {
        if (id.isNullOrBlank()) return null
        for (m in messages) for (b in m.content) {
            if (b is ToolUseBlock && b.name == "MemorySearch") {
                notes(results[b.id]).firstOrNull { it.id == id }?.let { return it.text }
            }
        }
        return null
    }

    private fun plural(n: Int, one: String, many: String) = if (n == 1) "1 $one" else "$n $many"

    /**
     * The step for the status line while tools run (Steps): the newest
     * running tool, or "Reading 3 pages" when several pages are read at once.
     */
    fun runningStep(running: List<ToolUseBlock>): ToolLine? {
        if (running.isEmpty()) return null
        if (running.size > 1 && running.all { it.name == "WebFetch" }) {
            val hosts = running.mapNotNull { it.input.string("url")?.let { u -> ChatSources.host(u) } }.filter { it.isNotBlank() }.distinct()
            return ToolLine("Reading ${running.size} pages", hosts.joinToString(", ").ifBlank { null }, live = true)
        }
        return line(running.last(), null, live = true)
    }

    /**
     * The row for one tool call. With no result it runs while the reply is
     * [live]; after that it "did not finish".
     */
    fun line(use: ToolUseBlock, result: ToolResultBlock?, live: Boolean = true): ToolLine {
        val running = result == null && live
        val failed = result?.isError == true
        val input = use.input
        return when (use.name) {
            "WebSearch" -> {
                val list = result?.meta?.results.orEmpty()
                val n = result?.meta?.count ?: list.size
                when {
                    running -> ToolLine("Searching the web", input.string("query"), live = true)
                    result == null -> ToolLine("Search did not finish.")
                    failed -> ToolLine("Search failed", failed = true)
                    n == 0 && list.isEmpty() -> ToolLine("Searched the web, nothing found")
                    else -> ToolLine("Searched the web, " + plural(n, "result", "results"))
                }
            }
            "WebFetch" -> {
                val host = (result?.meta?.url ?: input.string("url"))?.let { ChatSources.host(it) } ?: "the page"
                when {
                    running -> ToolLine("Reading", host, live = true)
                    result == null -> ToolLine("Reading stopped, $host")
                    failed -> ToolLine("Could not read $host", failed = true)
                    else -> ToolLine("Read $host")
                }
            }
            "MemorySearch" -> when {
                running -> ToolLine("Checking memory", input.string("query"), live = true)
                result == null -> ToolLine("Memory check did not finish.")
                failed -> ToolLine("Memory check failed", failed = true)
                else -> {
                    val n = notes(result).size
                    ToolLine(if (n == 0) "Checked memory, nothing found" else "Checked memory, " + plural(n, "note", "notes"))
                }
            }
            "MemorySave" -> when {
                running -> ToolLine("Saving to memory", live = true)
                result == null -> ToolLine("Saving to memory did not finish.")
                failed -> ToolLine("Could not save to memory", failed = true)
                else -> ToolLine("Saved to memory")
            }
            "MemoryForget" -> when {
                running -> ToolLine("Retiring a note", live = true)
                result == null -> ToolLine("Retiring a note did not finish.")
                failed -> ToolLine("Could not retire a note", failed = true)
                else -> ToolLine("Retired a note")
            }
            else -> {
                val label = use.name.removePrefix("mcp__").replace("__", " ").ifBlank { "a tool" }
                when {
                    running -> ToolLine("Using $label", live = true)
                    result == null -> ToolLine("$label did not finish.")
                    failed -> ToolLine("$label failed", failed = true)
                    else -> ToolLine("Used $label")
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The chat list, the greeting and the composer's words
// ---------------------------------------------------------------------------

data class ChatGroup(val key: String, val title: String, val chats: List<Session>)

object ChatList {

    /** Today, Yesterday, Previous 7 days, Previous 30 days, then one group per month. */
    fun group(ts: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.ENGLISH): Pair<String, String> {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val day: LocalDate = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()
        return when {
            !day.isBefore(today) -> "today" to "Today"
            !day.isBefore(today.minusDays(1)) -> "yesterday" to "Yesterday"
            !day.isBefore(today.minusDays(7)) -> "week" to "Previous 7 days"
            !day.isBefore(today.minusDays(30)) -> "month" to "Previous 30 days"
            else -> {
                val month = day.month.getDisplayName(TextStyle.FULL, locale)
                "m:${day.year}-${day.monthValue}" to if (day.year == today.year) month else "$month ${day.year}"
            }
        }
    }

    /** Chats only, newest activity first, in their time groups. */
    fun groups(sessions: List<Session>, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): List<ChatGroup> {
        val out = LinkedHashMap<String, Pair<String, MutableList<Session>>>()
        for (s in sessions.filter { it.isChat && !it.archived }.sortedByDescending { it.updatedAt }) {
            val (key, title) = group(s.updatedAt, now, zone)
            out.getOrPut(key) { title to ArrayList() }.second.add(s)
        }
        return out.map { (k, v) -> ChatGroup(k, v.first, v.second) }
    }

    /** "Good morning", "Good afternoon" or "Good evening", then ", Kai." or a period. */
    fun greeting(name: String?, hour: Int): String {
        val part = when (hour) {
            in 5..11 -> "morning"
            in 12..17 -> "afternoon"
            else -> "evening"
        }
        val who = name?.trim()?.takeIf { it.isNotEmpty() }
        return if (who != null) "Good $part, $who." else "Good $part."
    }

    /** The Tools control: "Web, memory", "Web", "Memory" or "No web, no memory". */
    fun toolsLabel(s: ChatSettings): String = when {
        s.webSearch && s.memory -> "Web, memory"
        s.webSearch -> "Web"
        s.memory -> "Memory"
        else -> "No web, no memory"
    }

    /** The Effort control: "Effort high", the stored level as the model takes it, else its default ("Effort default" when unknown). */
    fun effortLabel(level: ThinkingLevel?, effort: ModelEffort?): String {
        val shown = effort?.let { Effort.shown(level, it) }
        return "Effort " + (shown?.let { Effort.label(it, effort) } ?: "default").lowercase()
    }

    /** How many replies an edit of [message] removes: Edit asks first when it is more than two. */
    fun repliesAfter(units: List<ChatUnit>, message: Message): Int {
        val at = units.indexOfFirst { it is ChatUnit.User && it.message.id == message.id }
        if (at < 0) return 0
        return units.drop(at + 1).count { it is ChatUnit.Reply }
    }

    /** A branch's title: "<title>, branch". */
    fun branchTitle(title: String): String = title.ifBlank { "New chat" } + ", branch"
}
