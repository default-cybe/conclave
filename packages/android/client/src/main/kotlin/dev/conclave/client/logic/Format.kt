package dev.conclave.client.logic

import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

object Format {

    /** "4h 12m", "12m 05s", "45s". Zero or negative gives "now". */
    fun countdown(ms: Long): String {
        if (ms <= 0) return "now"
        val total = (ms + 999) / 1000
        val d = total / 86_400
        val h = (total % 86_400) / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        return when {
            d > 0 -> "${d}d ${h}h"
            h > 0 -> "${h}h ${m}m"
            m > 0 -> "${m}m ${s.toString().padStart(2, '0')}s"
            else -> "${s}s"
        }
    }

    /** "12s", "4m", "1h 12m", "2d 3h": a short duration, as the web's durationShort ("Thought for 12s"). */
    fun durationShort(ms: Long): String {
        val s = Math.round(ms.coerceAtLeast(0) / 1000.0)
        if (s < 60) return "${s}s"
        val m = s / 60
        if (m < 60) return "${m}m"
        val h = m / 60
        if (h < 24) return if (m % 60 != 0L) "${h}h ${m % 60}m" else "${h}h"
        val d = h / 24
        return if (h % 24 != 0L) "${d}d ${h % 24}h" else "${d}d"
    }

    /** Elapsed counter for live work: "0:42", "12:04", "1:02:04". */
    fun elapsed(ms: Long): String {
        val total = (ms / 1000).coerceAtLeast(0)
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = (total % 60).toString().padStart(2, '0')
        return if (h > 0) "$h:${m.toString().padStart(2, '0')}:$s" else "$m:$s"
    }

    /** "just now", "5m ago", "3h ago", "2d ago", or "in 5m" for future times. */
    fun relative(ts: Long, now: Long = System.currentTimeMillis()): String {
        if (ts <= 0) return ""
        val diff = now - ts
        val future = diff < 0
        val sec = abs(diff) / 1000
        val text = when {
            sec < 45 -> return if (future) "in a moment" else "just now"
            sec < 3600 -> "${(sec / 60).coerceAtLeast(1)}m"
            sec < 86_400 -> "${sec / 3600}h"
            sec < 86_400 * 30 -> "${sec / 86_400}d"
            sec < 86_400 * 365 -> "${sec / (86_400 * 30)}mo"
            else -> "${sec / (86_400 * 365)}y"
        }
        return if (future) "in $text" else "$text ago"
    }

    /** 1234 -> "1.2k", 3400000 -> "3.4M". */
    fun tokens(n: Long): String = when {
        n >= 1_000_000_000 -> String.format(Locale.US, "%.1fB", n / 1e9)
        n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1e6)
        n >= 10_000 -> "${(n / 1000.0).roundToLong()}k"
        n >= 1_000 -> String.format(Locale.US, "%.1fk", n / 1e3)
        else -> n.toString()
    }

    fun usd(v: Double): String = when {
        v == 0.0 -> "$0"
        abs(v) < 0.01 -> String.format(Locale.US, "$%.4f", v)
        abs(v) < 100 -> String.format(Locale.US, "$%.2f", v)
        else -> String.format(Locale.US, "$%,.0f", v)
    }

    fun percent(fraction: Double): String = String.format(Locale.US, "%.0f%%", fraction * 100)

    /** Model ref "provider/model" to a short label: "claude-sonnet-5-5". */
    fun modelLabel(ref: String?): String {
        if (ref.isNullOrBlank()) return ""
        return ref.substringAfter('/')
    }
}

enum class ModelFamily { CLAUDE, OPENAI, GEMINI, GLM, OTHER;

    companion object {
        /** Guess the vendor family from a "provider/model" ref, an agent name or an author label. */
        fun of(ref: String?): ModelFamily {
            val s = ref?.lowercase() ?: return OTHER
            return when {
                listOf("claude", "anthropic", "opus", "sonnet", "haiku").any { it in s } -> CLAUDE
                listOf("gemini", "google", "antigravity").any { it in s } -> GEMINI
                listOf("glm", "zai", "z-ai", "zhipu", "bigmodel").any { it in s } -> GLM
                listOf("openai", "gpt", "codex", "/o1", "/o3", "/o4").any { it in s } -> OPENAI
                else -> OTHER
            }
        }
    }
}

/** Session list grouping. */
enum class SessionGrouping { DATE, AGENT, TASK }

data class SessionGroup(val title: String, val sessions: List<Session>)

object Sessions {

    fun needsAttention(s: Session): Boolean =
        s.status == SessionStatus.WAITING_APPROVAL || s.status == SessionStatus.WAITING_INPUT

    /**
     * Pinned sessions first (own group), then the rest grouped by date, agent
     * or task. Within a group, newest first.
     */
    fun group(
        sessions: List<Session>,
        by: SessionGrouping,
        now: Long = System.currentTimeMillis(),
        zone: ZoneId = ZoneId.systemDefault(),
        taskTitles: Map<String, String> = emptyMap(),
    ): List<SessionGroup> {
        val out = ArrayList<SessionGroup>()
        val pinned = sessions.filter { it.pinned }.sortedByDescending { it.updatedAt }
        if (pinned.isNotEmpty()) out.add(SessionGroup("Pinned", pinned))
        val rest = sessions.filterNot { it.pinned }.sortedByDescending { it.updatedAt }
        when (by) {
            SessionGrouping.DATE -> {
                val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
                val buckets = linkedMapOf<String, MutableList<Session>>()
                for (s in rest) {
                    val day = Instant.ofEpochMilli(s.updatedAt).atZone(zone).toLocalDate()
                    buckets.getOrPut(dateBucket(day, today)) { ArrayList() }.add(s)
                }
                buckets.forEach { (k, v) -> out.add(SessionGroup(k, v)) }
            }
            SessionGrouping.AGENT -> {
                rest.groupBy { it.agent.ifBlank { "default" } }
                    .toSortedMap(String.CASE_INSENSITIVE_ORDER)
                    .forEach { (k, v) -> out.add(SessionGroup(k, v)) }
            }
            SessionGrouping.TASK -> {
                val withTask = rest.filter { it.taskId != null }.groupBy { it.taskId!! }
                withTask.entries
                    .sortedByDescending { e -> e.value.maxOf { it.updatedAt } }
                    .forEach { (id, v) -> out.add(SessionGroup(taskTitles[id] ?: "Task $id", v)) }
                val noTask = rest.filter { it.taskId == null }
                if (noTask.isNotEmpty()) out.add(SessionGroup("No task", noTask))
            }
        }
        return out
    }

    private fun dateBucket(day: LocalDate, today: LocalDate): String {
        val days = ChronoUnit.DAYS.between(day, today)
        return when {
            days <= 0L -> "Today"
            days == 1L -> "Yesterday"
            days < 7L -> "This week"
            days < 30L -> "This month"
            else -> "Older"
        }
    }
}
