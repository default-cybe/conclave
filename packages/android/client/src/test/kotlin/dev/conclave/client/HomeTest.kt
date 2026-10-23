package dev.conclave.client

import dev.conclave.client.logic.Home
import dev.conclave.client.model.LimitState
import dev.conclave.client.model.LimitWindow
import dev.conclave.client.model.Routine
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionMode
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.WorkflowCounts
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunStatus
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class HomeTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private val now = LocalDateTime.of(2026, 10, 17, 9, 30).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val clock: (Long) -> String = { ts ->
        val t = java.time.Instant.ofEpochMilli(ts).atZone(zone)
        "%02d:%02d".format(t.hour, t.minute)
    }

    private fun status(
        running: Int = 0,
        waiting: Int = 0,
        firstDay: Boolean = false,
        short: Boolean = false,
        limits: List<LimitState> = emptyList(),
        routines: List<Routine> = emptyList(),
    ) = Home.status(running, waiting, firstDay, short, limits, 70, routines, now, zone, clock)

    private fun text(s: Home.Status) = (s.first.map { it.text } + listOfNotNull(s.second?.text)).joinToString(" ")

    @Test
    fun countsAsWords() {
        assertEquals("Two", Home.countWord(2, true))
        assertEquals("nine", Home.countWord(9))
        assertEquals("12", Home.countWord(12))
    }

    @Test
    fun saysWhatRunsAndWhatWaits() {
        assertEquals("Nothing running yet.", text(status(firstDay = true)))
        assertEquals("Nothing running.", text(status()))
        assertEquals("One session running. One is waiting on you.", text(status(running = 1, waiting = 1)))
        assertEquals("Two sessions running. Two are waiting on you.", text(status(running = 2, waiting = 2)))
        // phones use the short forms
        assertEquals("Two running. Two waiting on you.", text(status(running = 2, waiting = 2, short = true)))
        val s = status(running = 1, waiting = 3)
        assertTrue(s.first[1].warn)
        assertTrue(!s.first[0].warn)
    }

    @Test
    fun theSecondLineIsTheLimitThenTheNextRoutine() {
        val resets = now + 90 * 60_000L
        val blocked = LimitState("claude-code", label = "Claude Max", blocked = true, windows = listOf(LimitWindow("5h", usedPercent = 100.0, resetsAt = resets)))
        assertEquals("Claude Max is blocked until 11:00.", status(limits = listOf(blocked)).second?.text)
        assertEquals("Claude Max blocked until 11:00.", status(limits = listOf(blocked), short = true).second?.text)

        val high = LimitState("codex", label = "ChatGPT Pro", windows = listOf(LimitWindow("5h", usedPercent = 72.4), LimitWindow("7d", usedPercent = 40.0)))
        assertEquals("ChatGPT's 5 hour window is at 72%.", status(limits = listOf(high)).second?.text)

        val low = LimitState("codex", label = "ChatGPT Pro", windows = listOf(LimitWindow("5h", usedPercent = 20.0)))
        val tomorrow = LocalDateTime.of(2026, 10, 18, 8, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
        val later = LocalDateTime.of(2026, 10, 17, 14, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
        val routines = listOf(
            Routine("r1", name = "Inbox triage", nextRunAt = tomorrow),
            Routine("r2", name = "Nightly tests", nextRunAt = later),
            Routine("r3", name = "Off", enabled = false, nextRunAt = now + 60_000),
        )
        assertEquals("Next routine at 14:00, Nightly tests.", status(limits = listOf(low), routines = routines).second?.text)
        assertEquals("Next routine tomorrow at 08:00, Inbox triage.", status(routines = routines.take(1)).second?.text)
        assertNull(status().second)
    }

    @Test
    fun rateWindowsOnlyCountWhenHigh() {
        val api = LimitState("openai", label = "OpenAI API", source = "headers", windows = listOf(LimitWindow("requests / min", usedPercent = 30.0)))
        assertTrue(Home.homeLimits(listOf(api)).isEmpty())
        val busy = api.copy(windows = listOf(LimitWindow("requests / min", usedPercent = 80.0)))
        assertEquals(listOf(busy), Home.homeLimits(listOf(busy)))
        assertEquals("Requests per minute", Home.windowLabel("requests / min"))
        assertEquals("5 hours", Home.windowLabel("5h"))
        assertEquals("Week, Opus", Home.windowLabel("7d opus"))
        assertEquals("Claude" to "Max", Home.planParts("Claude Max"))
        assertEquals("Ollama" to "", Home.planParts("Ollama"))
        assertEquals(100, Home.percent(LimitWindow("5h", usedPercent = 12.0), blocked = true))
        assertEquals(60, Home.percent(LimitWindow("tokens", limit = 100.0, remaining = 40.0), blocked = false))
    }

    @Test
    fun runningLeavesOutChatsAndPutsResetsLast() {
        val list = listOf(
            Session("a", status = SessionStatus.WAITING_RESET, createdAt = 1),
            Session("b", status = SessionStatus.RUNNING, createdAt = 5),
            Session("c", status = SessionStatus.RUNNING, kind = SessionKind.CHAT, createdAt = 2),
            Session("d", status = SessionStatus.IDLE, createdAt = 3),
            Session("e", status = SessionStatus.RUNNING, createdAt = 4),
        )
        assertEquals(listOf("e", "b", "a"), Home.running(list).map { it.id })
    }

    @Test
    fun recentChatsAreTheNewestChats() {
        val list = listOf(
            Session("c1", kind = SessionKind.CHAT, updatedAt = 10),
            Session("s1", updatedAt = 50),
            Session("c2", kind = SessionKind.CHAT, updatedAt = 30),
            Session("c3", kind = SessionKind.CHAT, updatedAt = 20, archived = true),
            Session("c4", kind = SessionKind.CHAT, updatedAt = 40),
        )
        assertEquals(listOf("c4", "c2"), Home.recentChats(list, 2).map { it.id })
        val last = Home.lastOwnSession(list + Session("j", mode = SessionMode.JURY, updatedAt = 99) + Session("r", routineId = "x", updatedAt = 98))
        assertEquals("s1", last?.id)
    }

    @Test
    fun offlineItCannotTellOrSaysFromWhen() {
        val off = Home.Offline("homelab")
        assertEquals("Can't tell what needs you while homelab is offline.", text(Home.status(1, 2, false, true, emptyList(), 70, emptyList(), now, zone, clock, off)))
        val at = now - 53 * 60_000L
        val stale = Home.status(1, 2, false, true, emptyList(), 70, emptyList(), now, zone, clock, off.copy(at = at))
        assertEquals("One running. Two waiting on you. homelab is offline, so this is from 08:37.", text(stale))
        // the time the counts were good takes the second line's place
        assertTrue(stale.first[1].warn)
        val routine = Routine(id = "r", name = "PR check", enabled = true, nextRunAt = now + 3_600_000L)
        assertEquals("homelab is offline, so this is from 08:37.", Home.status(0, 0, false, true, emptyList(), 70, listOf(routine), now, zone, clock, off.copy(at = at)).second?.text)
        assertEquals("Nothing running. Next routine at 10:30, PR check.", text(Home.status(0, 0, false, true, emptyList(), 70, listOf(routine), now, zone, clock)))
    }

    private fun agentOf(run: String, id: String, status: SessionStatus = SessionStatus.RUNNING) =
        Session(id, status = status, meta = buildJsonObject { putJsonObject("workflow") { put("runId", run); put("seq", 1) } })

    private fun run(id: String, status: WorkflowRunStatus, running: Int) = WorkflowRun(id, status = status, counts = WorkflowCounts(running = running))

    @Test
    fun aWorkflowsOwnSessionsFoldIntoItsRunAndAgentsCountOnce() {
        val sessions = listOf(Session("solo", status = SessionStatus.RUNNING), agentOf("r1", "agent-a"), agentOf("r1", "agent-b"), Session("parked", status = SessionStatus.WAITING_RESET))
        val w = Home.workingNow(sessions, listOf(run("r1", WorkflowRunStatus.RUNNING, 2)))
        assertEquals(listOf("solo", "parked"), w.sessions.map { it.id })
        assertEquals(3, w.agents)
        // the demo hub: one workflow agent, listed once and counted once
        val demo = Home.workingNow(listOf(agentOf("r1", "prove")), listOf(run("r1", WorkflowRunStatus.RUNNING, 1)))
        assertEquals(emptyList(), demo.sessions)
        assertEquals(1, demo.agents)
    }

    @Test
    fun aRunBetweenCallsCountsAsOneAQueuedOneOrOneNotListedCountNothingOfItsOwn() {
        val lost = agentOf("gone", "lost")
        val w = Home.workingNow(listOf(lost), listOf(run("r1", WorkflowRunStatus.RUNNING, 0), run("r2", WorkflowRunStatus.QUEUED, 0)))
        assertEquals(listOf("lost"), w.sessions.map { it.id })
        assertEquals(2, w.agents)
        assertEquals("r1", Home.workflowRunOf(agentOf("r1", "x")))
        assertNull(Home.workflowRunOf(Session("plain")))
    }

    @Test
    fun datesAndDevicesInWords() {
        assertEquals("Saturday 17 October", Home.longDate(now, zone))
        assertEquals("No devices paired yet.", Home.devicesLine(emptyList()))
        assertEquals("arch-desktop online.", Home.devicesLine(listOf("arch-desktop" to true)))
        assertEquals("Both devices online.", Home.devicesLine(listOf("a" to true, "b" to true)))
        assertEquals("Two of three devices online, laptop offline.", Home.devicesLine(listOf("a" to true, "b" to true, "laptop" to false)))
        assertEquals("All three devices offline.", Home.devicesLine(listOf("a" to false, "b" to false, "c" to false)))
    }
}
