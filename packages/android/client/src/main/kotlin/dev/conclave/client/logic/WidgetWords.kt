package dev.conclave.client.logic

import dev.conclave.client.model.AlertItem
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.LimitState
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.Today
import dev.conclave.client.model.UsageSummary
import java.net.URLEncoder
import java.time.Instant
import java.time.ZoneId

/** One tappable line on a widget: its text and the conclave:// link it opens. */
data class WidgetRow(val text: String, val link: String)

/** One widget page (Usage, Inbox or Calendar), shared by the single widgets and the swipeable one. */
data class WidgetPage(val title: String, val detail: String, val link: String, val rows: List<WidgetRow> = emptyList())

/**
 * The home-screen widgets' words (Android widgets/Widgets.kt), from the
 * signed-in account's own lists. Plain data: no token, no disk cache.
 */
object WidgetWords {
    const val USAGE = "conclave://usage"
    const val INBOX = "conclave://approvals"
    const val TODAY = "conclave://today"

    /** Rows a widget shows. */
    const val ROWS = 3

    /** Local midnight, not a rolling 24 hours (also on daylight-saving days). */
    fun dayStart(now: Long, zone: ZoneId): Long =
        Instant.ofEpochMilli(now).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()

    /** Today's tokens, and the plan limits Home shows, the fullest first: "Claude Max: 5 hours 42% · Week 10%". */
    fun usage(today: UsageSummary, limits: List<LimitState>): WidgetPage {
        val t = today.totals
        val rows = Home.homeLimits(limits).take(ROWS).map { l ->
            val blocked = l.blocked == true
            val windows = Home.homeWindows(l).joinToString(" · ") { w ->
                Home.windowLabel(w.name).ifBlank { w.name } + " " + (Home.percent(w, blocked)?.let { "$it%" } ?: "?")
            }
            WidgetRow("${l.label.ifBlank { l.provider }}: " + if (blocked) "blocked" else windows, USAGE)
        }
        val detail = "Today: ${Format.tokens(t.inputTokens + t.outputTokens)} tokens · ${Format.tokens(t.inputTokens)} in, ${Format.tokens(t.outputTokens)} out"
        return WidgetPage("Usage", detail, USAGE, rows.ifEmpty { listOf(WidgetRow("No plan limits reported", USAGE)) })
    }

    /**
     * What waits on the owner, as the Inbox lists it: approvals, questions,
     * alerts, then calendar and mail proposals; oldest first within each
     * kind. The count is all of them; the rows are the first three, each
     * opening its own item.
     */
    fun inbox(approvals: List<ApprovalRequest>, questions: List<QuestionRequest>, alerts: List<AlertItem>, today: Today?, now: Long): WidgetPage {
        val rows = approvals.distinctBy { it.id }.sortedBy { it.createdAt }.map {
            WidgetRow(Asks.askerLine(it, Inbox.askLine(it.tool, it.summary, it.input)), session(Asks.home(it)))
        } + questions.distinctBy { it.id }.sortedBy { it.createdAt }.map {
            WidgetRow(Asks.askerLine(it, Inbox.questionLine(it)), session(Asks.home(it)))
        } + alerts.distinctBy { it.id }.sortedBy { it.createdAt }.map {
            WidgetRow(Inbox.alertText(it, now), session(it.sessionId))
        } + (today?.let { TodayWords.pending(it) } ?: emptyList()).sortedBy { it.createdAt }.map {
            WidgetRow(it.summary.ifBlank { TodayWords.question(it) }, TODAY)
        }
        val detail = if (rows.isEmpty()) "Nothing waits on you" else "${rows.size} waiting on you"
        return WidgetPage("Inbox", detail, INBOX, rows.take(ROWS))
    }

    /** The next three events of today that have not ended, in the hub's zone. */
    fun calendar(today: Today, now: Long): WidgetPage {
        val zone = TodayWords.zone(today.timezone)
        val rows = TodayWords.events(today).filter { it.end > now }.take(ROWS).map {
            WidgetRow("${TodayWords.range(it.start, it.end, it.allDay, zone)} · ${it.title.ifBlank { "Busy" }}", TODAY)
        }
        val detail = when {
            today.calendarError != null -> "Calendar unavailable"
            today.events == null -> "No calendar connected"
            rows.isEmpty() -> "Nothing else today"
            else -> TodayWords.day(now, zone)
        }
        return WidgetPage("Calendar", detail, TODAY, rows)
    }

    /** A page that could not load and has nothing older to show. */
    fun unavailable(title: String, link: String): WidgetPage = WidgetPage(title, "Can't reach your hub", link)

    /** Live events that change a widget: asks, usage and limits, alerts, and "refetch what you show". */
    fun relevant(e: EngineEvent): Boolean =
        Asks.isAskEvent(e) || e is EngineEvent.UsageRecorded || e is EngineEvent.LimitUpdated ||
            e is EngineEvent.AlertRaised || e is EngineEvent.AlertCleared || e is EngineEvent.ConfigUpdated

    private fun session(id: String): String =
        if (id.isBlank()) INBOX else "conclave://session/" + URLEncoder.encode(id, "UTF-8").replace("+", "%20")
}
