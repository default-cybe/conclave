package dev.conclave.client.logic

import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.ToolResultBlock

/** What the chat list renders, derived from the message list. */
sealed class ChatItem {
    abstract val key: String

    data class User(val message: Message) : ChatItem() {
        override val key get() = message.id
    }

    data class Assistant(val message: Message) : ChatItem() {
        override val key get() = message.id
    }

    /** Second opinion or other side comment, shown indented with its author. */
    data class Aside(val message: Message) : ChatItem() {
        override val key get() = message.id
    }

    /** Juror (or debate) answers that share a group, plus the verdict when present. */
    data class Jury(val group: String, val answers: List<Message>, val verdict: Message?) : ChatItem() {
        override val key get() = "group:$group"
    }

    data class Notice(val message: Message) : ChatItem() {
        override val key get() = message.id
    }

    data class Summary(val message: Message) : ChatItem() {
        override val key get() = message.id
    }

    /**
     * An assistant turn on the phone: the assistant messages between two of
     * yours, so the turn's tool calls fold into one line (MOBILE-V2 5).
     */
    data class Turn(val messages: List<Message>) : ChatItem() {
        override val key get() = "turn:" + messages.first().id
    }
}

object ChatItems {

    fun build(messages: List<Message>): List<ChatItem> {
        // Groups with two or more asides become a jury pager.
        val asideGroups = messages
            .filter { it.kind == MessageKind.ASIDE && it.group != null }
            .groupBy { it.group!! }
            .filterValues { it.size >= 2 }
        val verdicts = messages
            .filter { it.kind == MessageKind.NORMAL && it.role == Role.ASSISTANT && it.group != null && it.group in asideGroups }
            .associateBy { it.group!! }

        val out = ArrayList<ChatItem>()
        val emittedGroups = HashSet<String>()
        for (m in messages) {
            val group = m.group
            if (group != null && group in asideGroups) {
                val isMember = m.kind == MessageKind.ASIDE || verdicts[group]?.id == m.id
                if (isMember) {
                    if (emittedGroups.add(group)) {
                        out.add(ChatItem.Jury(group, asideGroups.getValue(group), verdicts[group]))
                    }
                    continue
                }
            }
            when (m.kind) {
                MessageKind.NOTICE -> out.add(ChatItem.Notice(m))
                MessageKind.SUMMARY -> out.add(ChatItem.Summary(m))
                MessageKind.ASIDE -> out.add(ChatItem.Aside(m))
                MessageKind.NORMAL -> when (m.role) {
                    Role.USER -> if (!isToolResultsOnly(m)) out.add(ChatItem.User(m))
                    Role.ASSISTANT -> out.add(ChatItem.Assistant(m))
                }
            }
        }
        return out
    }

    /**
     * [items] with each run of assistant messages joined into one
     * [ChatItem.Turn]. The turn keeps the key of its first message, so it
     * stays put while it grows.
     */
    fun turns(items: List<ChatItem>): List<ChatItem> {
        val out = ArrayList<ChatItem>()
        var run = ArrayList<Message>()
        fun flush() {
            if (run.isNotEmpty()) out.add(ChatItem.Turn(run))
            run = ArrayList()
        }
        for (item in items) {
            if (item is ChatItem.Assistant) {
                run.add(item.message)
                continue
            }
            flush()
            out.add(item)
        }
        flush()
        return out
    }

    /** User turns that only carry tool results are shown inside the tool cards instead. */
    fun isToolResultsOnly(m: Message): Boolean =
        m.content.isNotEmpty() && m.content.all { it is ToolResultBlock }
}
