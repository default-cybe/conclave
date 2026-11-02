package dev.conclave.client

import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.TodayWords
import dev.conclave.client.logic.WidgetAccount
import dev.conclave.client.logic.WidgetPage
import dev.conclave.client.logic.WidgetWords
import dev.conclave.client.model.AlertItem
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.AskFrom
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.LimitState
import dev.conclave.client.model.LimitWindow
import dev.conclave.client.model.Proposal
import dev.conclave.client.model.Question
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.Today
import dev.conclave.client.model.TodayEvent
import dev.conclave.client.model.UsageBucket
import dev.conclave.client.model.UsageSummary
import java.time.Instant
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The home-screen widgets' data (logic/WidgetWords.kt) and their per-account snapshot (logic/WidgetAccount.kt). */
class WidgetsTest {
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test
    fun usageShowsTodaysTokensAndTheFullestPlansFirst() {
        val page = WidgetWords.usage(
            UsageSummary(totals = UsageBucket(inputTokens = 1_200_000, outputTokens = 34_000)),
            listOf(
                LimitState(provider = "openai", label = "ChatGPT Plus", windows = listOf(LimitWindow("5h", usedPercent = 10.0))),
                LimitState(provider = "anthropic", label = "Claude Max", windows = listOf(LimitWindow("5h", usedPercent = 42.4), LimitWindow("7d", usedPercent = 12.0))),
                LimitState(provider = "zai", label = "", windows = listOf(LimitWindow("5h", usedPercent = 99.0)), blocked = true),
                // an API key's rate window under 50% is noise, as on Home
                LimitState(provider = "groq", label = "Groq", source = "headers", windows = listOf(LimitWindow("requests / min", usedPercent = 5.0))),
            ),
        )
        assertEquals("Usage", page.title)
        assertEquals("Today: 1.2M tokens · 1.2M in, 34k out", page.detail)
        assertEquals(listOf("zai: blocked", "Claude Max: 5 hours 42% · Week 12%", "ChatGPT Plus: 5 hours 10%"), page.rows.map { it.text })
        assertTrue(page.rows.all { it.link == WidgetWords.USAGE })
    }

    @Test
    fun usageWithoutLimitsSaysSo() {
        val page = WidgetWords.usage(UsageSummary(), emptyList())
        assertEquals("Today: 0 tokens · 0 in, 0 out", page.detail)
        assertEquals(listOf("No plan limits reported"), page.rows.map { it.text })
    }

    @Test
    fun inboxCountsEverythingWaitingAndOpensEachItem() {
        val edit = buildJsonObject { put("file_path", JsonPrimitive("/repo/src/a.ts")) }
        val page = WidgetWords.inbox(
            approvals = listOf(
                ApprovalRequest(id = "a2", sessionId = "sub 1", tool = "Edit", input = edit, createdAt = 20, rootSessionId = "root", from = AskFrom(sessionId = "sub 1", agent = "email")),
                ApprovalRequest(id = "a1", sessionId = "s1", tool = "Write", input = buildJsonObject { put("file_path", JsonPrimitive("b.md")) }, createdAt = 10),
                ApprovalRequest(id = "a1", sessionId = "s1", tool = "Write", createdAt = 10),
            ),
            questions = listOf(QuestionRequest(id = "q1", sessionId = "s2", questions = listOf(Question("Keep the old route?")), createdAt = 5)),
            alerts = listOf(AlertItem(id = "x", kind = "fileConflict", sessionId = "s3", text = "Two chats edit a.ts", createdAt = 1)),
            today = Today(proposals = listOf(Proposal(id = "p", summary = "Gym at 18:00"), Proposal(id = "done", status = "applied"))),
            now = 0,
        )
        assertEquals("5 waiting on you", page.detail)
        assertEquals(WidgetWords.INBOX, page.link)
        // approvals first (oldest first), then questions; only three rows
        assertEquals(listOf("Wants to write b.md", "Subagent email wants to edit a.ts", "Asks: Keep the old route?"), page.rows.map { it.text })
        // a subagent's ask opens the chat it shows in
        assertEquals(listOf("conclave://session/s1", "conclave://session/root", "conclave://session/s2"), page.rows.map { it.link })
        page.rows.forEach { assertTrue(DeepLink.parse(it.link) is DeepLink.Session) }
    }

