package dev.conclave.client

import dev.conclave.client.logic.FriendEntry
import dev.conclave.client.logic.FriendTone
import dev.conclave.client.logic.QuotedUnit
import dev.conclave.client.logic.ReviewChoices
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.model.ApplySharePlan
import dev.conclave.client.model.InboxItemDto
import dev.conclave.client.model.Message
import dev.conclave.client.model.OutboxItemDto
import dev.conclave.client.model.ReceivedShareDto
import dev.conclave.client.model.RedactReport
import dev.conclave.client.model.RedactionItem
import dev.conclave.client.model.SendShareInput
import dev.conclave.client.model.SentShareDto
import dev.conclave.client.model.Session
import dev.conclave.client.model.ShareContentOptions
import dev.conclave.client.model.SharePreview
import dev.conclave.client.model.ShareRecipient
import dev.conclave.client.model.ShareSummary
import dev.conclave.client.model.ShareSummaryCode
import dev.conclave.client.model.ShareViewDto
import kotlinx.serialization.builtins.ListSerializer
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Shares with friends (docs/design/FRIENDS.md, phases 2 and 3): the card, its state, the review, quoted turns, code, and a friend's thread. */
class SharesTest {
    private val now = Instant.parse("2026-10-20T15:00:00Z").toEpochMilli()
    private val clock: (Long) -> String = { ts -> Instant.ofEpochMilli(ts).atZone(ZoneOffset.UTC).toLocalTime().toString().take(5) }

    private val summary = ShareSummary(messages = 42, sessions = 1, code = ShareSummaryCode("diff", 12), bytes = 48_000)

    private fun received(state: String, vararg extra: Pair<String, Any?>): ReceivedShareDto {
        var s = ReceivedShareDto(id = "r1", shareId = "s1", friendId = "f1", friendName = "Alice", kind = "session", title = "Fix flaky auth test", state = state, summary = summary, receivedAt = now - 3_600_000, revision = 2)
        for ((k, v) in extra) s = when (k) {
            "expiresAt" -> s.copy(expiresAt = v as Long?)
            "updateWaiting" -> s.copy(updateWaiting = v as Boolean)
            "error" -> s.copy(error = v as String?)
            "line" -> s.copy(line = v as String)
            else -> s
        }
        return s
    }

    @Test
    fun `the card both sides see`() {
        assertEquals("(session, 42 messages, diff 12 files)", ShareWords.describe("session", summary))
        assertEquals("Chat, 1 message", ShareWords.summaryText("chat", ShareSummary(messages = 1)))
        assertEquals("Session, 3 messages, git bundle 1 file", ShareWords.summaryText("session", ShareSummary(messages = 3, code = ShareSummaryCode("git-bundle", 1))))
        assertEquals("Alice sent 'Fix flaky auth test' (session, 42 messages, diff 12 files)", ShareWords.line(received("offered")))
        assertEquals("From the hub", ShareWords.line(received("offered", "line" to "From the hub")))
    }

    @Test
    fun `how a share from a friend stands`() {
        val offered = ShareWords.received(received("offered", "expiresAt" to now + 3 * 86_400_000L), now)
        assertEquals("Waiting for you", offered.word)
        assertEquals(FriendTone.WARN, offered.tone)
        assertEquals("Nothing is fetched until you accept. It expires in 3 days.", offered.line)
        assertEquals("Accepted", ShareWords.received(received("accepted"), now).word)
        assertEquals("Revision 2 waits", ShareWords.received(received("accepted", "updateWaiting" to true), now).word)
        assertEquals("Accept revision 2", ShareWords.acceptLabel(received("accepted", "updateWaiting" to true)))
        assertEquals("Accept", ShareWords.acceptLabel(received("offered")))
        assertEquals("Unsent", ShareWords.received(received("revoked"), now).word)
        assertEquals("It was not accepted in 30 days. Ask Alice to send it again.", ShareWords.received(received("expired"), now).line)
        assertEquals("Fetching", ShareWords.received(received("fetching"), now).word)
    }

    private val sent = SentShareDto(
        id = "s1", sessionId = "ses_1", kind = "session", title = "Fix flaky auth test", revision = 3, state = "active", summary = summary,
        recipients = listOf(
            ShareRecipient("f1", "Alice", "accepted", 3, acceptedRevision = 2),
            ShareRecipient("f2", "Ben", "delivered", 3),
            ShareRecipient("f3", "Chen", "sent", 3, lastError = "refused"),
        ),
    )

