package dev.conclave.client.logic

import dev.conclave.client.model.Meeting
import dev.conclave.client.model.MeetingFolder
import dev.conclave.client.model.PrepProgress
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The Meetings page on the phone (docs/design/MEETING-MODE.md 11.2, 11.9):
 * the Now, Upcoming and Past sections, the countdown and the words, the
 * same rules as the web's features/meeting/time.ts.
 */
object Meetings {
    private const val MIN = 60_000L
    private const val HOUR = 60 * MIN
    private const val DAY = 24 * HOUR

    /** A ready meeting this close to its start (either way) is Now; past this late, never started, it is Past. */
    const val NOW_WINDOW = 15 * MIN
    const val NOT_HELD_AFTER = 3 * HOUR

    data class Sections(val now: List<Meeting>, val upcoming: List<Meeting>, val past: List<Meeting>) {
        val isEmpty: Boolean get() = now.isEmpty() && upcoming.isEmpty() && past.isEmpty()
    }

    private val RUNNING = setOf("live", "paused", "ending", "preparing")

    /** The three sections of 11.2. A status a newer hub adds shows under Now, so it is never lost. */
    fun sections(meetings: List<Meeting>, now: Long): Sections {
        val nowList = ArrayList<Meeting>()
        val upcoming = ArrayList<Meeting>()
        val past = ArrayList<Meeting>()
        for (m in meetings.distinctBy { it.id }) {
            val at = m.scheduledAt
            when {
                m.status == "ended" || m.status == "failed" -> past += m
                m.status in RUNNING -> nowList += m
                m.status == "scheduled" || m.status == "ready" -> when {
                    at != null && now - at > NOT_HELD_AFTER -> past += m
                    m.status == "ready" && (at == null || at - now <= NOW_WINDOW) -> nowList += m
                    else -> upcoming += m
                }
                else -> nowList += m
            }
        }
        return Sections(
            now = nowList.sortedByDescending { it.startedAt ?: it.createdAt },
            upcoming = upcoming.sortedBy { it.scheduledAt ?: Long.MAX_VALUE },
            past = past.sortedByDescending { pastKey(it) },
        )
    }

    /** Past is newest first by this, and pages with ?before= of the last one. */
    fun pastKey(m: Meeting): Long = m.startedAt ?: m.scheduledAt ?: m.createdAt

    /** Scheduled or ready, never started, more than 3 hours past its start. */
    fun notHeld(m: Meeting, now: Long): Boolean {
        val at = m.scheduledAt ?: return false
        return (m.status == "scheduled" || m.status == "ready") && m.startedAt == null && now - at > NOT_HELD_AFTER
    }

    /**
     * The time slot of 11.2 for [ms] until the start (negative once it has
     * passed). [start] and [zone] give "tomorrow 10:00".
     */
    fun countdown(ms: Long, start: Long = 0, zone: ZoneId = ZoneId.of("UTC")): String = when {
        ms >= 2 * DAY -> {
            val d = ms / DAY
            "in $d days"
        }
        ms >= DAY -> "tomorrow ${clock(start, zone)}"
        ms >= HOUR -> "in ${ms / HOUR}h ${two((ms % HOUR) / MIN)}m"
        ms >= 10 * MIN -> "in ${ms / MIN}m"
        ms > 0 -> {
            val s = (ms + 999) / 1000
            "in ${s / 60}:${two(s % 60)}"
        }
        ms >= -NOW_WINDOW -> "now"
        else -> "started ${ago(-ms)} ago"
    }

    /** How often a countdown changes: every second under 10 minutes, else every minute. */
    fun tickMs(ms: Long): Long = if (ms in 1 until 10 * MIN) 1_000 else 60_000

    private fun ago(ms: Long): String = when {
        ms < HOUR -> "${ms / MIN}m"
        ms < DAY -> "${ms / HOUR}h"
        else -> "${ms / DAY}d"
    }

    private fun two(n: Long) = n.toString().padStart(2, '0')

    /** The status word and its tone, the web's STATUS_WORD. Not held wins over the stored status. */
    fun statusWord(m: Meeting, now: Long): Pair<String, StateTone> {
        if (notHeld(m, now)) return "Not held" to StateTone.DIM
        return when (m.status) {
            "scheduled" -> "Scheduled" to StateTone.NEUTRAL
            "preparing" -> "Preparing" to StateTone.SIGNAL
            "ready" -> "Ready" to StateTone.NEUTRAL
            "live" -> "Listening" to StateTone.FAULT
            "paused" -> "Paused" to StateTone.WARN
            "ending" -> "Writing notes" to StateTone.SIGNAL
            "ended" -> "Ended" to StateTone.DIM
            "failed" -> "Failed" to StateTone.FAULT
            else -> m.status.replaceFirstChar { it.uppercase() } to StateTone.NEUTRAL
        }
    }

    /** The prep word on an Upcoming row (11.2): Not prepared, Preparing 34/120, Prepared, Edited, Prep failed. */
    fun prepWord(m: Meeting): Pair<String, StateTone> = when (m.prepState) {
        "queued" -> "Preparing" to StateTone.SIGNAL
        "running" -> m.prepProgress?.takeIf { it.total > 0 }?.let { "Preparing ${it.done}/${it.total}" to StateTone.SIGNAL } ?: ("Preparing" to StateTone.SIGNAL)
        "waiting" -> "Needs your OK" to StateTone.WARN
        "done" -> if (m.prepEditedAt != null) "Edited" to StateTone.NEUTRAL else "Prepared" to StateTone.NEUTRAL
        "failed" -> "Prep failed" to StateTone.FAULT
        // none, cancelled, and a state a newer hub adds; edits kept after a cancel still count
        else -> if (m.prepEditedAt != null) "Edited" to StateTone.NEUTRAL else "Not prepared" to StateTone.DIM
    }

