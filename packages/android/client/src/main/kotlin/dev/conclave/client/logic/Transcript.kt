package dev.conclave.client.logic

import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.DeltaKind
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.QueuedMessage
import dev.conclave.client.model.Role
import dev.conclave.client.model.SendResult
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.Todo
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock

/** Live state of one chat. Immutable; [TranscriptReducer] produces new copies. */
data class Transcript(
    val sessionId: String,
    /** Sorted by seq. */
    val messages: List<Message> = emptyList(),
    /** Tool results by toolUseId, from tool_result blocks and tool.completed events. */
    val toolResults: Map<String, ToolResultBlock> = emptyMap(),
    /** Latest progress line per running tool. */
    val toolProgress: Map<String, String> = emptyMap(),
    /** toolUseIds started but not completed yet. */
    val runningTools: Set<String> = emptySet(),
    val todos: List<Todo> = emptyList(),
    val approvals: List<ApprovalRequest> = emptyList(),
    val questions: List<QuestionRequest> = emptyList(),
    /** Messages waiting while the session works, as the hub lists them (GET /queue, session.queue). */
    val queue: List<QueuedMessage> = emptyList(),
    /** Messages this app sent while it worked that the hub's list does not show yet. */
    val sending: List<Sending> = emptyList(),
    /** session.queue events applied, so a load never lays an older list over a newer one. */
    val queueVersion: Int = 0,
) {
    val lastSeq: Long get() = messages.maxOfOrNull { it.seq } ?: 0L

    /** What waits, in the order it will run, with what this app sent that the hub has not listed yet (PendingQueue). */
    val pending: List<QueuedMessage> get() = PendingQueue.shown(queue, sending)
}

object TranscriptReducer {

    /**
     * Merge messages fetched over REST (initial load or after a reconnect).
     * A reply that ended here stays: a copy without a stop reason was read
     * before it ended, and its answer came after the last update.
     */
    fun merge(t: Transcript, fetched: List<Message>): Transcript {
        if (fetched.isEmpty()) return t
        val byId = LinkedHashMap<String, Message>()
        t.messages.forEach { byId[it.id] = it }
        for (m in fetched) {
            if (m.sessionId.isNotEmpty() && m.sessionId != t.sessionId) continue
            if (m.stopReason == null && byId[m.id]?.stopReason != null) continue
            byId[m.id] = m
        }
        val messages = byId.values.sortedWith(compareBy<Message> { it.seq }.thenBy { it.createdAt })
        return dropTaken(t.copy(messages = messages, toolResults = t.toolResults + collectResults(fetched)), fetched)
    }

    /**
     * The hub's list from a load (GET /queue), asked at [askedAt] when the
     * transcript had seen [version] queue events. A session.queue event that
     * came while the load was out is newer: then the load's list is left out.
     * One already in the transcript never shows again.
     */
    fun loadedQueue(t: Transcript, list: List<QueuedMessage>, askedAt: Long, version: Int): Transcript {
        if (t.queueVersion != version) return t
        val taken = t.messages.flatMapTo(HashSet()) { PendingQueue.pendingIds(it) }
        val hub = list.filter { it.id !in taken }
        return t.copy(queue = hub, sending = PendingQueue.afterHubList(t.sending, hub, loadedFrom = askedAt))
    }

    /** This app sent [item] while the session worked: it shows at once. */
    fun sent(t: Transcript, item: QueuedMessage): Transcript = t.copy(sending = t.sending + Sending(item))

    /** The hub answered the send of [id]: it waits (until the hub's list has it), or it leaves. */
    fun answered(t: Transcript, id: String, result: SendResult?, now: Long = System.currentTimeMillis()): Transcript =
        t.copy(sending = PendingQueue.answered(t.sending, id, result, now))

    /** Remove: the waiting message leaves at once. */
    fun removed(t: Transcript, id: String): Transcript =
        t.copy(queue = t.queue.filterNot { it.id == id }, sending = t.sending.filterNot { it.item.id == id })

