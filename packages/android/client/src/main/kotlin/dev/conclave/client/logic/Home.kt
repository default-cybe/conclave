package dev.conclave.client.logic

import dev.conclave.client.model.LimitState
import dev.conclave.client.model.LimitWindow
import dev.conclave.client.model.Routine
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionMode
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunStatus
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToInt

/*
 * Home: a chat first, then a compact status (docs/design/SPEC.md 11.1). The
 * same rules as packages/web/src/features/home/status.ts, so the phone and the
 * browser say the same sentence.
 *
 *   "Two running. Two waiting on you."  then  "Claude Max blocked until 15:04."
 */

object Home {

    /** One to nine as words ("Two"), else the number. */
    fun countWord(n: Int, capital: Boolean = false): String {
        val w = listOf("no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine").getOrNull(n) ?: n.toString()
        return if (capital) w.replaceFirstChar { it.uppercaseChar() } else w
    }

    /** A part of the status sentence. Only the waiting part is amber. */
    data class Clause(val text: String, val warn: Boolean = false)

    /** Line one: running and waiting. Line two (quieter): the pressing limit, else the next routine. */
    data class Status(val first: List<Clause>, val second: Clause? = null)

    /** The hub does not answer: its name, and when the counts on screen were last known good ([at] null: this app never had them). */
    data class Offline(val name: String, val at: Long? = null)

    /** "Can't tell what needs you while homelab is offline." Nothing on screen came from the hub. */
    fun unknownWords(name: String): String = "Can't tell what needs you while $name is offline."

    /** "homelab is offline, so this is from 10:37." After counts that were last good at [at]. */
    fun staleWords(name: String, at: Long, clock: (Long) -> String): String = "$name is offline, so this is from ${clock(at)}."

    // ------------------------------------------------------------ sessions

    /** Agent sessions that run now or wait for a limit to reset. Chats are not runs. */
    fun running(sessions: List<Session>): List<Session> = sessions
        .filter { (it.status == SessionStatus.RUNNING || it.status == SessionStatus.WAITING_RESET) && !it.isChat && !it.archived }
        .sortedWith(compareBy<Session>({ it.status == SessionStatus.WAITING_RESET }, { it.createdAt }))

