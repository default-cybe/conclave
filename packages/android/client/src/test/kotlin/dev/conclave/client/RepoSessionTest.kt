package dev.conclave.client

import dev.conclave.client.logic.Inbox
import dev.conclave.client.logic.RepoAction
import dev.conclave.client.logic.RepoActions
import dev.conclave.client.logic.RepoTone
import dev.conclave.client.logic.RepoWords
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.CiState
import dev.conclave.client.model.PrDraft
import dev.conclave.client.model.PrState
import dev.conclave.client.model.RepoSessionDto
import dev.conclave.client.model.Session
import dev.conclave.client.model.repo
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Repo sessions (docs/DESIGN.md 30): meta.repo decodes, and the words and colors for the session screen. */
class RepoSessionTest {
    private fun session(meta: String?): Session =
        ConclaveJson.decodeFromString(Session.serializer(), """{"id":"ses_1","title":"Fix login","cwd":"/home/sam/.conclave/worktrees/gh/acme/widgets/fix-ab12"${meta?.let { ",\"meta\":$it" } ?: ""}}""")

    @Test
    fun `a session with meta repo is a repo session`() {
        val s = session("""{"workMs":12,"repo":{"repo":"acme/widgets","branch":"conclave/fix-login-ab12","base":"main","pr":{"number":12,"url":"https://github.com/acme/widgets/pull/12","state":"open"},"ci":"success"}}""")
        val r = s.repo!!
        assertEquals("acme/widgets", r.repo)
        assertEquals("conclave/fix-login-ab12", r.branch)
        assertEquals(PrState.OPEN, r.pr!!.state)
        assertEquals(CiState.SUCCESS, r.ci)
        assertEquals("acme/widgets on fix-login-ab12", RepoWords.where(r))
        assertEquals("#12 open", RepoWords.prShort(r.pr!!))
        assertEquals("Pull request #12 is open. Checks passed.", RepoWords.line(r))
        assertEquals(RepoTone.OK, RepoWords.tone(r))
        assertEquals("https://github.com/acme/widgets/pull/12", RepoWords.link(r))
    }

    @Test
    fun `other sessions and broken meta are not`() {
        assertNull(session(null).repo)
        assertNull(session("""{"import":{"from":"claude-code"}}""").repo)
        assertNull(session("""{"repo":"acme/widgets"}""").repo)
        assertNull(session("""{"repo":{"repo":"acme/widgets"}}""").repo)
    }

    @Test
    fun `a state a newer hub adds falls back`() {
        val r = session("""{"repo":{"repo":"acme/widgets","branch":"conclave/x","base":"main","pr":{"number":3,"url":"u","state":"queued"},"ci":"skipped"}}""").repo!!
        assertEquals(PrState.OPEN, r.pr!!.state)
        assertNull(r.ci)
        assertNull(RepoWords.link(r))
    }

