package dev.conclave.client.logic

import dev.conclave.client.model.Ask
import dev.conclave.client.model.Message
import dev.conclave.client.model.Role
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.string

/*
 * A session's background work, as the Claude app shows it: a Workflow or
 * Task call is one compact row in the transcript ("Workflow deep-research,
 * running, 3 of 6 agents", "Subagent explore: Find the auth code, searching
 * for jwt", or for a Delegate call "Code on MadX Arch: Find names in the
 * capstone PDFs"), and while any of them runs, "2 running tasks" sits above the
 * composer and opens a sheet with each one. Worked out here from what the
 * phone already has: the session's messages and runs, and the sessions.
 */

/** Something a session started that still runs. */
sealed class RunningTask {
    abstract val key: String

    /** A live workflow run of the session, and the call that started it when it is in the transcript. */
    data class Flow(val run: WorkflowRun, val use: ToolUseBlock?) : RunningTask() {
        override val key: String get() = "run:" + run.id
    }

    /** A Task call whose subagent still works; [child] is its session once the phone has it. */
    data class Agent(val use: ToolUseBlock, val child: Session?) : RunningTask() {
        override val key: String get() = "task:" + use.id
    }
}

/** What a subagent is doing now, for the line under its row. [waiting]: it waits on you. */
data class SubagentNow(val text: String, val waiting: Boolean = false)

object Tasks {
    // a paused subagent stays listed until Resume
    private val BUSY = setOf(SessionStatus.RUNNING, SessionStatus.WAITING_APPROVAL, SessionStatus.WAITING_INPUT, SessionStatus.WAITING_RESET, SessionStatus.PAUSED)

    fun busy(s: Session?): Boolean = s != null && s.status in BUSY

    /** "1 running task", "2 running tasks". */
    fun pill(n: Int): String = if (n == 1) "1 running task" else "$n running tasks"

    /** A fan-out card's header, as the web's fanOutWords: "4 subagents, 2 running, 1 failed". */
    fun fanOutWords(total: Int, running: Int, failed: Int): String = listOfNotNull(
        "$total ${if (total == 1) "subagent" else "subagents"}",
        "$running running".takeIf { running > 0 },
        "$failed failed".takeIf { failed > 0 },
    ).joinToString(", ")

    /**
     * The subagent's session for a Task call: the one its result names, else
     * a child of [parentId] that carries a Delegate call's id or is titled
     * with the call's description (the hub cuts a title at 60 characters).
     * Null until the phone has it.
     */
    fun child(use: ToolUseBlock, result: ToolResultBlock?, parentId: String?, sessions: List<Session>): Session? {
        result?.meta?.sessionId?.let { id -> return sessions.firstOrNull { it.id == id } }
        if (parentId == null) return null
        val delegated = isDelegate(use)
        val description = if (delegated) description(use) else use.input.string("description")?.trim()?.ifEmpty { null } ?: return null
        return sessions.filter {
            // a delegated session keeps the call id in meta.movedFrom once it moved to the main list
            it.parentId == parentId && ((delegated && Delegated.mark(it)?.string("toolUseId") == use.id) || it.title == description || it.title == description.take(60))
        }.maxByOrNull { it.createdAt }
    }

    /**
     * Whether a Task call's subagent still works: with no result yet while
     * its session (or, before the phone has it, the parent) is busy; with a
     * result that sent it to the background while its session is.
     */
    fun running(use: ToolUseBlock, result: ToolResultBlock?, child: Session?, parent: Session?): Boolean = when {
        result == null -> if (child != null) busy(child) else busy(parent)
        result.meta?.background == true -> busy(child)
        else -> false
    }

    /**
     * The session's running tasks: its live workflow runs (each with the
     * call that started it, when the transcript has it), then its Task calls
     * whose subagents still work, background ones too, oldest first.
     */
    fun running(
        session: Session?,
        messages: List<Message>,
        results: Map<String, ToolResultBlock>,
        runs: List<WorkflowRun>,
        sessions: List<Session>,
    ): List<RunningTask> {
        val sid = session?.id ?: return emptyList()
        val uses = messages.filter { it.role == Role.ASSISTANT }.flatMap { m -> m.content.filterIsInstance<ToolUseBlock>() }
        val flows = uses.filter { Work.isWorkflow(it) }
        val live = runs.filter { it.sessionId == sid && WorkflowWords.isLive(it.status) }.sortedBy { it.createdAt }
        val out = ArrayList<RunningTask>()
        live.forEach { run ->
            val use = flows.firstOrNull { u -> results[u.id]?.meta?.workflowRunId == run.id } ?: flows.firstOrNull { WorkflowWords.startedBy(run, it, sid) }
            out += RunningTask.Flow(run, use)
        }
        uses.filter { Work.isTask(it) }.forEach { use ->
            val result = results[use.id]
            val child = child(use, result, sid, sessions)
            if (running(use, result, child, session)) out += RunningTask.Agent(use, child)
        }
        return out
    }

    // -----------------------------------------------------------------------
    // Subagents
    // -----------------------------------------------------------------------