    @Test
    fun inboxTailIsAlertsThenProposals() {
        val page = WidgetWords.inbox(
            emptyList(), emptyList(),
            listOf(AlertItem(id = "x", sessionId = "s 3", text = "Two chats edit a.ts")),
            Today(proposals = listOf(Proposal(id = "p", summary = ""))),
            0,
        )
        assertEquals(listOf("Two chats edit a.ts", "Add to the calendar?"), page.rows.map { it.text })
        assertEquals(listOf("conclave://session/s%203", WidgetWords.TODAY), page.rows.map { it.link })
        assertEquals(DeepLink.Session("s 3"), DeepLink.parse(page.rows[0].link))
        assertEquals("Nothing waits on you", WidgetWords.inbox(emptyList(), emptyList(), emptyList(), null, 0).detail)
    }

    @Test
    fun calendarShowsTheNextThreeEventsNotEnded() {
        val now = ms("2026-10-22T10:30:00Z")
        val today = Today(
            timezone = "Europe/Berlin",
            events = listOf(
                TodayEvent("past", "Standup", ms("2026-10-22T07:00:00Z"), ms("2026-10-22T07:15:00Z")),
                TodayEvent("now", "Lecture", ms("2026-10-22T10:00:00Z"), ms("2026-10-22T11:00:00Z")),
                TodayEvent("gym", "Gym", ms("2026-10-22T16:00:00Z"), ms("2026-10-22T17:00:00Z")),
                TodayEvent("gym", "Gym", ms("2026-10-22T16:00:00Z"), ms("2026-10-22T17:00:00Z")),
                TodayEvent("day", "Holiday", ms("2026-10-21T22:00:00Z"), ms("2026-10-22T22:00:00Z"), allDay = true),
                TodayEvent("late", "", ms("2026-10-22T19:00:00Z"), ms("2026-10-22T20:00:00Z")),
            ),
        )
        val page = WidgetWords.calendar(today, now)
        assertEquals("Thu 22 Oct", page.detail)
        assertEquals(listOf("All day · Holiday", "12:00 to 13:00 · Lecture", "18:00 to 19:00 · Gym"), page.rows.map { it.text })
        assertTrue(page.rows.all { DeepLink.parse(it.link) == DeepLink.Today })
    }

    @Test
    fun calendarSaysWhyItIsEmpty() {
        assertEquals("No calendar connected", WidgetWords.calendar(Today(), 0).detail)
        assertEquals("Calendar unavailable", WidgetWords.calendar(Today(events = emptyList(), calendarError = "401"), 0).detail)
        assertEquals("Nothing else today", WidgetWords.calendar(Today(events = emptyList()), 0).detail)
    }

    @Test
    fun dayStartIsLocalMidnight() {
        val zone = TodayWords.zone("America/Los_Angeles")
        // the day clocks go back: midnight is 07:00Z, 25 hours before the next one
        assertEquals(ms("2026-11-01T07:00:00Z"), WidgetWords.dayStart(ms("2026-11-01T20:00:00Z"), zone))
    }

    @Test
    fun relevantEventsAreAsksUsageLimitsAlertsAndConfig() {
        assertTrue(WidgetWords.relevant(EngineEvent.ApprovalResolved("a")))
        assertTrue(WidgetWords.relevant(EngineEvent.ConfigUpdated()))
        assertTrue(WidgetWords.relevant(EngineEvent.AlertCleared("x")))
        assertFalse(WidgetWords.relevant(EngineEvent.Unknown()))
        assertFalse(WidgetWords.relevant(EngineEvent.TaskDeleted("t")))
    }

    @Test
    fun widgetLinksOpenTheirPages() {
        assertEquals(DeepLink.Usage, DeepLink.parse(WidgetWords.USAGE))
        assertEquals(DeepLink.Today, DeepLink.parse(WidgetWords.TODAY))
        assertEquals(DeepLink.Approvals, DeepLink.parse(WidgetWords.INBOX))
    }

    @Test
    fun oneAccountNeverSeesAnothersPages() {
        val snap = WidgetAccount()
        val owner = WidgetAccount.key("owner-token")!!
        val member = WidgetAccount.key("member-token")!!
        assertNotEquals(owner, member)
        assertFalse(owner.contains("owner-token"))
        assertNull(WidgetAccount.key(" "))
        val pages = listOf(WidgetPage("Inbox", "1 waiting on you", WidgetWords.INBOX))

        snap.bind(owner)
        assertTrue(snap.publish(owner, pages))
        assertEquals(pages, snap.read(owner))
        assertEquals(emptyList(), snap.read(member))
        assertEquals(emptyList(), snap.read(null))

        // a switch to another account drops the old pages, and a late reply for the old one cannot publish
        snap.bind(member)
        assertEquals(emptyList(), snap.read(member))
        assertFalse(snap.publish(owner, pages))
        assertEquals(emptyList(), snap.read(owner))

        // signed out: nothing reads, nothing publishes
        snap.bind(null)
        assertFalse(snap.publish(member, pages))
    }
}
