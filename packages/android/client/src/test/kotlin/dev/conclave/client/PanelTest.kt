package dev.conclave.client

import dev.conclave.client.logic.Inbox
import dev.conclave.client.logic.Lists
import dev.conclave.client.logic.Panel
import dev.conclave.client.logic.Recent
import dev.conclave.client.logic.RecentDot
import dev.conclave.client.model.Question
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionStatus
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PanelTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private fun at(day: Int, h: Int): Long = LocalDateTime.of(2026, 10, day, h, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val now = at(20, 18)
    private val clock: (Long) -> String = { ts -> java.time.Instant.ofEpochMilli(ts).atZone(zone).toLocalTime().toString() }

    private fun chat(id: String, title: String, updated: Long, status: SessionStatus = SessionStatus.IDLE) =
        Session(id, title = title, kind = SessionKind.CHAT, status = status, updatedAt = updated)

    private fun agent(id: String, title: String, updated: Long, status: SessionStatus = SessionStatus.IDLE) =
        Session(id, title = title, status = status, updatedAt = updated, device = "mac", cwd = "/Users/sam/$id")

    @Test
    fun recentsAreTheTenLatestChatsAndSessionsMixed() {
        val sessions = (1..12).map { i ->
            if (i % 2 == 0) chat("c$i", "Chat $i", at(20, i)) else agent("s$i", "Session $i", at(20, i))
        }
        val recents = Panel.recents(sessions)
        assertEquals(10, recents.size)
        assertEquals((12 downTo 3).map { if (it % 2 == 0) "c$it" else "s$it" }, recents.map { it.id })
        assertEquals(Recent("c12", "Chat 12", chat = true, dot = RecentDot.NONE), recents[0])
        assertFalse(recents[1].chat)
    }

    @Test
    fun recentsLeaveOutTheArchiveSubagentsAndAWorkflowsOwnAgents() {
        val workflow = buildJsonObject { putJsonObject("workflow") { put("runId", "run-1") } }
        val sessions = listOf(
            chat("keep", "Plan the week", at(20, 9)),
            chat("old", "Archived chat", at(20, 10)).copy(archived = true),
            agent("sub", "A subagent", at(20, 11)).copy(parentId = "keep"),
            agent("wf", "review / edge cases", at(20, 12)).copy(meta = workflow),
            agent("blank", "", at(20, 8)),
            chat("blank-chat", "  ", at(20, 7)),
        )
        val recents = Panel.recents(sessions)
        assertEquals(listOf("keep", "blank", "blank-chat"), recents.map { it.id })
        assertEquals(listOf("Plan the week", "New session", "New chat"), recents.map { it.title })
    }

    @Test
    fun aRunningOneHasADotAndOneThatWaitsOnYouTheAccentDot() {
        val sessions = listOf(
            agent("run", "Fix login redirect", at(20, 9), SessionStatus.RUNNING),
            agent("ask", "Push the login fix", at(20, 8), SessionStatus.WAITING_APPROVAL),
            agent("q", "Move routes", at(20, 7), SessionStatus.WAITING_INPUT),
            agent("idle", "Done", at(20, 6)),
            // the hub's status lags behind a question that just came: the open ones count too
            agent("late", "Running, asked", at(20, 5), SessionStatus.RUNNING),
        )
        val dots = Panel.recents(sessions, waiting = setOf("late")).associate { it.id to it.dot }
        assertEquals(RecentDot.RUNNING, dots["run"])
        assertEquals(RecentDot.WAITING, dots["ask"])
        assertEquals(RecentDot.WAITING, dots["q"])
        assertEquals(RecentDot.NONE, dots["idle"])
        assertEquals(RecentDot.WAITING, dots["late"])
    }

    @Test
    fun codeHasADotWhileAnAgentSessionRuns() {
        assertTrue(Panel.codeRunning(listOf(agent("a", "x", 1, SessionStatus.RUNNING))))
        // a chat that runs is not Code's
        assertFalse(Panel.codeRunning(listOf(chat("c", "x", 1, SessionStatus.RUNNING))))
        assertFalse(Panel.codeRunning(listOf(agent("a", "x", 1, SessionStatus.WAITING_APPROVAL))))
        assertFalse(Panel.codeRunning(listOf(agent("a", "x", 1, SessionStatus.RUNNING).copy(archived = true))))
    }

    @Test
    fun homeSaysHowManyNeedYou() {
        assertNull(Panel.needYou(0))
        assertEquals("1 needs you", Panel.needYou(1))
        assertEquals("2 need you", Panel.needYou(2))
    }

    @Test
    fun recentFoldersAreTheDevicesNewestFirstEachOnce() {
        val sessions = listOf(
            agent("a", "x", at(20, 9)).copy(cwd = "/Users/sam/fernway-web"),
            agent("b", "x", at(20, 10)).copy(cwd = "/Users/sam/conclave/"),
            agent("c", "x", at(20, 8)).copy(cwd = "/Users/sam/fernway-web"),
            agent("home", "x", at(20, 11)).copy(cwd = "/Users/sam"),
            agent("other", "x", at(20, 12)).copy(device = "local", cwd = "/srv/app"),
            chat("chat", "x", at(20, 13)).copy(device = "mac", cwd = "/Users/sam/chats"),
        )
        assertEquals(listOf("/Users/sam/conclave", "/Users/sam/fernway-web"), Panel.recentFolders(sessions, "mac"))
        assertEquals(listOf("/srv/app"), Panel.recentFolders(sessions, "local"))
    }

    @Test
    fun listsAreChatsOrCodePinnedFirstThenByTime() {
        val sessions = listOf(
            chat("today", "Plan the week", at(20, 9)),
            chat("yesterday", "Gift ideas", at(19, 9)),
            chat("pinned", "Reading list", at(1, 9)).copy(pinned = true),
            chat("gone", "Old", at(20, 8)).copy(archived = true),
            agent("code", "Fix login redirect", at(20, 10)),
            agent("sub", "Subagent", at(20, 10)).copy(parentId = "code"),
        )
        val chats = Lists.groups(sessions, chats = true, now = now, zone = zone)
        assertEquals(listOf("Pinned", "Today", "Yesterday"), chats.map { it.title })
        assertEquals(listOf("pinned"), chats[0].sessions.map { it.id })
        val code = Lists.groups(sessions, chats = false, now = now, zone = zone)
        assertEquals(listOf("code"), code.flatMap { it.sessions }.map { it.id })
        val archive = Lists.groups(sessions, chats = true, archived = true, now = now, zone = zone)
        assertEquals(listOf("gone"), archive.flatMap { it.sessions }.map { it.id })
        // the search matches titles, and for sessions the agent too
        assertEquals(listOf("yesterday"), Lists.groups(sessions, chats = true, query = "gift", now = now, zone = zone).flatMap { it.sessions }.map { it.id })
        val coder = sessions.map { if (it.id == "code") it.copy(agent = "coder") else it }
        assertEquals(listOf("code"), Lists.groups(coder, chats = false, query = "CODER", now = now, zone = zone).flatMap { it.sessions }.map { it.id })
    }

    @Test
    fun aRowsSecondLineOnlyWhenItSaysSomething() {
        assertNull(Lists.stateLine(agent("a", "x", 1), clock))
        assertEquals("Running", Lists.stateLine(agent("a", "x", 1, SessionStatus.RUNNING), clock))
        assertEquals("Waiting for you", Lists.stateLine(agent("a", "x", 1, SessionStatus.WAITING_INPUT), clock))
        assertEquals("Failed", Lists.stateLine(agent("a", "x", 1, SessionStatus.ERROR), clock))
        assertEquals("Resumes 15:00", Lists.stateLine(agent("a", "x", 1, SessionStatus.WAITING_RESET).copy(resumeAt = at(20, 15)), clock))
        assertEquals("Waiting for a limit", Lists.stateLine(agent("a", "x", 1, SessionStatus.WAITING_RESET), clock))
    }
}

