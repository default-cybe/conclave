package dev.conclave.client.logic

import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.RedactedThinkingBlock
import dev.conclave.client.model.Role
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.UnknownBlock
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonObject

/*
 * A turn's work, grouped (docs/design/CHAT-AND-MOTION.md 6.3, the web's
 * features/chat/toolGroups.ts and Turn.tsx turnPieces). The thoughts and
 * calls between two pieces of text are one stretch of work. Two or more of
 * them are one row, "Thought for 15s, ran git log", that opens to the
 * thoughts and calls in order, and each of those opens what it did. A single
 * call is a row of its own and a lone thought stays as it is. A Workflow
 * call and a Task call are compact rows of their own (Tasks.kt) and split
 * the stretch around them.
 */

/** One step of a turn's work, in the order it ran: a call, or a thought. */
sealed class WorkEntry {
    abstract val key: String

    data class Call(val use: ToolUseBlock, override val key: String) : WorkEntry()

    /** A [ThinkingBlock] or a [RedactedThinkingBlock]. [streaming]: the turn's last block, still being written. */
    data class Thought(val block: ContentBlock, val message: Message, override val key: String, val streaming: Boolean = false) : WorkEntry() {
        val text: String get() = (block as? ThinkingBlock)?.thinking?.trim().orEmpty()
        val durationMs: Long? get() = (block as? ThinkingBlock)?.durationMs
        val redacted: Boolean get() = block is RedactedThinkingBlock
    }
}

/** A turn's content in order: text and other blocks one each, each stretch of work one piece. */
sealed class TurnPiece {
    abstract val key: String

    /** Text, an image or a document. [last]: the turn's last block. */
    data class Block(val block: ContentBlock, val message: Message, val last: Boolean, override val key: String) : TurnPiece()

    /** The thoughts and calls between two pieces of text. */
    data class Work(val entries: List<WorkEntry>, override val key: String) : TurnPiece()
}

/** How a stretch of work is drawn. */
sealed class WorkSegment {
    abstract val key: String

    /** A call on a row of its own: a single call, a workflow or a subagent. */
    data class One(val call: WorkEntry.Call) : WorkSegment() {
        override val key: String get() = call.key
    }

    /** A thought with no call next to it, as it is. */
    data class Lone(val thought: WorkEntry.Thought) : WorkSegment() {
        override val key: String get() = thought.key
    }

    /** Two or more thoughts and calls as one row. */
    data class Group(val entries: List<WorkEntry>) : WorkSegment() {
        override val key: String get() = entries.first().key
    }

    /** Two or more Task calls of one message (a fan-out): one card, a row per subagent (the web's FanOutCard.tsx). */
    data class FanOut(val calls: List<WorkEntry.Call>) : WorkSegment() {
        override val key: String get() = calls.first().key
    }
}

object Work {
    /** Calls that are a row of their own and never fold into a group. */
    val ALONE = setOf("Workflow", "Task")

    private val PREFIXED = Regex("""(?:__|[.:/])(Workflow|Task)$""")
    private val META = Regex("""export\s+const\s+meta\b""")

    /**
     * The name a call groups and draws by. A Workflow or Task another server
     * or a harness hands on keeps its row ("mcp__conclave__Workflow" is
     * Workflow), as does a call a harness only titled whose input is a
     * workflow script. A harness's "Agent" with a subagent's input is Task.
     * Delegate (a Code or Assistant session on a device doing a job) draws
     * as a subagent: Task.
     */
    fun name(name: String, input: JsonObject? = null): String {
        if (name in ALONE) return name
        if (name == "Delegate") return "Task"
        if (name.equals("workflow", ignoreCase = true)) return "Workflow"
        PREFIXED.find(name)?.let { return it.groupValues[1] }
        val script = input?.string("script")
        if ((name == "Tool" || name.isBlank()) && script != null && META.containsMatchIn(script)) return "Workflow"
        if (name == "Agent" && input != null && (input.string("subagent_type") != null || (input.string("description") != null && input.string("prompt") != null))) return "Task"
        return name
    }

    fun standsAlone(use: ToolUseBlock): Boolean = name(use.name, use.input) in ALONE

    fun isWorkflow(use: ToolUseBlock): Boolean = name(use.name, use.input) == "Workflow"

    fun isTask(use: ToolUseBlock): Boolean = name(use.name, use.input) == "Task"

