package dev.conclave.client.map

import dev.conclave.client.model.MapDevice
import dev.conclave.client.model.MapGroup
import dev.conclave.client.model.MapNode
import dev.conclave.client.model.MapNodeKind
import dev.conclave.client.model.MapSnapshot
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * A node's words on the Map, the same as the web's features/map/model.ts
 * (mapLabel, modeWord, whenWords, nodeMeta, nodePlace): a short name from
 * its title, and the line under it. Pure, tested in MapLabelsTest.
 */

/** The line under a node's name: what it is, its state, and when for one that rests. */
data class NodeMeta(val mode: String, val word: String, val time: String? = null)

/** The names around a node that its label leaves out: its project or folder, and its device. */
data class NodePlace(val group: String? = null, val device: String? = null)

object MapLabels {
    const val MAX_WORDS = 5

    /** About what fits the label's 184dp at 13sp, when no measure is given. */
    const val MAX_CHARS = 30

    /** Titles that say nothing about the work: the fallback names it instead. */
    private val EMPTY_TITLE = Regex(
        """^(new chat|untitled|conclave chat|continue previous \w+ chat|continued in [\w ]+ on .*|session continued from (the )?prior context)$""",
        RegexOption.IGNORE_CASE,
    )

    /** Openers of a raw first prompt that carry no meaning. */
    private val FILLER = Regex(
        """^(yo|hey|hi|hello|so|ok(ay)?|um+|please|pls|can you|could you|would you|i want you to|i need you to|i want to|help me)\b[\s,]*""",
        RegexOption.IGNORE_CASE,
    )
    private val STOP_END = Regex("""\s+(to|the|a|an|of|for|and|or|in|on|at|with|is|are|from|by|that|this|my)$""", RegexOption.IGNORE_CASE)

    private val SPACES = Regex("""\s+""")
    private val QUOTED = Regex("""\s*["“][^"”]*["”]?""")
    private val MARKS = Regex("""[*`“”"]+""")
    private val ELLIPSIS = Regex("""\s*\.\.\.$|\s*…$""")
    private val ASIDE = Regex("""\([^)]*\)?""")
    private val PATH = Regex("""(^|\s)(~|\.{1,2})?(/[^\s/]+)+/?""")
    private val WIN_PATH = Regex("""(^|\s)[A-Za-z]:\\\S*""")
    private val DATE = Regex("""\b\d{4}-\d\d-\d\d([T ]\d\d:\d\d(:\d\d)?\S*)?""")
    private val IDS = Regex("""\b(ses|chat|run|wf|wfr|dev|prj)_(?=[a-z]*\d)[a-z0-9]{8,}\b|\b[0-9a-f]{8,}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b""", RegexOption.IGNORE_CASE)
    private val SKIP = Regex("""^skip to (main )?content\b""", RegexOption.IGNORE_CASE)
    private val SENTENCE = Regex("""(?<=[?!.;])\s""")
    private val SLUG = Regex("""^[a-z0-9]+(-[a-z0-9]+)+$""")
    private val TAIL = Regex("""[\s.,;:!?\-–—]+$""")

    private fun cap(s: String): String = s.replaceFirstChar { it.uppercase() }

    private fun wordCount(s: String): Int = s.split(' ').size

    /** What a node is, in one word: Chat, Code, Assistant, Workflow, or the agent that runs it (Builder, Reviewer). */
    fun modeWord(kind: MapNodeKind, agent: String?): String {
        if (kind == MapNodeKind.CHAT) return "Chat"
        if (kind == MapNodeKind.WORKFLOW) return "Workflow"
        val a = agent ?: ""
        if (a == "assistant") return "Assistant"
        if (kind == MapNodeKind.SESSION && (a.isEmpty() || a == "coder" || a == "default")) return "Code"
        return if (a.isNotEmpty()) cap(a.replace(Regex("[-_]+"), " ")) else "Code"
    }