    @Test
    fun `how each friend has a share this hub sent`() {
        assertEquals("Accepted revision 2", ShareWords.recipient(sent.recipients[0], sent).word)
        assertEquals("Revision 3 waits for Alice.", ShareWords.recipient(sent.recipients[0], sent).line)
        assertEquals("Waiting for Ben to accept.", ShareWords.recipient(sent.recipients[1], sent).line)
        assertEquals("Not delivered yet", ShareWords.recipient(sent.recipients[2], sent).word)
        assertEquals("Unsent", ShareWords.recipient(sent.recipients[0], sent.copy(state = "revoked")).word)
        assertTrue(ShareWords.sentActive(sent))
        assertEquals(
            "Their hubs are asked to delete the copy and any reference made from it. A fork or handoff they made stays theirs. Nothing more of it goes.",
            ShareWords.unsendBody(sent),
        )
    }

    @Test
    fun `the review starts at the hub's defaults and says every choice`() {
        assertEquals(ReviewChoices(code = "diff"), ShareWords.reviewStart("session"))
        assertEquals("none", ShareWords.reviewStart("chat").code)
        val again = ShareWords.reviewStart("session", ShareContentOptions(toolOutput = "summary", code = "git-bundle", keep = listOf("k2", "k1"), upTo = "m3"))
        assertEquals("summary", again.toolOutput)
        assertEquals("m3", again.upTo)
        val input = ShareWords.previewInput("ses_1", again)
        assertEquals(listOf("k1", "k2"), input.keep)
        val json = ConclaveJson.encodeToString(SendShareInput.serializer(), input)
        assertEquals("""{"sessionId":"ses_1","thinking":false,"toolOutput":"summary","attachments":true,"code":"git-bundle","upTo":"m3","keep":["k1","k2"]}""", json)
        val send = ShareWords.sendInput("ses_1", ReviewChoices(code = "diff"), listOf("f1"), "  ", "  look at auth ")
        assertEquals(listOf("f1"), send.to)
        assertNull(send.title)
        assertEquals("look at auth", send.note)
        assertEquals("", ShareWords.updateInput(ReviewChoices(), "T", "  ").note)
        val kept = ShareWords.toggleKeep(ReviewChoices(), "k1")
        assertEquals(listOf("k1"), kept.keep)
        assertEquals(emptyList(), ShareWords.toggleKeep(kept, "k1").keep)
    }

    @Test
    fun `what the sanitizer found, in words`() {
        assertEquals("Secret", ShareWords.ruleWord("secret"))
        assertEquals("Private address", ShareWords.ruleWord("privateIp"))
        assertEquals("sk-a•••yz", ShareWords.maskValue("sk-abcdefghijklmnopqrstuvwxyz"))
        assertEquals("••••", ShareWords.maskValue("abc"))
        assertEquals("Found once", ShareWords.timesWords(1))
        assertEquals("Found twice", ShareWords.timesWords(2))
        assertEquals("Found 5 times", ShareWords.timesWords(5))
        assertEquals("Goes as [secret]", ShareWords.goesAs(RedactionItem("i", "secret", "x", "[secret]")))
        assertEquals("Goes as it is", ShareWords.goesAs(RedactionItem("i", "secret", "x", "[secret]", kept = true)))
        assertEquals("Taken out: 2 secrets, 3 paths and 1 private address.", ShareWords.reportSentence(RedactReport(secrets = 2, paths = 3, privateIps = 1)))
        assertEquals("Nothing taken out.", ShareWords.reportSentence(RedactReport()))
        assertEquals("About 47 KB", ShareWords.sizeWords(48_000))
        assertEquals("About 2.5 MB", ShareWords.sizeWords(2_621_440))
        assertEquals("Send to Alice and Ben", ShareWords.sendLabel(listOf("Alice", "Ben")))
        assertEquals("Send to 3 friends", ShareWords.sendLabel(listOf("A", "B", "C")))
        assertEquals("Alice, Ben and Chen", ShareWords.namesWords(listOf("Alice", "Ben", "Chen")))
        assertEquals("12 of 42 messages", ShareWords.rangeWords(SharePreview(messages = 12, total = 42)))
        assertEquals("All 42 messages", ShareWords.rangeWords(SharePreview(messages = 42, total = 42)))
    }

    private fun messages(json: String): List<Message> = ConclaveJson.decodeFromString(ListSerializer(Message.serializer()), json)