    fun prepRunning(state: String): Boolean = state == "queued" || state == "running"

    /** "Reading chats 34 of 120 · about 6 min left": the time left is a straight line from [PrepProgress.startedAt]. */
    fun progressLine(p: PrepProgress?, now: Long): String {
        if (p == null) return "Preparing"
        val what = when (p.phase) {
            "inventory" -> return "Finding chats, code and notes"
            "waiting-approval" -> return "Waiting for your OK"
            "map" -> "Reading chats"
            "merge" -> "Merging months"
            "reduce" -> return "Writing the prep"
            "done" -> return "Done"
            else -> "Preparing"
        }
        if (p.total <= 0) return what
        val line = "$what ${p.done} of ${p.total}"
        val started = p.startedAt ?: return line
        if (p.done <= 0 || p.done >= p.total || now <= started) return line
        val left = (now - started) * (p.total - p.done) / p.done
        val min = ((left + MIN - 1) / MIN).coerceAtLeast(1)
        return "$line · about $min min left"
    }

    /** 0..1 for the meter, or null when there is nothing to count yet. */
    fun progressFraction(p: PrepProgress?): Float? = p?.takeIf { it.total > 0 }?.let { (it.done.toFloat() / it.total).coerceIn(0f, 1f) }

    private val CLOCK = DateTimeFormatter.ofPattern("HH:mm", Locale.UK)
    private val DAY_WORDS = DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK)

    fun clock(ts: Long, zone: ZoneId): String = CLOCK.format(Instant.ofEpochMilli(ts).atZone(zone))

    /** "Mon 2 Nov, 10:00 to 11:00", or "Mon 2 Nov, 10:00" without a duration. */
    fun whenWords(start: Long, durationMin: Int?, zone: ZoneId): String {
        val head = "${DAY_WORDS.format(Instant.ofEpochMilli(start).atZone(zone))}, ${clock(start, zone)}"
        return if (durationMin != null && durationMin > 0) "$head to ${clock(start + durationMin * MIN, zone)}" else head
    }

    /** The last part of a path: "/home/me/capstone" is "capstone". */
    fun folderName(cwd: String): String = cwd.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifBlank { cwd }

    /** "Capstone · MacBook": the folder and the device's name. */
    fun place(m: Meeting, deviceName: (String) -> String?): String =
        listOfNotNull(folderName(m.cwd).ifBlank { null }, (deviceName(m.device) ?: m.device).ifBlank { null }).joinToString(" · ")

    /** The meta line of an Upcoming row: "Mon 2 Nov, 10:00 to 11:00 · Capstone · MacBook". */
    fun upcomingMeta(m: Meeting, zone: ZoneId, deviceName: (String) -> String?): String =
        listOfNotNull(m.scheduledAt?.let { whenWords(it, m.durationMin, zone) }, place(m, deviceName).ifBlank { null }).joinToString(" · ")

    /** The zone a meeting's times read in: its own, then the owner's, then the phone's. */
    fun zoneOf(m: Meeting?, owner: String?): ZoneId = zone(m?.tz) ?: zone(owner) ?: ZoneId.systemDefault()

    fun zone(id: String?): ZoneId? = id?.takeIf { it.isNotBlank() }?.let {
        try {
            ZoneId.of(it)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * The side panel's trailing words (11.1): "Live" while one listens, else
     * the countdown to the soonest upcoming one within a day, else null.
     */
    fun panelMeta(meetings: List<Meeting>, now: Long): String? {
        if (meetings.any { it.status == "live" || it.status == "paused" }) return "Live"
        val next = sections(meetings, now).upcoming.firstOrNull()?.scheduledAt ?: return null
        val ms = next - now
        return if (ms in 1 until DAY) countdown(ms) else null
    }

    /** One folder choice: "capstone · MacBook · 214 chats". */
    fun folderLabel(f: MeetingFolder): String = listOfNotNull(
        (f.projectName?.ifBlank { null } ?: folderName(f.cwd)),
        f.deviceName.ifBlank { f.device }.ifBlank { null },
        if (f.chats == 1) "1 chat" else "${f.chats} chats",
    ).joinToString(" · ")

    /** The folders matching a filter on the folder name, path, project and device. */
    fun filterFolders(folders: List<MeetingFolder>, q: String): List<MeetingFolder> {
        val t = q.trim().lowercase()
        if (t.isEmpty()) return folders
        return folders.filter { f -> listOf(f.cwd, f.projectName.orEmpty(), f.deviceName, f.device).any { t in it.lowercase() } }
    }

    // the form's rules (11.3): reminders and durations it offers, and the limits
    val REMINDERS = listOf(1440 to "1 day before", 60 to "1 hour before", 15 to "15 minutes before")
    val DURATIONS = listOf(15, 30, 45, 60, 90, 120)
    const val TITLE_MAX = 200
    const val TEXT_MAX = 4000
    const val PREP_MAX = 60_000

    /** Why the start time cannot be used, or null: at least 5 minutes ahead and at most 365 days. */
    fun startProblem(start: Long, now: Long): String? = when {
        start < now + 5 * MIN -> "Pick a time at least 5 minutes from now."
        start > now + 365 * DAY -> "Pick a time within a year."
        else -> null
    }

    /** True while the schedule can still move: scheduled, or ready with no desktop listening yet (11.6). */
    fun canReschedule(m: Meeting): Boolean = m.status == "scheduled" || (m.status == "ready" && m.audioClientId == null)
}
