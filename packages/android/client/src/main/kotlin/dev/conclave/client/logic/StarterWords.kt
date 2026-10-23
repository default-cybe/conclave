package dev.conclave.client.logic

import dev.conclave.client.model.StarterLine
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The window starter's line on a plan's limit card, the same words as the
 * web's starterLine (src/lib/accounts.ts): "Next start 14:03. Started 09:00.",
 * "Stopped until tomorrow: 429.", "Paused: weekly limit used up until Tue
 * 10:00." Read only: the owner turns it on in the web app.
 */
object StarterWords {
    private val hm = DateTimeFormatter.ofPattern("HH:mm", Locale.US)
    private val dayHm = DateTimeFormatter.ofPattern("EEE HH:mm", Locale.US)
    private val dayMonth = DateTimeFormatter.ofPattern("d MMM", Locale.US)
    private const val WEEK = 7 * 86_400_000L

    private fun local(ts: Long, zone: ZoneId) = Instant.ofEpochMilli(ts).atZone(zone)

    /** Today "14:03", within the next 7 days "Tue 10:00", later "29 Oct". */
    fun at(ts: Long, now: Long, zone: ZoneId): String {
        val d = local(ts, zone)
        if (d.toLocalDate() == local(now, zone).toLocalDate()) return d.format(hm)
        if (ts > now && ts - now < WEEK) return d.format(dayHm)
        return d.format(dayMonth)
    }

    /** "09:00" today, "yesterday 21:40", "22 Oct". */
    fun since(ts: Long, now: Long, zone: ZoneId): String {
        val d = local(ts, zone)
        val today = local(now, zone).toLocalDate()
        return when (d.toLocalDate()) {
            today -> d.format(hm)
            today.minusDays(1) -> "yesterday ${d.format(hm)}"
            else -> d.format(dayMonth)
        }
    }

    private fun until(ts: Long, now: Long, zone: ZoneId): String {
        val d = local(ts, zone)
        val today = local(now, zone).toLocalDate()
        return when (d.toLocalDate()) {
            today -> d.format(hm)
            today.plusDays(1) -> "tomorrow"
            else -> at(ts, now, zone)
        }
    }

    /** The line, or null when there is nothing to say. */
    fun line(s: StarterLine, now: Long, zone: ZoneId = ZoneId.systemDefault()): String? = when (s.state) {
        "scheduled" ->
            if (s.reason != null) {
                "Failed: ${s.reason.lowercase(Locale.US)}. Next try ${s.nextAt?.let { at(it, now, zone) } ?: "soon"}."
            } else {
                // a time already past means it goes now
                listOfNotNull(s.nextAt?.let { if (it <= now) "Starting now." else "Next start ${at(it, now, zone)}." }, s.startedAt?.let { "Started ${since(it, now, zone)}." }).joinToString(" ").ifBlank { null }
            }
        "checking" -> "Sent its request. Checking that the window started."
        "stopped" -> "Stopped until ${s.until?.let { until(it, now, zone) } ?: "tomorrow"}: ${s.reason ?: "error"}."
        "paused" -> "Paused: weekly limit used up${s.until?.let { " until ${at(it, now, zone)}" } ?: ""}."
        "never" -> "This plan has no 5-hour window, so there is nothing to start."
        "setup" -> if (s.reason == "Cannot pin a request to it") "Cannot reach this account alone. Give it a short name in Settings > Models > Accounts." else "${s.reason ?: "Cannot run as set"}."
        "waiting" -> when (s.reason) {
            "No usage read yet" -> "Waiting for the first usage read."
            "Account paused" -> "Waits while the account is paused."
            else -> "Waiting: ${s.reason ?: "not signed in"}."
        }
        else -> null
    }
}