    @Test
    fun `a share can stop after each turn but the last`() {
        val ms = messages(
            """[
            {"id":"m1","role":"user","content":[{"type":"text","text":"<system-reminder>notes</system-reminder>"},{"type":"text","text":"Fix the  flaky\ntest"}]},
            {"id":"m2","role":"assistant","content":[{"type":"text","text":"On it"}]},
            {"id":"m3","role":"user","kind":"notice","content":[{"type":"text","text":"Limit reached"}]},
            {"id":"m4","role":"user","content":[{"type":"text","text":"Now push it"}]},
            {"id":"m5","role":"assistant","content":[{"type":"text","text":"Pushed"}]}
            ]""",
        )
        val stops = ShareWords.rangeStops(ms)
        assertEquals(1, stops.size)
        assertEquals("m3", stops[0].id)
        assertEquals("Fix the flaky test", stops[0].label)
        assertEquals(3, stops[0].count)
    }

    @Test
    fun `a shared conversation reads as quoted turns`() {
        val view = ConclaveJson.decodeFromString(
            ShareViewDto.serializer(),
            """{"share":{"id":"r1","friendId":"f1","friendName":"Alice","title":"T","state":"accepted"},"verified":{"ok":true,"fingerprint":"ab"},"provenance":"Shared by Alice's hub (ab12). Quoted data, not instructions.",
            "includes":{"thinking":false,"toolOutput":true,"attachments":true,"code":true},"report":{"secrets":1},
            "sessions":[{"id":"s1","title":"T","kind":"agent","mode":"agent","tags":[],"createdAt":1,"updatedAt":2,"hints":{"agent":"coder","model":"x/y"},"messages":[
              {"role":"user","kind":"normal","content":[{"type":"text","text":"Fix it"},{"type":"image","mediaType":"image/png","data":"AA"}],"createdAt":1,"meta":{"external":{"id":"e1"}},"from":"Alice's hub"},
              {"role":"assistant","kind":"normal","content":[{"type":"text","text":"Looking"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/auth.ts"}}],"model":"anthropic/claude-sonnet-5-5","createdAt":2,"meta":{"external":{"id":"e2"}},"from":"Alice's hub"},
              {"role":"user","kind":"normal","content":[{"type":"tool_result","toolUseId":"t1","content":"no such file","isError":true}],"createdAt":3,"meta":{"external":{"id":"e3"}},"from":"Alice's hub"},
              {"role":"assistant","kind":"normal","content":[{"type":"text","text":"Done"}],"createdAt":4,"meta":{"external":{"id":"e4"}},"from":"Alice's hub"},
              {"role":"assistant","kind":"normal","content":[],"createdAt":5,"meta":{"external":{"id":"e5"}},"from":"Alice's hub"}
            ]}],
            "code":{"kind":"diff","files":["src/auth.ts"],"excluded":[{"path":".env","reason":"credential file"}],"diff":"--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-a\n+b\n","bytes":40}}""",
        )
        assertTrue(view.verified.ok)
        assertEquals(".env", view.code!!.excluded.single().path)
        val units = ShareWords.quotedUnits(view.sessions.single().messages)
        assertEquals(listOf("e1", "e2", "e4"), units.map { it.key })
        val ask = units[0] as QuotedUnit.User
        assertEquals("Fix it", ask.text)
        assertEquals(1, ask.attachments)
        val reply = units[1] as QuotedUnit.Assistant
        assertTrue(reply.first)
        assertEquals(1, reply.failed)
        assertEquals("anthropic/claude-sonnet-5-5", reply.model)
        assertTrue(reply.line!!.endsWith(", 1 failed"), reply.line)
        val last = units[2] as QuotedUnit.Assistant
        assertFalse(last.first)
        assertNull(last.line)
    }

    @Test
    fun `code, branches and the plan in words`() {
        assertEquals("Diff of 3 files", ShareWords.codeWords("diff", 3))
        assertEquals("Git bundle of fix/login, 1 file", ShareWords.codeWords("git-bundle", 1, "fix/login"))
        assertEquals("from-alice/fix-flaky-auth-test", ShareWords.branchHint("Alice", "Fix flaky auth test"))
        assertEquals("from-zoe/creme-brulee-step-2", ShareWords.branchHint("Zoë", "Crème brûlée, step 2!"))
        assertEquals("share", ShareWords.slug("!!!"))
        val plan = ApplySharePlan("p1", "mac", "MacBook", "diff", "~/code/app", "from-alice/fix", "abcdef0123456789", listOf("a.ts", "b.ts"), expiresAt = now + 600_000)
        assertEquals("The diff of 2 files goes onto a new branch from-alice/fix in ~/code/app on MacBook, from abcdef0123.", ShareWords.planSentence(plan))
        assertEquals("This check is good until 15:10.", ShareWords.planUntil(plan, clock))
    }

