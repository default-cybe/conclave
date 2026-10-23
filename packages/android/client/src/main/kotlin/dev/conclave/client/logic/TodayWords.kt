package dev.conclave.client.logic

import dev.conclave.client.model.Proposal
import dev.conclave.client.model.Today
import dev.conclave.client.model.TodayEvent
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Words for the day plan on the phone (docs/DESIGN.md, Calendar and mail):
 * today's events and the proposal cards, in the owner's zone, the same words
 * as the web (packages/web/src/features/home/proposalWords.ts).
 */
object TodayWords {
    private val CLOCK = DateTimeFormatter.ofPattern("HH:mm", Locale.UK)
    private val DAY = DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK)

    fun zone(id: String?): ZoneId = try {
        ZoneId.of(id ?: "UTC")
    } catch (_: Exception) {
        ZoneId.of("UTC")
    }

    /** "18:00" in the zone. */
    fun clock(ts: Long, zone: ZoneId): String = CLOCK.format(Instant.ofEpochMilli(ts).atZone(zone))

    /** "Thu 22 Oct" in the zone. */
    fun day(ts: Long, zone: ZoneId): String = DAY.format(Instant.ofEpochMilli(ts).atZone(zone))

    /** "18:00 to 19:00", "All day", or with the day when it ends on another one. */
    fun range(start: Long, end: Long, allDay: Boolean, zone: ZoneId): String {
        if (allDay) return "All day"
        val a = Instant.ofEpochMilli(start).atZone(zone).toLocalDate()
        val b = Instant.ofEpochMilli(end - 1).atZone(zone).toLocalDate()
        return if (a == b) "${clock(start, zone)} to ${clock(end, zone)}" else "${clock(start, zone)} to ${day(end, zone)} ${clock(end, zone)}"
    }

    /** "Thu 22 Oct, 07:00 to 07:45" or "Thu 22 Oct, all day". */
    fun whenWords(start: Long, end: Long, allDay: Boolean, zone: ZoneId): String {
        if (allDay) {
            val days = Math.round((end - start) / 86_400_000.0)
            return if (days > 1) "${day(start, zone)} to ${day(end - 1, zone)}, all day" else "${day(start, zone)}, all day"
        }
        return "${day(start, zone)}, ${range(start, end, false, zone)}"
    }

    /**
     * Today's events in time order, all-day ones first, one per id: the
     * Today list keys its rows by id, and two rows with one key close the
     * app (a calendar can hold the same event twice, say one UID in two
     * files of a CalDAV calendar).
     */
    fun events(t: Today): List<TodayEvent> = (t.events ?: emptyList()).distinctBy { it.id }.sortedWith(compareBy({ !it.allDay }, { it.start }, { it.end }))

    /** The proposals waiting for the owner, one per id (the Today list keys its cards by id too). */
    fun pending(t: Today): List<Proposal> = t.proposals.filter { it.pending }.distinctBy { it.id }

    /** "Next: Gym at 18:00", "Now: Lecture, until 11:45", or the all-day one. */
    fun nextLine(t: Today, now: Long): String? {
        val z = zone(t.timezone)
        val list = events(t)
        val next = list.filter { !it.allDay }.firstOrNull { it.end > now }
        if (next != null) return if (next.start <= now) "Now: ${next.title}, until ${clock(next.end, z)}" else "Next: ${next.title} at ${clock(next.start, z)}"
        return list.firstOrNull { it.allDay }?.let { "Today: ${it.title}" }
    }

    /** "2 proposals to approve", or null. */
    fun waiting(t: Today): String? {
        val n = pending(t).size
        return when (n) {
            0 -> null
            1 -> "1 proposal to approve"
            else -> "$n proposals to approve"
        }
    }

    /** The card's question: "Add to Personal?", "Save this draft?". */
    fun question(p: Proposal): String {
        if (p.kind == "mail") return if (p.action == "send") "Send this message?" else "Save this draft?"
        val cal = p.event?.calendar?.ifBlank { null } ?: "the calendar"
        return when (p.action) {
            "create" -> "Add to $cal?"
            "update" -> "Change in $cal?"
            else -> "Delete from $cal?"
        }
    }

    /** The approve button. */
    fun approve(p: Proposal): String = if (p.kind == "mail") (if (p.action == "send") "Send" else "Save draft") else when (p.action) {
        "delete" -> "Delete"
        "update" -> "Change"
        else -> "Add"
    }

    /** What happens to invitations, or null. */
    fun invites(p: Proposal): String? {
        val e = p.event ?: return null
        if (e.attendees.isEmpty()) return null
        val who = e.attendees.joinToString(", ")
        return if (e.invites == "server") "Invites $who. The calendar sends the invitations." else "With $who. This calendar sends no invitations."
    }

    /** The lines of a card under its question: what the hub will write. */
    fun cardLines(p: Proposal, zone: ZoneId): List<String> {
        val e = p.event
        val m = p.mail
        return when {
            e != null -> listOfNotNull(
                e.title,
                whenWords(e.start, e.end, e.allDay, zone),
                p.before?.takeIf { p.action == "update" }?.let { "Was ${whenWords(it.start, it.end, it.allDay, zone)}" },
                listOfNotNull("${e.calendar}, ${e.account}", e.location, e.project?.let { "Booked on $it" }).joinToString(". "),
                invites(p),
            )
            m != null -> listOfNotNull(
                "To ${m.to.joinToString(", ")}${if (m.cc.isNotEmpty()) ", cc ${m.cc.joinToString(", ")}" else ""}",
                m.subject,
                m.body,
                "From ${m.from}",
            )
            else -> listOf(p.summary)
        }
    }

    /** After a decision: "Added", "Draft saved", "Declined", "Failed: ...". */
    fun outcome(p: Proposal): String = when (p.status) {
        "applied" -> if (p.kind == "mail") (if (p.action == "send") "Sent" else "Draft saved") else when (p.action) {
            "delete" -> "Deleted"
            "update" -> "Changed"
            else -> "Added"
        }
        "declined" -> "Declined"
        "failed" -> "Failed: ${p.error ?: "unknown error"}"
        else -> "Waiting for you"
    }
}