    /**
     * A node's name on the Map: 2 to 5 words from its title. Drops what the
     * marks around it already say (the project), what reads as noise (paths,
     * ids, timestamps, "Session continued from prior context", a pasted page's
     * "Skip to content") and cuts at a word. A title with nothing left gets
     * "<agent> chat on <device>". The full title stays on the node (the drawer).
     */
    fun mapLabel(
        title: String,
        kind: MapNodeKind,
        agent: String? = null,
        cwd: String? = null,
        group: String? = null,
        device: String? = null,
        fits: (String) -> Boolean = { it.length <= MAX_CHARS },
    ): String {
        var t = title.trim()
        // a quoted aside ("see this chat 5544") when words are left without it
        val unquoted = QUOTED.replace(t, " ").trim()
        if (unquoted.split(SPACES).size >= 2) t = unquoted
        t = SPACES.replace(MARKS.replace(t, " "), " ").trim()
        // "<workflow> / <step>": the run's mark already names the workflow
        val slash = t.lastIndexOf(" / ")
        if (slash > 0 && !t.substring(0, slash).contains(' ')) t = t.substring(slash + 3)
        // "<project> - ..." or "<project>: ..." when the project's mark is right there
        val names = listOfNotNull(group, cwd?.split('\\', '/')?.lastOrNull { it.isNotEmpty() }).filter { it.length > 1 }
        for (name in names) t = Regex("^" + Regex.escape(name) + """\s*(-|–|—|:|/)\s*""", RegexOption.IGNORE_CASE).replaceFirst(t, "")
        t = ELLIPSIS.replaceFirst(t, "")
        t = ASIDE.replace(t, " ") // asides, and one the cut left open
        t = PATH.replace(t) { m -> m.groupValues[1] + m.groupValues[3].drop(1) } // a path: its last part
        t = WIN_PATH.replace(t, " ")
        t = DATE.replace(t, " ")
        t = IDS.replace(t, " ")
        t = SKIP.replaceFirst(t, "")
        t = SPACES.replace(t, " ").trim()
        if (EMPTY_TITLE.containsMatchIn(t)) t = ""
        // a raw prompt: its first sentence, without the "so can you" opener
        if (wordCount(t) > MAX_WORDS) {
            val first = t.split(SENTENCE)[0]
            if (wordCount(first) >= 2) t = first
        }
        for (i in 0 until 3) {
            val less = FILLER.replaceFirst(t, "")
            if (wordCount(less) < 2) break
            t = less
        }
        if (SLUG.matches(t)) t = t.replace('-', ' ') // a slug: words
        val all = t.split(' ').filter { it.isNotEmpty() }
        var words = all.take(MAX_WORDS)
        while (words.size > 2 && !fits(words.joinToString(" "))) words = words.dropLast(1)
        // cut short: end at a clause ("Fix review findings: harness" reads as "Fix review findings")
        if (words.size < all.size) {
            val end = (1 until words.size - 1).lastOrNull { words[it].last() in ":,;" }
            if (end != null) words = words.take(end + 1)
        }
        t = words.joinToString(" ")
        var i = 0
        while (i < 3 && STOP_END.containsMatchIn(t) && wordCount(t) > 2) {
            t = STOP_END.replaceFirst(t, "")
            i++
        }
        t = TAIL.replaceFirst(t, "")
        if (t.isEmpty() || EMPTY_TITLE.containsMatchIn(t)) {
            val mode = modeWord(kind, agent)
            val who = if (kind == MapNodeKind.CHAT) "Chat" else if (mode == "Code") "Code chat" else "$mode chat"
            return if (!device.isNullOrEmpty()) "$who on $device" else who
        }
        return cap(t)
    }

    private val weekday = DateTimeFormatter.ofPattern("EEE", Locale.ENGLISH)
    private val dayMonth = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)

    /** "3h ago", "now", "Tue": when an idle node last did something. */
    fun whenWords(t: Long, now: Long): String {
        val d = now - t
        if (d < 45_000) return "now"
        if (d < 3_600_000) return "${Math.round(d / 60_000.0)}m ago"
        if (d < 86_400_000) return "${Math.round(d / 3_600_000.0)}h ago"
        val at = Instant.ofEpochMilli(t).atZone(ZoneId.systemDefault())
        return (if (d < 6 * 86_400_000L) weekday else dayMonth).format(at)
    }

    /** The line under a node's name: what it is, its state, and when for one that rests ("Code · idle · 3h ago"). */
    fun nodeMeta(n: MapNode, now: Long): NodeMeta {
        val word = MapWords.stuckWords(n, now) ?: MapWords.stateWord(n.state)
        val rests = !MapWords.isBusy(n.state) && (n.stuckSince ?: 0L) == 0L
        return NodeMeta(modeWord(n.kind, n.agent), word, if (rests) whenWords(n.endedAt ?: n.lastActivityAt, now) else null)
    }

    /** The names around a node that its label leaves out: its project or folder, and its device. */
    fun nodePlace(n: MapNode, snap: MapSnapshot): NodePlace = nodePlace(n, snap.hub.name, snap.groups, snap.devices)

    fun nodePlace(n: MapNode, hubName: String, groups: List<MapGroup>, devices: List<MapDevice>): NodePlace {
        val device = devices.firstOrNull { it.id == n.device }?.name ?: if (n.device == "local") hubName else n.device
        return NodePlace(groups.firstOrNull { it.id == n.group }?.name ?: n.group.split(':').last(), device)
    }
}
