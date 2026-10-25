package dev.conclave.client.logic

import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import java.time.ZoneId

/*
 * The side panel and the lists it opens (docs/design/MOBILE-V2.md 2 and 6):
 * the latest chats and sessions with their dots, the Code dot, "2 need you"
 * on Home, and the Chats and Code lists. Kept here so they are tested
 * without a device.
 */

/** The dot after a recent: none, running (small, pulsing) or waiting on you (accent). */
enum class RecentDot { NONE, RUNNING, WAITING }

/** One of the panel's recents: title only, and its dot. */
data class Recent(val id: String, val title: String, val chat: Boolean, val dot: RecentDot)

/** A group of a list: "Pinned", "Today", "Previous 7 days", a month. */
data class ListGroup(val key: String, val title: String, val sessions: List<Session>)

object Panel {

    /** How many recents the panel lists. */
    const val RECENTS = 10

    /**
     * The [count] latest chats and agent sessions, mixed, newest activity
     * first. Archived sessions, subagents and a workflow's own agents are
     * left out (the run lists those). [waiting] holds the sessions an open
     * approval or question belongs to. With [mode], only the conversations
     * of that switch (docs/DESIGN.md 15: the panel lists the mode's recents).
     */
    fun recents(sessions: List<Session>, waiting: Set<String> = emptySet(), count: Int = RECENTS, mode: StartMode? = null): List<Recent> = sessions
        .filter { shown(it) && (mode == null || Start.modeOf(it) == mode) }
        .sortedByDescending { it.updatedAt }
        .take(count)
        .map { s -> Recent(s.id, title(s), s.isChat, dot(s, s.id in waiting)) }

    /** What the panel and the lists show: not archived, not a subagent (delegated work has a group of its own; moved to the main list, it shows), not one of a workflow's agents. */
    fun shown(s: Session): Boolean = !s.archived && !Delegated.underParent(s) && Home.workflowRunOf(s) == null

    /** A session's dot: waiting on you wins over running. */
    fun dot(s: Session, asked: Boolean = false): RecentDot = when {
        asked || s.status == SessionStatus.WAITING_APPROVAL || s.status == SessionStatus.WAITING_INPUT -> RecentDot.WAITING
        s.status == SessionStatus.RUNNING -> RecentDot.RUNNING
        else -> RecentDot.NONE
    }

    /** The title a row shows: the session's own, or "New chat" and "New session" until it has one. */
    fun title(s: Session): String = s.title.trim().ifEmpty { if (s.isChat) "New chat" else "New session" }

    /** Code gets a dot after its word while an agent session runs. */
    fun codeRunning(sessions: List<Session>): Boolean = sessions.any { !it.isChat && !it.archived && it.status == SessionStatus.RUNNING }

    /** Home's one line when something waits: "1 needs you", "2 need you". Null when nothing does. */
    fun needYou(waiting: Int): String? = when {
        waiting <= 0 -> null
        waiting == 1 -> "1 needs you"
        else -> "$waiting need you"
    }

    /**
     * The folders agent sessions on [device] worked in, newest first, each
     * once: what Code offers before it asks for a path. The home folder
     * ("~" or empty) is left out; the picker has its own row for it.
     */
    fun recentFolders(sessions: List<Session>, device: String, count: Int = 6): List<String> = sessions
        .filter { !it.isChat && it.device == device && it.cwd.isNotBlank() && Paths.folderName(it.cwd).isNotEmpty() }
        .sortedByDescending { it.updatedAt }
        .map { it.cwd.trimEnd('/', '\\') }
        .distinct()
        .take(count)
}

object Lists {

    /**
     * The Chats list ([chats] true) or the Code list: pinned first, then by
     * last activity in time groups. [query] matches the title (and for
     * sessions the agent). Archived sessions are listed only when the list
     * is the archive ([archived]).
     */
    fun groups(
        sessions: List<Session>,
        chats: Boolean,
        query: String = "",
        archived: Boolean = false,
        now: Long = System.currentTimeMillis(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<ListGroup> {
        val needle = query.trim().lowercase()
        val list = sessions
            .filter { it.isChat == chats && it.archived == archived && it.parentId == null && Home.workflowRunOf(it) == null }
            .filter { s -> needle.isEmpty() || s.title.lowercase().contains(needle) || (!chats && s.agent.lowercase().contains(needle)) }
            .sortedByDescending { it.updatedAt }
        val out = ArrayList<ListGroup>()
        val pinned = list.filter { it.pinned && !archived }
        if (pinned.isNotEmpty()) out.add(ListGroup("pinned", "Pinned", pinned))
        val byTime = LinkedHashMap<String, Pair<String, MutableList<Session>>>()
        for (s in list) {
            if (s.pinned && !archived) continue
            val (key, title) = ChatList.group(s.updatedAt, now, zone)
            byTime.getOrPut(key) { title to ArrayList() }.second.add(s)
        }
        byTime.forEach { (k, v) -> out.add(ListGroup(k, v.first, v.second)) }
        return out
    }

    /**
     * The second line of a list row, only when it says something:
     * "Running", "Waiting for you", "Failed", "Resumes 15:04".
     */
    fun stateLine(s: Session, clock: (Long) -> String): String? = when (s.status) {
        SessionStatus.RUNNING -> "Running"
        SessionStatus.WAITING_APPROVAL, SessionStatus.WAITING_INPUT -> "Waiting for you"
        SessionStatus.ERROR -> "Failed"
        SessionStatus.WAITING_RESET -> s.resumeAt?.takeIf { it > 0 }?.let { "Resumes ${clock(it)}" } ?: "Waiting for a limit"
        SessionStatus.PAUSED -> "Paused"
        SessionStatus.IDLE -> null
    }
}