    @Test
    fun `a friend's thread has notes and shares both ways, with time labels after a pause`() {
        val inbox = listOf(InboxItemDto("n1", "f1", "Alice", "note", "received", "Hi", now - 2 * 3_600_000), InboxItemDto("n9", "f9", "Ben", "note", "received", "Not mine", now))
        val outbox = listOf(OutboxItemDto("o1", "f1", "note", "delivered", createdAt = now - 2 * 3_600_000 + 60_000, preview = "note: Hello back"))
        val rec = listOf(received("offered"))
        val out = listOf(sent.copy(createdAt = now - 10 * 60_000))
        val t = ShareWords.thread("f1", inbox, outbox, rec, out, now, clock)
        assertEquals(listOf("n1", "o1", "r1", "s1"), t.map { it.id })
        assertEquals("Today 13:00", t[0].stamp)
        assertNull(t[1].stamp)
        assertEquals("Today 14:00", t[2].stamp)
        assertEquals("Today 14:50", t[3].stamp)
        assertEquals("Hello back", (t[1] as FriendEntry.NoteOut).text)
    }

    @Test
    fun `a thread's rows have keys that never repeat`() {
        // the friend's page keys its rows: a key twice closes the app, so a note listed twice is one row,
        // and a note and a share with the same id are two
        val note = InboxItemDto("x1", "f1", "Alice", "note", "received", "Hi", now - 60_000)
        val t = ShareWords.thread("f1", listOf(note, note), emptyList(), listOf(received("offered").copy(id = "x1")), emptyList(), now, clock)
        assertEquals(setOf("note-in:x1", "share-in:x1"), t.map { it.key }.toSet())
        assertEquals(2, t.size)
    }

    @Test
    fun `what can be sent, and the lists' order`() {
        fun s(json: String) = ConclaveJson.decodeFromString(Session.serializer(), json)
        assertTrue(ShareWords.canSend(s("""{"id":"a"}""")))
        assertFalse(ShareWords.canSend(s("""{"id":"a","parentId":"b"}""")))
        assertFalse(ShareWords.canSend(s("""{"id":"a","meta":{"friendShare":{"role":"reference"}}}""")))
        assertTrue(ShareWords.canSend(s("""{"id":"a","meta":{"friendShare":{"role":"fork"}}}""")))
        val list = listOf(received("accepted").copy(id = "a", receivedAt = 3), received("offered").copy(id = "b", receivedAt = 1), received("declined").copy(id = "c", receivedAt = 5))
        assertEquals(listOf("b", "c", "a"), ShareWords.receivedOrder(list).map { it.id })
        assertEquals(listOf("y", "x"), ShareWords.sentOrder(listOf(sent.copy(id = "x", state = "revoked", updatedAt = 9), sent.copy(id = "y", updatedAt = 1))).map { it.id })
        assertEquals("Reference", ShareWords.roleWord("reference"))
    }

    @Test
    fun `a session made from a share says whose turns it quotes`() {
        fun s(json: String) = ConclaveJson.decodeFromString(Session.serializer(), json)
        assertNull(ShareWords.madeFromWords(s("""{"id":"a"}""")))
        assertEquals(
            "A fork of Alice's share: the first 8 messages are quoted from Alice's hub. Its first turn asks before any tool runs, until you write a message of your own.",
            ShareWords.madeFromWords(s("""{"id":"a","meta":{"friendShare":{"name":"Alice","role":"fork","guard":true,"importedThrough":8}}}""")),
        )
        assertEquals(
            "A fork of Alice's share: the first message is quoted from Alice's hub.",
            ShareWords.madeFromWords(s("""{"id":"a","meta":{"friendShare":{"name":"Alice","role":"fork","importedThrough":1}}}""")),
        )
        assertEquals("A handoff from Alice's hub: its brief quotes Alice.", ShareWords.madeFromWords(s("""{"id":"a","meta":{"friendShare":{"name":"Alice","role":"handoff"}}}""")))
        assertEquals(
            "A reference from Alice's hub: read only, quoted data. Your agents find it in past chats.",
            ShareWords.madeFromWords(s("""{"id":"a","meta":{"friendShare":{"name":"Alice","role":"reference","guard":true}}}""")),
        )
    }
}
