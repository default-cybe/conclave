package dev.conclave.client

import dev.conclave.client.logic.HubLine
import dev.conclave.client.logic.Inbox
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.WorkflowCounts
import dev.conclave.client.model.WorkflowPhase
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunStatus
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class InboxTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private fun at(h: Int, m: Int = 0): Long = LocalDateTime.of(2026, 10, 20, h, m).atZone(zone).toInstant().toEpochMilli()
    private val clock: (Long) -> String = { ts -> java.time.Instant.ofEpochMilli(ts).atZone(zone).toLocalTime().toString() }

    @Test
    fun hubLineSaysWhereThingsStand() {
        assertEquals("home · online", HubLine.text("home", ConnectionState.OPEN))
        assertEquals("home · connecting", HubLine.text("home", ConnectionState.CONNECTING))
        assertEquals("home · offline, retrying", HubLine.text("home", ConnectionState.CLOSED))
        assertEquals("Hub · no network", HubLine.text("  ", ConnectionState.CLOSED, noNetwork = true))
        assertEquals("hub.example.net · 3 devices online", HubLine.detail("hub.example.net", 3))
        assertEquals("1 device online", HubLine.detail("", 1))
    }

    @Test
    fun filterWordsCountWhatWaits() {
        assertEquals(0, Inbox.count(Inbox.Filter.ALL, 2, 1))
        assertEquals(2, Inbox.count(Inbox.Filter.APPROVALS, 2, 1))
        assertEquals(0, Inbox.count(Inbox.Filter.QUESTIONS, 2, 0))
        assertEquals(0, Inbox.count(Inbox.Filter.RESULTS, 2, 1))
        assertEquals(listOf("All", "Approvals", "Questions", "Alerts", "Friends", "Results"), Inbox.Filter.entries.map { it.label })
    }

    @Test
    fun resultsAreTodaysFinishedWorkSinceTheLastClear() {
        val sessions = listOf(
            Session("done", title = "Update dependencies", status = SessionStatus.IDLE, updatedAt = at(7, 12)),
            Session("failed", title = "Nightly build", status = SessionStatus.ERROR, updatedAt = at(9)),
            Session("yesterday", status = SessionStatus.IDLE, updatedAt = at(7) - 86_400_000L),
            Session("running", status = SessionStatus.RUNNING, updatedAt = at(9, 30)),
            Session("chat", status = SessionStatus.IDLE, kind = SessionKind.CHAT, updatedAt = at(8)),
            Session("sub", status = SessionStatus.IDLE, parentId = "done", updatedAt = at(8)),
            Session("archived", status = SessionStatus.IDLE, archived = true, updatedAt = at(8)),
        )
        val now = at(10)
        assertEquals(listOf("failed", "done"), Inbox.results(sessions, now, zone).map { it.id })
        // cleared at 8:00: only what finished after
        assertEquals(listOf("failed"), Inbox.results(sessions, now, zone, clearedAt = at(8)).map { it.id })
        assertEquals("Finished", Inbox.resultWord(sessions[0]))
        assertEquals("Failed", Inbox.resultWord(sessions[1]))
    }

    @Test
    fun approvalCardsSayWhatTheAgentWants() {
        assertEquals("Wants to run" to "git push origin fix/login", Inbox.approvalLines("Bash", "Run: git push origin fix/login"))
        assertEquals("Wants to run" to "rm -rf build/cache", Inbox.approvalLines("Shell", "run: rm -rf build/cache"))
        assertEquals("Wants to use Edit" to "Edit src/auth/callback.ts", Inbox.approvalLines("Edit", "Edit src/auth/callback.ts"))
        assertEquals("Wants to use WebFetch" to "WebFetch", Inbox.approvalLines("WebFetch", " "))
    }

    @Test
    fun theCommandOnTheLineAndTheAgentsReasonInCurlyQuotes() {
        // the hub's summary of a shell call is the agent's description
        val push = buildJsonObject {
            put("command", "git push origin fix/login")
            put("description", "Push fix/login")
        }
        val (label, line) = Inbox.approvalLines("Bash", "Push fix/login", push)
        assertEquals("Wants to run" to "git push origin fix/login", label to line)
        assertEquals("“Push fix/login”", Inbox.approvalReason(push, line))
        assertEquals("“The tests need it”", Inbox.approvalReason(buildJsonObject { put("reason", " The tests need it ") }, "npm ci"))
        // none given, or only the line again
        assertNull(Inbox.approvalReason(buildJsonObject { put("command", "ls") }, "ls"))
        assertNull(Inbox.approvalReason(buildJsonObject { put("description", "ls") }, "ls"))
    }

    @Test
    fun metaLinesLeaveOutBlankParts() {
        assertEquals("Coder · MacBook · Fix login redirect", Inbox.meta("Coder", "MacBook", "Fix login redirect"))
        assertEquals("MacBook", Inbox.meta("", null, " MacBook "))
        val running = Session("r", status = SessionStatus.RUNNING, device = "mac", updatedAt = at(9, 56))
        assertEquals("Running · 4m · MacBook", Inbox.workingLine(running, "MacBook", at(10), clock))
        assertEquals("Waiting for you", Inbox.workingLine(running.copy(status = SessionStatus.WAITING_APPROVAL), null, at(10), clock))
        assertEquals("Resumes 15:04", Inbox.workingLine(running.copy(status = SessionStatus.WAITING_RESET, resumeAt = at(15, 4)), null, at(10), clock))
    }

    @Test
    fun aRunOnWorkingNowSaysItsPhaseAndAgents() {
        val run = WorkflowRun(
            "r1",
            name = "review-login-fix",
            status = WorkflowRunStatus.RUNNING,
            device = "mac",
            phases = listOf(WorkflowPhase("Find"), WorkflowPhase("Prove")),
            phaseIndex = 1,
            counts = WorkflowCounts(running = 1),
        )
        assertEquals("Workflow · phase 2 of 2 · MacBook", Inbox.runLine(run, "MacBook"))
        assertEquals("Workflow · phase 2 of 2 · 3 agents", Inbox.runLine(run.copy(counts = WorkflowCounts(running = 3)), null))
        assertEquals("Paused · phase 2 of 2 · MacBook", Inbox.runLine(run.copy(status = WorkflowRunStatus.PAUSED), "MacBook"))
        assertEquals("Workflow · queued · MacBook", Inbox.runLine(run.copy(status = WorkflowRunStatus.QUEUED, phaseIndex = -1, counts = WorkflowCounts()), "MacBook"))
        assertEquals("Workflow · starting · MacBook", Inbox.runLine(run.copy(phaseIndex = -1), "MacBook"))
    }
}