    /** The workflow run a session is one of the agents of, from the meta the run gives it (meta.workflow.runId). */
    fun workflowRunOf(s: Session): String? =
        ((s.meta?.get("workflow") as? JsonObject)?.get("runId") as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** Working now: the rows it lists besides the runs, and how many agents work. */
    data class Working(val sessions: List<Session>, val agents: Int)

    /**
     * Working now: a workflow's own agent sessions fold into its run's row,
     * and the count is of agents, not rows: each running session, and the
     * running calls of each running run (one while it is between calls).
     * [runs] are the live runs Home lists. The same rule as workingNow in
     * packages/web/src/features/home/status.ts.
     */
    fun workingNow(sessions: List<Session>, runs: List<WorkflowRun>): Working {
        val listed = runs.map { it.id }.toSet()
        val own = sessions.filter { s -> workflowRunOf(s).let { it == null || it !in listed } }
        val agents = runs.filter { it.status == WorkflowRunStatus.RUNNING }.sumOf { maxOf(1, it.counts.running) }
        return Working(own, own.count { it.status == SessionStatus.RUNNING } + agents)
    }

    /** The newest chats, by last use. */
    fun recentChats(sessions: List<Session>, count: Int): List<Session> =
        sessions.filter { it.isChat && !it.archived }.sortedByDescending { it.updatedAt }.take(count)

    /**
     * The last session the owner worked in by hand: not a chat, a routine
     * run, a subagent, a jury or a debate.
     */
    fun lastOwnSession(sessions: List<Session>): Session? = sessions
        .filter { !it.archived && it.routineId == null && !Delegated.underParent(it) && it.mode != SessionMode.JURY && it.mode != SessionMode.DEBATE && !it.isChat }
        .maxByOrNull { it.updatedAt }

    // ------------------------------------------------------------ limits

    /** Per-minute API rate windows are noise unless they are above 50%. */
    fun isRateWindow(w: LimitWindow): Boolean =
        Regex("""/\s*(min|minute|s|sec)\b|per[- ]minute|rpm|tpm""", RegexOption.IGNORE_CASE).containsMatchIn(w.name)

    /** Limits read from an API key's rate limit headers, as opposed to plans and subscriptions. */
    fun isApiLimit(l: LimitState): Boolean = l.source == "headers"

    /** Windows worth showing on Home: plans always, API and rate windows only when over 50%. */
    fun homeWindows(l: LimitState): List<LimitWindow> = l.windows.filter { w ->
        val pct = w.usedPercent ?: 0.0
        if (isRateWindow(w) || isApiLimit(l)) pct > 50 else true
    }

    fun limitPeak(l: LimitState): Double =
        if (l.blocked == true) 100.0 else l.windows.filterNot { isRateWindow(it) }.maxOfOrNull { it.usedPercent ?: 0.0 }?.coerceAtLeast(0.0) ?: 0.0

    /** The limits Home lists, the fullest first. */
    fun homeLimits(limits: List<LimitState>): List<LimitState> =
        limits.filter { homeWindows(it).isNotEmpty() }.sortedByDescending { limitPeak(it) }

    /** "5h" to "5 hours", "7d" to "Week", "requests / min" to "Requests per minute". */
    fun windowLabel(name: String): String {
        val n = name.trim().lowercase()
        if (n.isEmpty()) return ""
        val parts = n.split(Regex("""\s+"""))
        val map = mapOf("5h" to "5 hours", "1h" to "Hour", "24h" to "Day", "1d" to "Day", "daily" to "Day", "7d" to "Week", "weekly" to "Week", "week" to "Week", "monthly" to "Month", "30d" to "Month")
        map[parts[0]]?.let { base ->
            val extra = parts.drop(1).joinToString(" ").replace(Regex("""\bprompts?\b"""), "").trim()
            return if (extra.isNotEmpty()) "$base, ${extra.replaceFirstChar { it.uppercaseChar() }}" else base
        }
        val s = n.replace(Regex("""\s*/\s*min(ute)?\b"""), " per minute")
            .replace(Regex("""\s*/\s*day\b"""), " per day")
            .replace(Regex("""\s*/\s*h(our)?\b"""), " per hour")
        return s.replaceFirstChar { it.uppercaseChar() }
    }

    /** "Claude Max" to ("Claude", "Max"). Labels without a known brand stay whole. */
    fun planParts(label: String): Pair<String, String> {
        val clean = label.replace(Regex("""\s*·\s*"""), ", ")
        val m = Regex("""^(Claude|ChatGPT|Z\.ai|Gemini|Anthropic|OpenAI|Google|OpenRouter|GLM)\s+(.+)$""", RegexOption.IGNORE_CASE).find(clean)
        return if (m != null) m.groupValues[1] to m.groupValues[2] else clean to ""
    }

    /** Used percent of a window, 0 to 100, blocked counting as full. */
    fun percent(w: LimitWindow, blocked: Boolean): Int {
        if (blocked) return 100
        val used = w.usedPercent ?: w.limit?.takeIf { it > 0 }?.let { lim -> (1 - (w.remaining ?: 0.0) / lim) * 100 } ?: 0.0
        return used.roundToInt().coerceIn(0, 100)
    }

    data class Pressing(val limit: LimitState, val window: LimitWindow, val pct: Int, val blocked: Boolean)

    /** The limit closest to stopping work: blocked first, then the fullest window at or over [warn]. */
    fun pressingLimit(limits: List<LimitState>, warn: Int): Pressing? {
        var best: Pressing? = null
        fun score(p: Pressing) = p.pct + if (p.blocked) 1000 else 0
        for (l in limits) {
            for (w in homeWindows(l)) {
                val blocked = l.blocked == true && (w.usedPercent ?: 0.0) >= 99
                val pct = if (blocked) 100 else (w.usedPercent ?: 0.0).roundToInt()
                if (pct < warn) continue
                val p = Pressing(l, w, pct, blocked)
                if (best == null || score(p) > score(best)) best = p
            }
        }
        return best
    }

    private fun windowPhrase(name: String): String {
        val label = windowLabel(name)
        val map = mapOf("5 hours" to "5 hour window", "Week" to "weekly limit", "Day" to "daily limit", "Hour" to "hourly limit", "Month" to "monthly limit")
        map[label]?.let { return it }
        val m = Regex("""^(Week|Day|Month), (.+)$""").find(label)
        if (m != null) {
            val adj = mapOf("Week" to "weekly", "Day" to "daily", "Month" to "monthly")[m.groupValues[1]]
            return "$adj ${m.groupValues[2]} limit"
        }
        return "${label.lowercase()} limit"
    }

    private fun possessive(name: String) = if (name.endsWith("s")) "$name'" else "$name's"

    // ------------------------------------------------------------ routines and dates

    fun nextRoutine(routines: List<Routine>, now: Long): Routine? =
        routines.filter { it.enabled && (it.nextRunAt ?: 0) > now }.minByOrNull { it.nextRunAt ?: Long.MAX_VALUE }

    /** "at 09:00", "tomorrow at 09:00" or "Monday at 09:00". [clock] formats a time of day. */
    fun whenWords(ts: Long, now: Long, zone: ZoneId, clock: (Long) -> String): String {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val day = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()
        return when {
            !day.isAfter(today) -> "at ${clock(ts)}"
            day == today.plusDays(1) -> "tomorrow at ${clock(ts)}"
            else -> "${day.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ENGLISH)} at ${clock(ts)}"
        }
    }

    /** "Saturday 17 October". */
    fun longDate(ts: Long, zone: ZoneId): String {
        val d = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()
        return "${d.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ENGLISH)} ${d.dayOfMonth} ${d.month.getDisplayName(TextStyle.FULL, Locale.ENGLISH)}"
    }

    // ------------------------------------------------------------ the sentence

    /**
     * The status sentence. [running] leaves out sessions waiting for a reset;
     * [waiting] is approvals plus questions; [firstDay]: no agent session has
     * ever existed. [short] is the phone form ("Two running."). With [offline]
     * it says the counts are not known, or gives them with the time they
     * were good instead of the limit or the routine.
     */
    fun status(
        running: Int,
        waiting: Int,
        firstDay: Boolean,
        short: Boolean,
        limits: List<LimitState>,
        warn: Int,
        routines: List<Routine>,
        now: Long,
        zone: ZoneId,
        clock: (Long) -> String,
        offline: Offline? = null,
    ): Status {
        if (offline != null && offline.at == null) return Status(listOf(Clause(unknownWords(offline.name))))
        val first = ArrayList<Clause>()
        first += when {
            running == 0 -> Clause(if (firstDay) "Nothing running yet." else "Nothing running.")
            short -> Clause("${countWord(running, true)} running.")
            else -> Clause("${countWord(running, true)} ${if (running == 1) "session" else "sessions"} running.")
        }
        if (waiting > 0) {
            first += Clause(
                if (short) "${countWord(waiting, true)} waiting on you." else "${countWord(waiting, true)} ${if (waiting == 1) "is" else "are"} waiting on you.",
                warn = true,
            )
        }
        val stale = offline?.at
        if (offline != null && stale != null) return Status(first, Clause(staleWords(offline.name, stale, clock)))
        val p = pressingLimit(limits, warn)
        if (p != null) {
            val resets = p.window.resetsAt
            if (p.blocked && resets != null) {
                val plan = p.limit.label.replace(Regex("""\s*·.*$"""), "").ifBlank { p.limit.provider }
                return Status(first, Clause("$plan ${if (short) "blocked" else "is blocked"} until ${clock(resets)}."))
            }
            val brand = planParts(p.limit.label).first.ifBlank { p.limit.provider }
            return Status(first, Clause("${possessive(brand)} ${windowPhrase(p.window.name)} is at ${p.pct}%."))
        }
        val next = nextRoutine(routines, now)
        val at = next?.nextRunAt
        if (next != null && at != null) return Status(first, Clause("Next routine ${whenWords(at, now, zone, clock)}, ${next.name.ifBlank { "unnamed" }}."))
        return Status(first)
    }

    /**
     * The devices as one sentence: "arch-desktop online.", "Both devices
     * online." or "Two of three devices online, laptop offline." [devices]
     * is name to online.
     */
    fun devicesLine(devices: List<Pair<String, Boolean>>): String {
        val total = devices.size
        val online = devices.filter { it.second }.map { it.first }
        val offline = devices.filterNot { it.second }.map { it.first }
        return when {
            total == 0 -> "No devices paired yet."
            total == 1 -> "${devices[0].first} ${if (devices[0].second) "online" else "offline"}."
            offline.isEmpty() -> if (total == 2) "Both devices online." else "All ${countWord(total)} devices online."
            online.isEmpty() -> if (total == 2) "Both devices offline." else "All ${countWord(total)} devices offline."
            offline.size == 1 -> "${countWord(online.size, true)} of ${countWord(total)} devices online, ${offline[0]} offline."
            else -> "${countWord(online.size, true)} of ${countWord(total)} devices online."
        }
    }
}