    @Test
    fun `the line and tone follow the pull request`() {
        fun repo(json: String) = session("""{"repo":{"repo":"acme/widgets","branch":"conclave/x","base":"main"$json}}""").repo!!
        assertEquals("No pull request yet.", RepoWords.line(repo("")))
        assertEquals(RepoTone.QUIET, RepoWords.tone(repo("")))
        assertEquals("Pull request #3 is open as a draft. Checks are running.", RepoWords.line(repo(""","pr":{"number":3,"url":"u","state":"open","draft":true},"ci":"pending"""")))
        assertEquals(RepoTone.LIVE, RepoWords.tone(repo(""","pr":{"number":3,"url":"u","state":"open"},"ci":"pending"""")))
        assertEquals(RepoTone.FAULT, RepoWords.tone(repo(""","pr":{"number":3,"url":"u","state":"open"},"ci":"failure"""")))
        assertEquals("Pull request #3 was merged.", RepoWords.line(repo(""","pr":{"number":3,"url":"u","state":"merged"}""")))
        assertEquals(RepoTone.OK, RepoWords.tone(repo(""","pr":{"number":3,"url":"u","state":"merged"}""")))
        assertEquals("Pull request #3 was closed without a merge.", RepoWords.line(repo(""","pr":{"number":3,"url":"u","state":"closed"}""")))
        assertEquals("Cleaned up. The branch stays on GitHub.", RepoWords.line(repo(""","pr":{"number":3,"url":"u","state":"merged"},"cleaned":true""")))
        assertEquals("fix-ab12", RepoWords.branchShort("conclave/fix-ab12"))
        assertEquals("feature/x", RepoWords.branchShort("feature/x"))
    }

    private fun dto(json: String): RepoSessionDto =
        ConclaveJson.decodeFromString(RepoSessionDto.serializer(), """{"sessionId":"ses_1","repo":"acme/widgets","branch":"conclave/fix-ab12","base":"main","device":"mac","deviceName":"MacBook","online":true,"canCleanUp":false,"pushed":"never","line":"Not pushed yet."$json}""")

    @Test
    fun `the actions follow the branch and the pull request`() {
        // nothing to push yet
        assertEquals(RepoActions(push = false, openPr = false, viewPr = false, cleanUp = false), RepoWords.actions(dto(""","commits":0,"dirty":0""")))
        // commits GitHub does not have: Push and Open pull request, the phone keeps the pull request
        val fresh = RepoWords.actions(dto(""","commits":2,"dirty":0"""))
        assertTrue(fresh.push)
        assertTrue(fresh.openPr)
        assertEquals(RepoAction.OPEN_PR, RepoWords.mainAction(fresh))
        // an open pull request with new commits: Push only
        val open = RepoWords.actions(dto(""","commits":3,"pushed":"behind","pr":{"number":7,"url":"https://github.com/acme/widgets/pull/7","state":"open"}"""))
        assertTrue(open.push)
        assertFalse(open.openPr)
        assertTrue(open.viewPr)
        assertEquals(RepoAction.PUSH, RepoWords.mainAction(open))
        // merged: Clean up
        val merged = RepoWords.actions(dto(""","commits":3,"pushed":"current","canCleanUp":true,"pr":{"number":7,"url":"u","state":"merged"}"""))
        assertFalse(merged.push)
        assertEquals(RepoAction.CLEAN_UP, RepoWords.mainAction(merged))
        // the device is away: no git
        assertFalse(RepoWords.actions(dto(""","online":false,"commits":2""")).push)
        // cleaned: only the pull request's page
        assertEquals(RepoActions(push = false, openPr = false, viewPr = true, cleanUp = false), RepoWords.actions(dto(""","cleaned":true,"pr":{"number":7,"url":"u","state":"merged"}""")))
        assertTrue(RepoWords.canCheck(dto(",\"pushed\":\"current\"")))
        assertFalse(RepoWords.canCheck(dto("")))
    }

    @Test
    fun `the dialogs' words`() {
        assertEquals("2 files are not committed.", RepoWords.dirtyWords(2))
        assertEquals("1 file is not committed.", RepoWords.dirtyWords(1))
        assertEquals("Fix login", RepoWords.commitMessage(" Fix login "))
        assertEquals("Work from Conclave", RepoWords.commitMessage("New session"))
        assertEquals("acme/widgets, fix-ab12 into main.", RepoWords.prWhere("acme/widgets", PrDraft(title = "t", head = "conclave/fix-ab12", base = "main")))
        val d = dto(""","dirty":2,"canCleanUp":false""")
        assertEquals("The worktree on MacBook goes. fix-ab12 stays on GitHub. 2 files are not committed. They are lost. The pull request is not merged or closed yet.", RepoWords.cleanUpBody(d))
        assertTrue(RepoWords.cleanUpForce(d))
        assertFalse(RepoWords.cleanUpForce(dto(""","dirty":0,"canCleanUp":true""")))
        assertEquals("acme/widgets from develop", RepoWords.startWords("acme/widgets", "develop"))
        assertEquals("acme/widgets", RepoWords.startWords("acme/widgets", null))
    }

    @Test
    fun `a push or a pull request asks in words`() {
        fun input(vararg kv: Pair<String, Any>) = JsonObject(kv.associate { (k, v) -> k to if (v is Boolean) JsonPrimitive(v) else JsonPrimitive(v.toString()) })
        val push = input("action" to "push", "repo" to "acme/widgets", "branch" to "conclave/fix-ab12", "base" to "main")
        assertEquals("Push to acme/widgets?", Inbox.approvalTitle("PullRequest", "Push conclave/fix-ab12 to acme/widgets", push))
        assertEquals("Push fix-ab12 to acme/widgets.", Inbox.approvalSubject("PullRequest", "Push conclave/fix-ab12 to acme/widgets", push))
        assertEquals("Wants to push", Inbox.askLine("PullRequest", "", push))
        val open = input("action" to "open", "repo" to "acme/widgets", "branch" to "conclave/fix-ab12", "base" to "main", "title" to "Fix the login redirect", "draft" to true)
        assertEquals("Open a pull request on acme/widgets?", Inbox.approvalTitle("PullRequest", "", open))
        assertEquals("Open a pull request from fix-ab12 into main: Fix the login redirect (draft).", Inbox.approvalSubject("PullRequest", "", open))
        assertEquals("Wants to open a pull request" to "Open a pull request from fix-ab12 into main: Fix the login redirect (draft).", Inbox.approvalLines("PullRequest", "", open))
        assertFalse(Inbox.approvalMono("PullRequest"))
        assertTrue(Inbox.approvalMono("Bash"))
        // no "always" for a push, nor where the hub would count it as once
        assertFalse(Inbox.approvalWider("PullRequest", false))
        assertFalse(Inbox.approvalWider("Bash", true))
        assertTrue(Inbox.approvalWider("Bash", false))
        val a = ConclaveJson.decodeFromString(ApprovalRequest.serializer(), """{"id":"a1","tool":"PullRequest","input":{},"summary":"Push","noAlways":true}""")
        assertTrue(a.noAlways)
    }
}