    /** The agent a Task call runs: its session's, else the one the call or its result names. */
    fun agentOf(use: ToolUseBlock, result: ToolResultBlock?, child: Session?): String? =
        child?.agent?.ifBlank { null } ?: result?.meta?.agent?.ifBlank { null } ?: use.input.string("subagent_type")?.trim()?.ifEmpty { null }
            ?: use.input.string("agent")?.trim()?.ifEmpty { null }?.takeIf { isDelegate(use) }

    /** A Delegate call: a Code or Assistant session on a device does the job. It draws as a subagent. */
    fun isDelegate(use: ToolUseBlock): Boolean = use.name == "Delegate"

    /** What a Task call does; a Delegate call without a description goes by its brief's first line, as the hub titles its session. */
    fun description(use: ToolUseBlock): String {
        use.input.string("description")?.trim()?.ifEmpty { null }?.let { return it }
        if (!isDelegate(use)) return "Subagent"
        return use.input.string("prompt")?.trim()?.lineSequence()?.firstOrNull()?.trim()?.ifEmpty { null } ?: "Delegated work"
    }

    /**
     * Who does a Delegate call's job and where, "Code on MadX Arch": the
     * device's name from the result or the session, else as the call wrote
     * it. Null for a Task call.
     */
    fun handedTo(use: ToolUseBlock, result: ToolResultBlock?, child: Session?): String? {
        if (!isDelegate(use)) return null
        val who = if (use.input.string("to") == "assistant") "Assistant" else "Code"
        val where = result?.meta?.delegate?.string("deviceName")?.ifBlank { null }
            ?: Delegated.mark(child)?.string("deviceName")?.ifBlank { null }
            ?: use.input.string("device")?.trim()?.ifEmpty { null }
        return if (where != null) "$who on $where" else who
    }

    /** The words before a subagent's description: "Subagent explore: ", or for a Delegate call "Code on MadX Arch: ". */
    fun lead(agent: String?, handedTo: String? = null): String = when {
        handedTo != null -> "$handedTo: "
        agent != null -> "Subagent $agent: "
        else -> "Subagent "
    }

    /** "Haiku 5.5": the model a subagent runs on, its session's, else the one the call names. Null when neither says. */
    fun model(use: ToolUseBlock, child: Session?): String? =
        (child?.model?.ifBlank { null } ?: use.input.string("model")?.trim()?.ifEmpty { null })?.let { ModelRefs.displayName(it) }?.ifBlank { null }

    /** "explore, Haiku 5.5": the agent and the model it runs on, for the detail. */
    fun who(use: ToolUseBlock, result: ToolResultBlock?, child: Session?): String =
        listOfNotNull(agentOf(use, result, child), child?.model?.let { ModelRefs.displayName(it) }?.ifBlank { null } ?: use.input.string("model")?.ifBlank { null })
            .joinToString(", ")

    /**
     * A Task call's compact row: "Subagent explore: Find the auth code,
     * searching for jwt" while it works ([now]), "Subagent explore: Find the
     * auth code" once it is done.
     */
    fun subagentRow(use: ToolUseBlock, agent: String?, now: String?, handedTo: String? = null): String {
        val head = lead(agent, handedTo) + description(use)
        return if (now == null) head else "$head, ${now.replaceFirstChar { it.lowercaseChar() }}"
    }

    /**
     * What a subagent does, from one of its calls: the call running now in
     * the present ("Running bun test", "Searching for jwt", "Reading
     * auth.ts"), else the last one it made in the past ("Read auth.ts").
     */
    fun callNow(use: ToolUseBlock, running: Boolean): String {
        if (running) ToolLines.workingOrNull(use)?.let { return it }
        val s = ToolLines.step(use, null)
        return listOfNotNull(s.verb, s.target?.lineSequence()?.firstOrNull()).joinToString(" ")
    }

    /**
     * What a subagent is doing now, from its own session: waiting on you
     * (its own approval or question, or one of a subagent under it, from
     * [asks]: Asks.kt), writing, thinking, or its latest call. "Starting"
     * before the phone has its session or its first call. [progress]: the
     * call's own progress line, for a harness's subagent that has no session here.
     */
    fun now(child: Session?, messages: List<Message>, results: Map<String, ToolResultBlock>, running: Set<String> = emptySet(), progress: String? = null, asks: List<Ask> = emptyList()): SubagentNow {
        if (child == null) return SubagentNow(progress?.lines()?.lastOrNull { it.isNotBlank() }?.trim()?.let { ToolLines.cut(it, 80) } ?: "Starting")
        if (child.status == SessionStatus.PAUSED) return SubagentNow("Paused")
        if (child.status == SessionStatus.WAITING_APPROVAL || child.status == SessionStatus.WAITING_INPUT || Asks.waitsIn(asks, child.id)) return SubagentNow("Waiting on you", waiting = true)
        val working = child.status == SessionStatus.RUNNING
        for (m in messages.asReversed()) {
            if (m.role != Role.ASSISTANT) continue
            val streaming = working && m.stopReason == null
            val last = m.content.lastOrNull { !(it is TextBlock && it.text.isBlank()) }
            if (streaming && last is TextBlock) return SubagentNow("Writing")
            if (streaming && last is ThinkingBlock) return SubagentNow("Thinking")
            val use = m.content.lastOrNull { it is ToolUseBlock } as? ToolUseBlock
            if (use != null) return SubagentNow(callNow(use, working && (use.id in running || results[use.id] == null)))
        }
        return SubagentNow("Starting")
    }
}