    /** The hub refused to remove [id]: the list as it was ([before]), unless a newer one came meanwhile. */
    fun unremoved(t: Transcript, before: Transcript, id: String): Transcript {
        val queue = if (t.queueVersion == before.queueVersion) before.queue else t.queue
        val mine = before.sending.firstOrNull { it.item.id == id }?.takeIf { t.sending.none { s -> s.item.id == id } }
        return t.copy(queue = queue, sending = if (mine != null) t.sending + mine else t.sending)
    }

    /**
     * Where a reload after a reconnect starts: just before the last reply
     * when it is still open here (it may have ended meanwhile, and that
     * update was missed), else after the newest message. Null loads everything.
     */
    fun reloadAfter(t: Transcript): Long? {
        val last = t.messages.lastOrNull { it.role == Role.ASSISTANT && it.kind == MessageKind.NORMAL }
        val open = last?.takeIf { it.stopReason == null }
        return (open?.let { it.seq - 1 } ?: t.lastSeq).takeIf { it > 0 }
    }

    fun apply(t: Transcript, event: EngineEvent): Transcript = when (event) {
        // your message took a waiting one's place: the bubble goes in the same copy, so both never show
        is EngineEvent.MessageCreated -> if (event.message.sessionId == t.sessionId) dropTaken(upsert(t, event.message), listOf(event.message)) else t
        is EngineEvent.MessageUpdated -> if (event.message.sessionId == t.sessionId) dropTaken(upsert(t, event.message), listOf(event.message)) else t
        // a refused reply the next model replaces, or an empty one: it leaves at once, not on the next load
        is EngineEvent.MessageDeleted -> if (event.sessionId == t.sessionId) remove(t, event.messageId) else t
        is EngineEvent.SessionQueue -> if (event.sessionId == t.sessionId) {
            t.copy(queue = event.queue, sending = PendingQueue.afterHubList(t.sending, event.queue), queueVersion = t.queueVersion + 1)
        } else t
        is EngineEvent.MessageDelta -> if (event.sessionId == t.sessionId) applyDelta(t, event) else t
        is EngineEvent.ToolStarted -> if (event.sessionId == t.sessionId) {
            t.copy(runningTools = t.runningTools + event.toolUseId)
        } else t
        is EngineEvent.ToolProgress -> if (event.sessionId == t.sessionId) {
            t.copy(toolProgress = t.toolProgress + (event.toolUseId to event.text))
        } else t
        is EngineEvent.ToolCompleted -> if (event.sessionId == t.sessionId) {
            t.copy(
                toolResults = t.toolResults + (event.toolUseId to event.result),
                runningTools = t.runningTools - event.toolUseId,
                toolProgress = t.toolProgress - event.toolUseId,
            )
        } else t
        is EngineEvent.TodoUpdated -> if (event.sessionId == t.sessionId) t.copy(todos = event.todos) else t
        // its own, and those of its subagents and workflow agents (Asks.kt): they wait on you here too
        is EngineEvent.ApprovalRequested -> if (Asks.showsIn(event.approval, t.sessionId)) {
            t.copy(approvals = t.approvals.filterNot { it.id == event.approval.id } + event.approval)
        } else t
        is EngineEvent.ApprovalResolved -> t.copy(approvals = t.approvals.filterNot { it.id == event.id })
        is EngineEvent.QuestionAsked -> if (Asks.showsIn(event.question, t.sessionId)) {
            t.copy(questions = t.questions.filterNot { it.id == event.question.id } + event.question)
        } else t
        is EngineEvent.QuestionAnswered -> t.copy(questions = t.questions.filterNot { it.id == event.id })
        is EngineEvent.SessionUpdated -> if (event.session.id == t.sessionId && event.session.status == SessionStatus.IDLE) {
            // Turn ended: nothing can still be running.
            t.copy(runningTools = emptySet(), toolProgress = emptyMap())
        } else t
        else -> t
    }