    /**
     * The turn's assistant blocks as pieces in order. A thought is in the
     * stretch it sits in; an empty thought with no time and an empty text
     * block are nothing and split nothing. [streaming]: the turn's last
     * message is still being written, so a thought that is its last block
     * streams.
     */
    fun pieces(messages: List<Message>, streaming: Boolean = false): List<TurnPiece> {
        val out = ArrayList<TurnPiece>()
        var run = ArrayList<WorkEntry>()
        fun flush() {
            if (run.isNotEmpty()) out += TurnPiece.Work(run, run.first().key)
            run = ArrayList()
        }
        val assistant = messages.filter { it.role == Role.ASSISTANT }
        assistant.forEachIndexed { mi, m ->
            m.content.forEachIndexed { bi, b ->
                val key = "${m.id}:$bi"
                val last = mi == assistant.lastIndex && bi == m.content.lastIndex
                when (b) {
                    is ToolUseBlock -> run += WorkEntry.Call(b, key)
                    is ThinkingBlock -> {
                        val live = streaming && last
                        if (live || b.thinking.isNotBlank() || b.durationMs != null) run += WorkEntry.Thought(b, m, key, live)
                    }
                    is RedactedThinkingBlock -> run += WorkEntry.Thought(b, m, key)
                    is TextBlock -> if (b.text.isNotBlank()) {
                        flush()
                        out += TurnPiece.Block(b, m, last, key)
                    }
                    is ToolResultBlock, is UnknownBlock -> Unit
                    else -> {
                        flush()
                        out += TurnPiece.Block(b, m, last, key)
                    }
                }
            }
        }
        flush()
        return out
    }

    /** A stretch as rows: calls that stand alone, fan-outs of Task calls, groups of two or more, and lone calls and thoughts. */
    fun segment(entries: List<WorkEntry>): List<WorkSegment> {
        val out = ArrayList<WorkSegment>()
        var run = ArrayList<WorkEntry>()
        fun flush() {
            when {
                run.size >= 2 -> out += WorkSegment.Group(run)
                run.size == 1 -> out += when (val e = run[0]) {
                    is WorkEntry.Call -> WorkSegment.One(e)
                    is WorkEntry.Thought -> WorkSegment.Lone(e)
                }
            }
            run = ArrayList()
        }
        for (e in entries) {
            if (e is WorkEntry.Call && standsAlone(e.use)) {
                flush()
                // a Task call next to another of the same message joins its card
                val prev = when (val last = out.lastOrNull()) {
                    is WorkSegment.One -> listOf(last.call).takeIf { isTask(last.call.use) }
                    is WorkSegment.FanOut -> last.calls
                    else -> null
                }
                if (prev != null && isTask(e.use) && messageOf(prev.last()) == messageOf(e)) out[out.lastIndex] = WorkSegment.FanOut(prev + e)
                else out += WorkSegment.One(e)
            } else {
                run += e
            }
        }
        flush()
        return out
    }

    /** The id of the message a call is in: its key is "messageId:blockIndex" ([pieces]). */
    private fun messageOf(c: WorkEntry.Call): String = c.key.substringBeforeLast(':')

    /** The calls of a stretch, in order. */
    fun calls(entries: List<WorkEntry>): List<ToolUseBlock> = entries.filterIsInstance<WorkEntry.Call>().map { it.use }

    /** The index of the last text piece, so the work after it is what the turn is at now. -1 when there is none. */
    fun lastText(pieces: List<TurnPiece>): Int = pieces.indexOfLast { it is TurnPiece.Block }

    /** A stretch as the steps its summary counts. [measured]: the time the phone saw a thought take, by message, when the hub has none yet. */
    fun steps(entries: List<WorkEntry>, measured: Map<String, Long> = emptyMap()): List<WorkStep> = entries.map { e ->
        when (e) {
            is WorkEntry.Call -> WorkStep.Call(e.use)
            is WorkEntry.Thought -> WorkStep.Thought(e.durationMs ?: measured[e.message.id], e.streaming)
        }
    }

    /**
     * What a stretch does now while the turn works on it ([live]): "Thinking"
     * while the thought that ends it is written, else the call that runs
     * ("Running bun test"). Null when neither, or when the turn is past it.
     */
    fun now(entries: List<WorkEntry>, results: Map<String, ToolResultBlock>, live: Boolean): String? {
        if (!live) return null
        val last = entries.lastOrNull()
        if (last is WorkEntry.Thought && last.streaming) return "Thinking"
        val running = entries.lastOrNull { it is WorkEntry.Call && results[it.use.id] == null } as? WorkEntry.Call
        return running?.let { ToolLines.working(it.use) }
    }

    /** A thought's row in an open group: "Thought for 12s", "Thinking" while it streams, "Thought, 40 words" with no time. */
    fun thoughtLabel(t: WorkEntry.Thought, measured: Long? = null): String {
        if (t.redacted) return "The provider hid this reasoning."
        if (t.streaming) return "Thinking"
        val ms = t.durationMs ?: measured
        if (ms != null) return ChatLive.thoughtFor(ms)
        val words = t.text.split(Regex("\\s+")).count { it.isNotEmpty() }
        return "Thought, $words ${if (words == 1) "word" else "words"}"
    }
}
