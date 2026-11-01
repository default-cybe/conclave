package dev.conclave.client.logic

import dev.conclave.client.ConnectionState
import dev.conclave.client.model.Device
import dev.conclave.client.model.Project
import dev.conclave.client.model.Session
import dev.conclave.client.model.obj
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/*
 * The side panel, kept simple as in the Claude app: New and Search, the
 * Chat, Assistant and Code switch, the conversations of that mode in groups
 * (Group by: project, device or time), Delegated work (a Delegate call's
 * sessions, in every mode), and the account row that opens Settings. Every
 * other page lives in Settings. Kept here so the grouping and the search
 * are tested without a device.
 */

/** Group by in the side panel. */
enum class GroupBy(val wire: String, val label: String) {
    /** One group per project across devices; a session with no project goes under its folder. */
    PROJECT("project", "Project"),

    /** One group per device the session runs on. */
    DEVICE("device", "Device"),

    /** Today, Yesterday, This week, Older. */
    TIME("time", "Time"),
    ;

    companion object {
        /** The stored choice; Project when nothing, or something unknown, is stored. */
        fun from(wire: String?): GroupBy = entries.firstOrNull { it.wire == wire } ?: PROJECT
    }
}

/** One group of the side panel: its title and its conversations, newest first. */
data class DrawerGroup(val key: String, val title: String, val items: List<Recent>)

/**
 * A row of Delegated work: the title, who did it and where ("Code on MadX
 * Arch"), where it came from as a quiet second line ("from Capstone chat";
 * null when that conversation is gone), and its dot.
 */
data class DelegatedRow(val id: String, val title: String, val who: String, val from: String?, val dot: RecentDot)

/**
 * Delegated work (docs/DESIGN.md 43): a session a Delegate call started runs
 * under its caller, marked as a subagent and tagged "delegated", with
 * meta.delegate saying where it ran. Move to main list clears the marks,
 * keeps parentId for history and keeps meta.delegate as meta.movedFrom; from
 * then on it is a normal session of its kind. The hub's
 * core/src/session/delegated.ts, the same rules.
 */
object Delegated {
    /** The group's name. */
    const val WORDS = "Delegated work"

    /** The action in the session's menu, the same words as the web. */
    const val MOVE = "Move to main list"

    /** How many rows the group lists at most. */
    const val LIMIT = 30

    /** It moved to the main list: a normal session now, whatever its parentId says. */
    fun moved(s: Session): Boolean = s.meta?.obj("movedFrom") != null

    /** A Delegate call's session still in Delegated work. */
    fun isDelegated(s: Session): Boolean = !moved(s) && (s.meta?.obj("delegate") != null || "delegated" in s.tags)

    /** It runs under another session (a subagent, a workflow's agent, delegated work); a moved one stands on its own. */
    fun underParent(s: Session): Boolean = s.parentId != null && !moved(s)

    /** Where its job ran: meta.delegate, or meta.movedFrom once it moved. */
    fun mark(s: Session?): JsonObject? = s?.meta?.obj("delegate") ?: s?.meta?.obj("movedFrom")

    /** "Code on MadX Arch", "Assistant on homelab": the device by its name now, else the name the call saw. */
    fun who(s: Session, devices: Map<String, Device>): String {
        val to = mark(s)?.string("to")
        val who = if (to == "assistant" || (to == null && Start.modeOf(s) == StartMode.ASSISTANT)) "Assistant" else "Code"
        val where = devices[s.device]?.name?.trim()?.ifEmpty { null } ?: mark(s)?.string("deviceName")?.ifBlank { null } ?: s.device.ifBlank { null }
        return if (where != null) "$who on $where" else who
    }

    /** "from Capstone chat", "from Plan my week in Assistant", "from Fix auth in Code". Null when the conversation is gone. */
    fun from(parent: Session?): String? {
        parent ?: return null
        val mode = Start.modeOf(parent)
        val title = parent.title.trim().ifEmpty { if (mode == StartMode.CHAT) "a chat" else "a session" }
        return when (mode) {
            StartMode.CHAT -> if (Regex("\\bchat$", RegexOption.IGNORE_CASE).containsMatchIn(title)) "from $title" else "from $title chat"
            StartMode.ASSISTANT -> "from $title in Assistant"
            StartMode.CODE -> "from $title in Code"
        }
    }
}

/** The account row at the foot of the side panel: the avatar's letter, the name, and the hub's state. */
data class Account(val initial: String, val name: String, val line: String)

object Drawer {
    /** Pinned conversations, first whatever the grouping. */
    const val PINNED = "pinned"

    /** Chats, by project: they have no folder. Last. */
    const val CHATS = "chats"

    /** Sessions with no project and no folder (the home folder counts as none). Last. */
    const val NO_PROJECT = "none"