    /** Without the waiting messages these messages took the place of; the same copy when none. */
    private fun dropTaken(t: Transcript, messages: List<Message>): Transcript {
        if (t.queue.isEmpty() && t.sending.isEmpty()) return t
        val taken = messages.flatMapTo(HashSet()) { PendingQueue.pendingIds(it) }
        if (taken.isEmpty()) return t
        val queue = t.queue.filterNot { it.id in taken }
        val sending = t.sending.filterNot { it.item.id in taken }
        return if (queue.size == t.queue.size && sending.size == t.sending.size) t else t.copy(queue = queue, sending = sending)
    }

    /** Without message [id]; its calls stop counting as running. The same copy when it is not here. */
    private fun remove(t: Transcript, id: String): Transcript {
        val gone = t.messages.firstOrNull { it.id == id } ?: return t
        val calls = gone.content.filterIsInstance<ToolUseBlock>().map { it.id }.toSet()
        return t.copy(
            messages = t.messages.filterNot { it.id == id },
            runningTools = t.runningTools - calls,
            toolProgress = t.toolProgress - calls,
        )
    }

    private fun upsert(t: Transcript, m: Message): Transcript {
        val idx = t.messages.indexOfFirst { it.id == m.id }
        val list = if (idx >= 0) {
            t.messages.toMutableList().also { it[idx] = m }
        } else {
            t.messages + m
        }
        return t.copy(messages = list.sortedBy { it.seq }, toolResults = t.toolResults + collectResults(listOf(m)))
    }

    /** Append streamed text to block [EngineEvent.MessageDelta.index] of the right message. */
    private fun applyDelta(t: Transcript, d: EngineEvent.MessageDelta): Transcript {
        val idx = t.messages.indexOfFirst { it.id == d.messageId }
        val base = if (idx >= 0) {
            t.messages[idx]
        } else {
            // Delta for a message we have not seen yet: start a placeholder at the end.
            Message(
                id = d.messageId,
                sessionId = d.sessionId,
                seq = t.lastSeq + 1,
                role = Role.ASSISTANT,
                kind = MessageKind.NORMAL,
                createdAt = System.currentTimeMillis(),
            )
        }
        val content = base.content.toMutableList()
        while (content.size <= d.index) content.add(emptyBlockFor(d.kind))
        content[d.index] = appendTo(content[d.index], d)
        val updated = base.copy(content = content)
        val list = t.messages.toMutableList()
        if (idx >= 0) list[idx] = updated else list.add(updated)
        return t.copy(messages = list)
    }

    private fun emptyBlockFor(kind: DeltaKind): ContentBlock = when (kind) {
        DeltaKind.TEXT -> TextBlock("")
        DeltaKind.THINKING -> ThinkingBlock("")
        DeltaKind.TOOL_INPUT -> ToolUseBlock()
    }

    private fun appendTo(block: ContentBlock, d: EngineEvent.MessageDelta): ContentBlock = when (d.kind) {
        DeltaKind.TEXT -> when (block) {
            is TextBlock -> block.copy(text = block.text + d.text)
            else -> TextBlock(d.text)
        }
        DeltaKind.THINKING -> when (block) {
            is ThinkingBlock -> block.copy(thinking = block.thinking + d.text)
            else -> ThinkingBlock(d.text)
        }
        DeltaKind.TOOL_INPUT -> when (block) {
            is ToolUseBlock -> block.copy(partialInput = block.partialInput + d.text)
            else -> ToolUseBlock(partialInput = d.text)
        }
    }

    private fun collectResults(messages: List<Message>): Map<String, ToolResultBlock> {
        val out = HashMap<String, ToolResultBlock>()
        for (m in messages) for (b in m.content) if (b is ToolResultBlock) out[b.toolUseId] = b
        return out
    }
}
