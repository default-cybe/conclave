package dev.conclave.client.logic

import dev.conclave.client.model.Ask
import dev.conclave.client.model.EngineEvent

/**
 * Approvals and questions from subagents and workflow agents, in the chat
 * the owner is in (docs/design/CHAT-AND-MOTION.md 1.4; the web's
 * src/lib/asks.ts says the same). The hub names the top session of the one
 * that asks ([Ask.rootSessionId]) and who asks ([Ask.from]), so the card
 * shows inline where you are as well as in the Inbox, with a quiet line
 * above it: "Subagent email asks", "Workflow deep-research, agent search r1
 * 3, asks". The request keeps the session that asks: answering resolves it
 * there, and "for this chat" is that session's ("for this subagent").
 */
object Asks {
    /** The conversation the request shows in: its top session, else (an older hub) the one that asks. */
    fun home(r: Ask): String = r.rootSessionId ?: r.sessionId

    /** The request shows inline in this session: it asks here, or a subagent or workflow agent under it asks. */
    fun showsIn(r: Ask, sessionId: String): Boolean =
        r.sessionId == sessionId || r.rootSessionId == sessionId || r.from?.chain?.contains(sessionId) == true

    /** The requests that show in this session. */
    fun <T : Ask> of(list: List<T>, sessionId: String): List<T> = list.filter { showsIn(it, sessionId) }

    /** A session under this one waits on you: the turn that started it does too. */
    fun below(list: List<Ask>, sessionId: String): Boolean = list.any { it.sessionId != sessionId && showsIn(it, sessionId) }

    /** This session, or one under it, waits on you: a subagent's row says so. */
    fun waitsIn(list: List<Ask>, sessionId: String?): Boolean =
        sessionId != null && list.any { it.sessionId == sessionId || it.from?.chain?.contains(sessionId) == true }

    /** An agent of this workflow run waits on you. */
    fun runWaits(list: List<Ask>, runId: String): Boolean = list.any { it.from?.workflow?.runId == runId }

    /** An approval or a question came or went: a chat applies it when it shows there ([showsIn]), whichever session asked. */
    fun isAskEvent(e: EngineEvent): Boolean =
        e is EngineEvent.ApprovalRequested || e is EngineEvent.ApprovalResolved || e is EngineEvent.QuestionAsked || e is EngineEvent.QuestionAnswered

    /** Who asks, as the start of a sentence: "Subagent email", "Workflow deep-research, agent search r1 3,". */
    private fun who(r: Ask): String? {
        val f = r.from ?: return null
        val wf = f.workflow
        return if (wf != null) "Workflow ${wf.name}, agent ${f.label}," else "Subagent ${f.agent}"
    }

    /**
     * The quiet line above a card: "Subagent email asks". Null for a top
     * session's own request, and in the session that asks (you are in it).
     */
    fun fromLine(r: Ask, viewing: String?): String? {
        if (viewing == r.sessionId) return null
        return who(r)?.let { "$it asks" }
    }

    /** For the Inbox: "from subagent email in Lisbon flight booking code". */
    fun inboxLine(r: Ask, rootTitle: String? = null): String? {
        val f = r.from ?: return null
        val wf = f.workflow
        val w = if (wf != null) "workflow ${wf.name}, agent ${f.label}," else "subagent ${f.agent}"
        return if (rootTitle.isNullOrBlank()) "from $w" else "from $w in $rootTitle"
    }

    /** An Inbox row's line with who asks in front: "Subagent email wants to read a file". The line as it is for a top session. */
    fun askerLine(r: Ask, line: String): String {
        val w = who(r) ?: return line
        return "$w ${line.replaceFirstChar { it.lowercaseChar() }}"
    }

    /** "Allow for this chat", and "Allow for this subagent" when a subagent or a workflow agent asks: it applies to the session that asked. */
    fun sessionLabel(r: Ask): String = if (r.from != null) "Allow for this subagent" else "Allow for this chat"

    /** What the session answer reads once given. */
    fun sessionDone(r: Ask): String = if (r.from != null) "Allowed for this subagent" else "Allowed for this chat"
}