    /** The Assistant home thread (meta.home), first in Assistant mode. */
    const val HOME = "home"

    /** Every other assistant session once a home thread exists. */
    const val HISTORY = "history"

    /** The account's one Assistant thread, from GET /api/assistant/home: meta.home is true. */
    fun isHome(s: Session): Boolean = (s.meta?.get("home") as? JsonPrimitive)?.booleanOrNull == true

    /** The home thread among [sessions], not archived. Null on an older hub that has none. */
    fun homeOf(sessions: List<Session>): Session? = sessions.firstOrNull { isHome(it) && !it.archived }

    /**
     * The conversations of [mode] (all of them when null) in groups by [by]:
     * Pinned first, then the groups newest first, each newest first. By
     * project, chats and sessions without a folder go last. Archived
     * sessions, subagents and a workflow's own agents are left out, as in
     * the recents. [waiting] holds the sessions an approval or question
     * belongs to, for their dot. [query] (Search) keeps the conversations
     * whose title has it, or for a session its agent, its folder or its
     * group's name. In Assistant mode with a home thread, it comes first as
     * "Assistant" and every other assistant session goes under History.
     */
    fun groups(
        sessions: List<Session>,
        mode: StartMode?,
        by: GroupBy,
        waiting: Set<String> = emptySet(),
        projects: List<Project> = emptyList(),
        devices: List<Device> = emptyList(),
        query: String = "",
        now: Long = System.currentTimeMillis(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<DrawerGroup> {
        val needle = query.trim().lowercase()
        val list = sessions
            .filter { Panel.shown(it) && (mode == null || Start.modeOf(it) == mode) }
            .sortedByDescending { it.updatedAt }
        val byProject = projects.associateBy { it.id }
        val byDevice = devices.associateBy { it.id }
        val home = if (mode == StartMode.ASSISTANT) homeOf(list) else null
        val out = LinkedHashMap<String, Pair<String, MutableList<Recent>>>()
        for (s in list) {
            val (key, title) = when {
                home != null && s.id == home.id -> HOME to "Assistant"
                home != null -> HISTORY to "History"
                s.pinned -> PINNED to "Pinned"
                by == GroupBy.PROJECT -> projectGroup(s, byProject, byDevice)
                by == GroupBy.DEVICE -> deviceGroup(s, byDevice)
                else -> timeGroup(s.updatedAt, now, zone)
            }
            // a project's or a device's name finds its sessions; Today, Pinned or No project does not
            if (needle.isNotEmpty() && !matches(s, needle, if (key.startsWith("p:") || key.startsWith("d:")) title else "")) continue
            out.getOrPut(key) { title to ArrayList() }.second.add(Recent(s.id, Panel.title(s), s.isChat, Panel.dot(s, s.id in waiting)))
        }
        val groups = out.map { (k, v) -> DrawerGroup(k, v.first, v.second) }
        val first = groups.filter { it.key == HOME } + groups.filter { it.key == PINNED }
        val last = setOf(HOME, PINNED, CHATS, NO_PROJECT)
        // imported chats not continued yet: a group of their own, last, by their original date (Imported.kt)
        val imported = sessions
            .filter { Imported.inImported(it) && !Delegated.underParent(it) && (mode == null || Start.modeOf(it) == mode) && (needle.isEmpty() || matches(it, needle, "")) }
            .sortedByDescending { Imported.date(it) }
            .take(Imported.LIMIT)
            .map { s -> Recent(s.id, Panel.title(s), s.isChat, Panel.dot(s, s.id in waiting), Imported.label(s, now, zone)) }
        val tail = if (imported.isEmpty()) emptyList() else listOf(DrawerGroup(Imported.KEY, Imported.WORDS, imported))
        return first + groups.filter { it.key !in last } + groups.filter { it.key == NO_PROJECT } + groups.filter { it.key == CHATS } + tail
    }

    /**
     * Delegated work, in every mode: the sessions Delegate calls started
     * that are not archived and not moved to the main list, newest first,
     * at most [limit]. [query] (Search) keeps the rows whose title, who and
     * where, or the conversation it came from has it.
     */
    fun delegated(
        sessions: List<Session>,
        waiting: Set<String> = emptySet(),
        devices: List<Device> = emptyList(),
        query: String = "",
        limit: Int = Delegated.LIMIT,
    ): List<DelegatedRow> {
        val needle = query.trim().lowercase()
        val byId = sessions.associateBy { it.id }
        val byDevice = devices.associateBy { it.id }
        return sessions
            .filter { !it.archived && Delegated.isDelegated(it) }
            .sortedByDescending { it.updatedAt }
            .map { s -> DelegatedRow(s.id, Panel.title(s), Delegated.who(s, byDevice), Delegated.from(s.parentId?.let { byId[it] }), Panel.dot(s, s.id in waiting)) }
            .filter { r -> needle.isEmpty() || listOfNotNull(r.title, r.who, r.from).any { it.lowercase().contains(needle) } }
            .take(limit)
    }

    /** Search: the title, and for a session its agent, its folder and its group (a project or device name). */
    private fun matches(s: Session, needle: String, group: String): Boolean {
        if (Panel.title(s).lowercase().contains(needle)) return true
        if (s.isChat) return false
        return s.agent.lowercase().contains(needle) || lastSegment(s.cwd).lowercase().contains(needle) || group.lowercase().contains(needle)
    }

    /** Today, Yesterday, This week (the 7 days before), Older. */
    fun timeGroup(ts: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): Pair<String, String> {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val day = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(day, today)
        return when {
            days <= 0L -> "today" to "Today"
            days == 1L -> "yesterday" to "Yesterday"
            days < 7L -> "week" to "This week"
            else -> "older" to "Older"
        }
    }

    /**
     * The group of a session by project (the web's projectGroupOf): its
     * project; else the project with a location on its device that holds its
     * folder; else its folder's name. Chats go under Chats, and sessions with
     * no folder under No project.
     */
    fun projectGroup(s: Session, projects: Map<String, Project>, devices: Map<String, Device> = emptyMap()): Pair<String, String> {
        if (s.isChat) return CHATS to "Chats"
        val home = devices[s.device]?.info?.home?.ifBlank { null }
        val none = noFolder(s.cwd, home)
        val cwd = expandHome(s.cwd, home)
        val folder = lastSegment(cwd)
        s.projectId?.let { id -> projects[id] }?.let { p -> return "p:${p.id}" to p.name.trim().ifEmpty { folder.ifEmpty { "Project" } } }
        if (!none) {
            // a project that has a location on this device holding the folder, the deepest one
            var best: Pair<Project, Int>? = null
            for (p in projects.values) {
                for (l in p.locations) {
                    if (l.device != s.device || l.path.isBlank() || !inside(cwd, l.path)) continue
                    val len = trim(l.path).length
                    if (best == null || len > best.second) best = p to len
                }
            }
            best?.let { (p, _) -> return "p:${p.id}" to p.name.trim().ifEmpty { folder } }
        }
        if (none) return NO_PROJECT to "No project"
        // a project the list has not loaded yet still keeps its sessions together
        if (s.projectId != null) return "p:${s.projectId}" to folder
        return "f:${folder.lowercase()}" to folder
    }

    /** The group of a session by device: the device's name, "Hub" for the hub itself when it has none. */
    fun deviceGroup(s: Session, devices: Map<String, Device>): Pair<String, String> {
        val id = s.device.ifBlank { "local" }
        val name = devices[id]?.name?.trim()?.ifEmpty { null } ?: if (id == "local") "Hub" else id
        return "d:$id" to name
    }

    /**
     * The account row: the owner's name with "home · online" under it; with
     * no name set, the hub's name with its state alone ("Online").
     */
    fun account(owner: String?, hub: String?, state: ConnectionState, noNetwork: Boolean = false): Account {
        val who = owner?.trim()?.ifEmpty { null }
        val hubName = hub?.trim()?.ifEmpty { null }
        val name = who ?: hubName ?: "Hub"
        val line = if (who != null) {
            HubLine.text(hubName, state, noNetwork)
        } else {
            HubLine.text(hubName, state, noNetwork).substringAfter(" · ").replaceFirstChar { it.uppercase() }
        }
        return Account(initial(name), name, line)
    }

    /** The avatar's letter: the name's first letter or digit, upper case. */
    fun initial(name: String): String {
        val i = name.indexOfFirst { it.isLetterOrDigit() }
        if (i >= 0) return String(Character.toChars(Character.toUpperCase(name.codePointAt(i))))
        val t = name.trim()
        return if (t.isEmpty()) "?" else String(Character.toChars(t.codePointAt(0)))
    }

    private fun trim(p: String): String = if (p.length > 1) p.trimEnd('/', '\\') else p

    private fun expandHome(cwd: String, home: String?): String = when {
        home == null -> trim(cwd)
        cwd == "~" -> trim(home)
        cwd.startsWith("~/") -> trim(trim(home) + "/" + cwd.substring(2))
        else -> trim(cwd)
    }

    private fun inside(path: String, root: String): Boolean {
        val r = trim(root)
        return path == r || path.startsWith("$r/") || path.startsWith("$r\\")
    }

    /** No folder says nothing about the work: none, the home folder, or the root. */
    private fun noFolder(cwd: String, home: String?): Boolean {
        if (cwd.isBlank() || cwd == "~" || cwd == "/" || cwd == ".") return true
        return home != null && trim(cwd) == trim(home)
    }

    private fun lastSegment(path: String): String = trim(path).split('/', '\\').lastOrNull { it.isNotEmpty() } ?: path
}
