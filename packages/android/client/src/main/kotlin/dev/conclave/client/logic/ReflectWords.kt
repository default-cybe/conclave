package dev.conclave.client.logic

import dev.conclave.client.model.ReflectExcluded
import dev.conclave.client.model.ReflectInfo
import dev.conclave.client.model.ReflectModels
import dev.conclave.client.model.ReflectReport
import dev.conclave.client.model.ReflectRhythm
import dev.conclave.client.model.ReflectTotals
import dev.conclave.client.model.ReflectRun
import java.time.Instant
import java.time.LocalDate
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

    // ----- the report (GET /api/reflect/report), as the web's reflectWords.ts

    private fun n(count: Int, one: String, many: String) = "$count ${if (count == 1) one else many}"

    /** The range switch: value to label. */
    val RANGES = listOf("week" to "Week", "month" to "Month", "3m" to "3 mo", "6m" to "6 mo", "12m" to "12 mo")

    val HABITS = mapOf(
        "delegation" to ("Delegation" to "What you hand off, and to whom"),
        "description" to ("Description" to "How clearly you set up the work"),
        "discernment" to ("Discernment" to "How you judge what comes back"),
        "diligence" to ("Diligence" to "How you check before it counts"),
    )

    /** "30 Oct to 5 Nov", "6 Nov 2025 to 5 Nov 2026", in the report's zone. */
    fun range(r: ReflectReport): String {
        val zone = runCatching { ZoneId.of(r.timezone) }.getOrDefault(ZoneId.of("UTC"))
        val a = Instant.ofEpochMilli(r.start).atZone(zone)
        val b = Instant.ofEpochMilli(r.end - 1).atZone(zone)
        val f = if (a.year == b.year) DAY else DateTimeFormatter.ofPattern("d MMM yyyy", Locale.US)
        return "${f.format(a)} to ${f.format(b)}"
    }

    /** "Made 2 h ago with your small model. ..." */
    fun made(r: ReflectReport, now: Long = System.currentTimeMillis()): String {
        val mins = Math.round((now - r.generatedAt) / 60_000.0)
        val at = when {
            mins < 1 -> "just now"
            mins < 60 -> "$mins min ago"
            mins < 24 * 60 -> "${Math.round(mins / 60.0)} h ago"
            else -> "on ${DAY.format(Instant.ofEpochMilli(r.generatedAt).atZone(ZoneId.systemDefault()))}"
        }
        return "Made $at${if (r.insights == "model") " with your small model" else " from the numbers only"}. It is made again each week, or when you press Refresh."
    }

    /** The big numbers: value to label. */
    fun bigNumbers(t: ReflectTotals): List<Pair<String, String>> = listOf(
        "${t.chats + t.sessions}" to "${n(t.chats, "chat", "chats")}, ${n(t.sessions, "session", "sessions")}",
        (if (t.hoursActive >= 10) "${Math.round(t.hoursActive)}" else "${t.hoursActive}".removeSuffix(".0")) to "hours active",
        Format.tokens(t.tokens) to (if (t.costUsd > 0) "tokens, ${Format.usd(t.costUsd)}" else "tokens"),
        "${t.projects}" to if (t.projects == 1) "project" else "projects",
    )

    /** 0 to 4 against the busiest hour. */
    fun heatLevel(v: Int, max: Int): Int = if (v == 0 || max == 0) 0 else minOf(4, Math.ceil(v * 4.0 / max).toInt())

    /** A gentle line when a fifth or more of your messages came late at night. */
    fun lateLine(share: Double, messages: Int): String? =
        if (share < 0.2 || messages < 20) null else "${Math.round(share * 100)}% of your messages came between 23:00 and 05:00. Quiet hours keep the hub from pinging you then."

    /** "Tue 3 Nov" from YYYY-MM-DD. */
    fun day(date: String): String = runCatching { DateTimeFormatter.ofPattern("EEE d MMM", Locale.US).format(LocalDate.parse(date)) }.getOrDefault(date)

    /** The stats line; the late-night share only when [lateLine] does not say it already. */
    fun rhythm(r: ReflectRhythm): String {
        val busiest = r.busiestDay?.let { ", busiest ${day(it.date)} with ${it.count} messages" } ?: ""
        val late = if (lateLine(r.lateNightShare, r.messages) != null) "" else " ${Math.round(r.lateNightShare * 100)}% late at night."
        return "${n(r.activeDays, "active day", "active days")}, longest streak ${n(r.longestStreak, "day", "days")}$busiest.$late"
    }

    /** A model ref with the model picker's name, and the provider when there is one: "Opus 5.5 · CLIProxy". */
    fun modelLine(ref: String): String {
        val p = ModelRefs.split(ref).provider
        return if (p.isEmpty()) ModelRefs.displayName(ref) else "${ModelRefs.displayName(ref)} \u00b7 ${ModelRefs.providerName(p)}"
    }

    /** "Agents: coder 4. 3 fallbacks, most often Opus 5.5 to Sonnet 5.5. About $0.012 per finished turn over 80 turns." */
    fun modelsLine(m: ReflectModels): String = listOfNotNull(
        if (m.agents.isNotEmpty()) "Agents: ${m.agents.joinToString(", ") { "${it.name} ${it.count}" }}." else null,
        if (m.fallbacks > 0) "${n(m.fallbacks, "fallback", "fallbacks")}${m.topFallback?.let { ", most often ${it.split(" to ").joinToString(" to ") { r -> ModelRefs.displayName(r) }}" } ?: ""}." else null,
        m.costPerResult?.let { "About ${Format.usd(it)} per finished turn over ${m.finishedTurns} turns." },
    ).joinToString(" ")

    /** The fun stats that have something to say: label to value. */
    fun funRows(r: ReflectReport): List<Pair<String, String>> {
        val f = r.`fun`
        return listOfNotNull(
            f.topTool?.let { "Most-used tool" to "${it.name}, ${it.count} calls" },
            f.longestChat?.let { "Longest chat" to "${it.title}, ${it.messages} messages from you" },
            f.biggestWorkflow?.let { "Biggest workflow" to "${it.name}, ${n(it.agents, "agent", "agents")}${if (it.costUsd > 0) ", ${Format.usd(it.costUsd)}" else ""}" },
            if (f.newPeople.isNotEmpty()) "New people" to f.newPeople.joinToString(", ") else null,
            if (f.memoriesAdded > 0) "Memories added" to "${f.memoriesAdded}" else null,
            if (f.skillsLearned.isNotEmpty()) "Skills learned" to f.skillsLearned.joinToString(", ") else null,
            if (f.goalsMoved > 0 || f.goalsDone > 0) "Goals" to "${n(f.goalsMoved, "progress entry", "progress entries")}${if (f.goalsDone > 0) ", ${f.goalsDone} done" else ""}" else null,
        )
    }

    /** The footnote on what was left out, or null. */
    fun excluded(e: ReflectExcluded): String? {
        val parts = listOfNotNull(
            if (e.health > 0) "${n(e.health, "health-related session", "health-related sessions")} (found by topic)" else null,
            if (e.incognito > 0) n(e.incognito, "incognito chat", "incognito chats") else null,
        )
        if (parts.isEmpty()) return null
        return "Left out: ${parts.joinToString(" and ")}. Only titles and short summaries are read, never mail, files or tool output."
    }

    /** The model in words. */
    fun model(model: String?): String = when {
        model.isNullOrBlank() -> "The default model"
        model == "fast" -> "The small model"
        else -> ModelRefs.displayName(model)
    }
}