class InboxLinesTest {
    private fun input(vararg pairs: Pair<String, String>) = JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) })

    @Test
    fun anApprovalAsksAQuestion() {
        assertEquals("Run this command?", Inbox.approvalTitle("Bash", "Push fix/login", input("command" to "git push origin fix/login")))
        assertEquals("Run this command?", Inbox.approvalTitle("", "Run: rm -rf build"))
        assertEquals("Edit redirect.ts?", Inbox.approvalTitle("Edit", "Edit file", input("file_path" to "/repo/src/auth/redirect.ts")))
        assertEquals("Write notes.md?", Inbox.approvalTitle("Write", "", input("file_path" to "/repo/notes.md")))
        assertEquals("Read owasp.org?", Inbox.approvalTitle("WebFetch", "", input("url" to "https://www.owasp.org/x")))
        assertEquals("Use github create_issue?", Inbox.approvalTitle("mcp__github__create_issue", ""))
    }

    @Test
    fun itsBlockShowsTheCommandOrTheFile() {
        assertEquals("git push origin fix/login", Inbox.approvalSubject("Bash", "Push fix/login", input("command" to "git push origin fix/login")))
        assertEquals("rm -rf build", Inbox.approvalSubject("", "Run: rm -rf build"))
        assertEquals("src/auth/redirect.ts", Inbox.approvalSubject("Edit", "Edit file", input("file_path" to "/repo/src/auth/redirect.ts"), "/repo"))
        assertEquals("https://example.org/a", Inbox.approvalSubject("WebFetch", "Fetch", input("url" to "https://example.org/a")))
        assertEquals("Open the browser", Inbox.approvalSubject("Browser", "Open the browser"))
    }

    @Test
    fun anInboxRowSaysWhatItWantsInOneLine() {
        assertEquals("Wants to run git push", Inbox.askLine("Bash", "Push fix/login", input("command" to "git push origin fix/login")))
        assertEquals("Wants to run rm", Inbox.askLine("Bash", "Run: rm -rf build"))
        assertEquals("Wants to edit redirect.ts", Inbox.askLine("Edit", "", input("file_path" to "/repo/src/auth/redirect.ts")))
        assertEquals("Wants to read example.org", Inbox.askLine("WebFetch", "", input("url" to "https://example.org/a")))
        assertEquals("Wants to use Browser", Inbox.askLine("Browser", "Open it"))
        val q = QuestionRequest("q1", "s1", listOf(Question("Keep the old API route?\nIt still has callers.")))
        assertEquals("Asks: Keep the old API route?", Inbox.questionLine(q))
        assertEquals("Asks a question", Inbox.questionLine(QuestionRequest("q2")))
    }
}
