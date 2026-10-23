package dev.conclave.client.logic

import dev.conclave.client.model.ReflectInfo
import dev.conclave.client.model.ReflectRun
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Settings > Reflect in words, as the web's features/settings/reflectWords.ts. */
object ReflectWords {
    /** What it does and what it costs, in one line (docs/ASSISTANT.md, Nightly reflection). */
    const val LINE =
        "Each night it reads the chats you wrote in since the last run, only your words and the assistant's text, and keeps at most 3 notes on how to work with you. About \$0.07 a night on the default model, about \$0.005 on the small model; nights without chats cost nothing."

    private val HHMM = DateTimeFormatter.ofPattern("HH:mm", Locale.US)
    private val DAY = DateTimeFormatter.ofPattern("d MMM", Locale.US)

    private fun at(ts: Long, now: Long, zone: ZoneId): String {
        val t = Instant.ofEpochMilli(ts).atZone(zone)
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        return when (t.toLocalDate()) {
            today -> HHMM.format(t)
            today.minusDays(1) -> "yesterday ${HHMM.format(t)}"
            else -> "${DAY.format(t)} ${HHMM.format(t)}"
        }
    }

    private fun lower(s: String) = s.trimEnd('.').replaceFirstChar { it.lowercase() }

    /** "Last ran 02:40, saved 2 notes, retired 1." */
    fun lastRun(last: ReflectRun?, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        if (last == null) return "Has not run yet."
        val time = at(last.startedAt, now, zone)
        return when (last.status) {
            "running" -> "Running since $time."
            "skipped" -> "Last ran $time, skipped: ${lower(last.reason ?: "nothing new")}."
            "error" -> "Last ran $time and failed: ${(last.reason ?: "error").trimEnd('.')}."
            else -> {
                if (last.saved == 0 && last.retired == 0) return "Last ran $time, nothing new to keep."
                val parts = listOfNotNull(
                    if (last.saved > 0) "saved ${last.saved} ${if (last.saved == 1) "note" else "notes"}" else "saved none",
                    if (last.retired > 0) "retired ${last.retired}" else null,
                )
                "Last ran $time${if (last.trigger == "manual") " (Reflect now)" else ""}, ${parts.joinToString(", ")}."
            }
        }
    }

    /** "Every night at 02:40, Europe/Berlin." and whether it is off. */
    fun time(r: ReflectInfo): String {
        val at = if (r.time != null) "Every night at ${r.time}, ${r.timezone}." else "On the schedule ${r.schedule}, ${r.timezone}, set on Routines."
        return if (r.enabled) at else "$at Off for now."
    }

    /** The model in words. */
    fun model(model: String?): String = when {
        model.isNullOrBlank() -> "The default model"
        model == "fast" -> "The small model"
        else -> ModelRefs.displayName(model)
    }
}
