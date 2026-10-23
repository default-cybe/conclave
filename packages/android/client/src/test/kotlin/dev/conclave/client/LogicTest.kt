package dev.conclave.client

import dev.conclave.client.logic.ChatItem
import dev.conclave.client.logic.ChatItems
import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.DiffLine
import dev.conclave.client.logic.Diffs
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.HubAddress
import dev.conclave.client.logic.ModelFamily
import dev.conclave.client.logic.NetworkKind
import dev.conclave.client.logic.SessionGrouping
import dev.conclave.client.logic.Sessions
import dev.conclave.client.logic.ToolSummary
import dev.conclave.client.logic.Transcript
import dev.conclave.client.logic.TranscriptReducer
import dev.conclave.client.model.DeltaKind
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.Session
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDateTime
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TranscriptTest {
    private fun msg(id: String, seq: Long, role: Role = Role.ASSISTANT, vararg blocks: dev.conclave.client.model.ContentBlock) =
        Message(id = id, sessionId = "s1", seq = seq, role = role, content = blocks.toList())

    @Test
    fun appliesDeltasToTheRightBlock() {
        var t = Transcript("s1")
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(msg("m1", 1)))
        t = TranscriptReducer.apply(t, EngineEvent.MessageDelta("s1", "m1", 0, DeltaKind.THINKING, "Let me "))
        t = TranscriptReducer.apply(t, EngineEvent.MessageDelta("s1", "m1", 0, DeltaKind.THINKING, "think"))
        t = TranscriptReducer.apply(t, EngineEvent.MessageDelta("s1", "m1", 1, DeltaKind.TEXT, "Hel"))
        t = TranscriptReducer.apply(t, EngineEvent.MessageDelta("s1", "m1", 1, DeltaKind.TEXT, "lo"))
        t = TranscriptReducer.apply(t, EngineEvent.MessageDelta("s1", "m1", 2, DeltaKind.TOOL_INPUT, "{\"comm"))
        t = TranscriptReducer.apply(t, EngineEvent.MessageDelta("other", "m1", 1, DeltaKind.TEXT, "IGNORED"))
        val content = t.messages.single().content
        assertEquals(ThinkingBlock("Let me think"), content[0])
        assertEquals(TextBlock("Hello"), content[1])
        assertEquals("{\"comm", (content[2] as ToolUseBlock).partialInput)
    }

    @Test
    fun deltaBeforeCreateMakesPlaceholderThenGetsReplaced() {
        var t = TranscriptReducer.merge(Transcript("s1"), listOf(msg("m0", 1, Role.USER, TextBlock("hi"))))
        t = TranscriptReducer.apply(t, EngineEvent.MessageDelta("s1", "m1", 0, DeltaKind.TEXT, "Yo"))
        assertEquals(listOf("m0", "m1"), t.messages.map { it.id })
        assertEquals(2, t.messages[1].seq)
        t = TranscriptReducer.apply(t, EngineEvent.MessageUpdated(msg("m1", 2, Role.ASSISTANT, TextBlock("Yo there"))))
        assertEquals(TextBlock("Yo there"), t.messages[1].content.single())
    }

    @Test
    fun keepsMessagesSortedAndCollectsToolResults() {
        val use = ToolUseBlock(id = "t1", name = "Bash", input = buildJsonObject { put("command", "ls") })
        var t = Transcript("s1")
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(msg("m3", 3, Role.USER, ToolResultBlock("t1", JsonPrimitive("a.txt")))))
        t = TranscriptReducer.apply(t, EngineEvent.MessageCreated(msg("m2", 2, Role.ASSISTANT, use)))
        assertEquals(listOf("m2", "m3"), t.messages.map { it.id })
        assertEquals("a.txt", t.toolResults["t1"]?.text)

        t = TranscriptReducer.apply(t, EngineEvent.ToolStarted("s1", "m2", "t2", "Read", JsonObject(emptyMap())))
        t = TranscriptReducer.apply(t, EngineEvent.ToolProgress("s1", "t2", "reading"))
        assertTrue("t2" in t.runningTools)
        assertEquals("reading", t.toolProgress["t2"])
        t = TranscriptReducer.apply(t, EngineEvent.ToolCompleted("s1", "t2", ToolResultBlock("t2", JsonPrimitive("ok"))))
        assertFalse("t2" in t.runningTools)
        assertNull(t.toolProgress["t2"])
        assertEquals("ok", t.toolResults["t2"]?.text)
    }

    @Test
    fun mergeDeduplicatesById() {
        var t = TranscriptReducer.merge(Transcript("s1"), listOf(msg("a", 1), msg("b", 2)))
        t = TranscriptReducer.merge(t, listOf(msg("b", 2, Role.ASSISTANT, TextBlock("new")), msg("c", 3)))
        assertEquals(listOf("a", "b", "c"), t.messages.map { it.id })
        assertEquals(TextBlock("new"), t.messages[1].content.single())
        assertEquals(3, t.lastSeq)
    }

    @Test
    fun aLateFetchDoesNotUndoAFinishedReply() {
        // the GET left while the reply streamed; message.updated with the end came before its answer
        var t = TranscriptReducer.apply(Transcript("s1"), EngineEvent.MessageCreated(msg("m1", 1)))
        t = TranscriptReducer.apply(t, EngineEvent.MessageUpdated(msg("m1", 1, Role.ASSISTANT, TextBlock("Done.")).copy(stopReason = "end_turn")))
        t = TranscriptReducer.merge(t, listOf(msg("m0", 0, Role.USER, TextBlock("hi")), msg("m1", 1)))
        assertEquals(listOf("m0", "m1"), t.messages.map { it.id })
        assertEquals(TextBlock("Done."), t.messages[1].content.single())
        assertEquals("end_turn", t.messages[1].stopReason)

        // a finished copy from the hub still replaces a finished one here (the hub cleared old tool output)
        t = TranscriptReducer.merge(t, listOf(msg("m1", 1, Role.ASSISTANT, TextBlock("Cleared.")).copy(stopReason = "end_turn")))
        assertEquals(TextBlock("Cleared."), t.messages[1].content.single())
    }

    @Test
    fun aReloadStartsBeforeTheReplyStillOpen() {
        assertNull(TranscriptReducer.reloadAfter(Transcript("s1")))
        // a reply left open by a turn that failed (the hub dropped it), then one that ended
        val failed = msg("a0", 2, Role.ASSISTANT)
        val done = msg("a1", 4, Role.ASSISTANT, TextBlock("Yes.")).copy(stopReason = "end_turn")
        val asked = msg("u2", 5, Role.USER, TextBlock("And?"))
        var t = TranscriptReducer.merge(Transcript("s1"), listOf(msg("u1", 1, Role.USER, TextBlock("Hi")), failed, msg("u1b", 3, Role.USER, TextBlock("Again")), done, asked))
        assertEquals(5, TranscriptReducer.reloadAfter(t))
        // the reply that streamed when the socket dropped comes again, with what followed it
        t = TranscriptReducer.merge(t, listOf(msg("a2", 6, Role.ASSISTANT, TextBlock("Half")), msg("u3", 7, Role.USER, TextBlock("Queued"))))
        assertEquals(5, TranscriptReducer.reloadAfter(t))
    }
}

class ChatItemsTest {
    @Test
    fun groupsJuryAndHidesToolResultTurns() {
        val msgs = listOf(
            Message("u1", "s1", 1, Role.USER, content = listOf(TextBlock("q"))),
            Message("j1", "s1", 2, Role.ASSISTANT, MessageKind.ASIDE, listOf(TextBlock("a1")), model = "openai/gpt-5.5", author = "Juror 1", group = "g"),
            Message("j2", "s1", 3, Role.ASSISTANT, MessageKind.ASIDE, listOf(TextBlock("a2")), model = "zai/glm-5", author = "Juror 2", group = "g"),
            Message("v", "s1", 4, Role.ASSISTANT, MessageKind.NORMAL, listOf(TextBlock("verdict")), group = "g"),
            Message("a", "s1", 5, Role.ASSISTANT, MessageKind.ASIDE, listOf(TextBlock("second")), author = "Second opinion", group = "solo"),
            Message("n", "s1", 6, Role.ASSISTANT, MessageKind.NOTICE, listOf(TextBlock("Limit hit"))),
            Message("r", "s1", 7, Role.USER, content = listOf(ToolResultBlock("t1"))),
            Message("x", "s1", 8, Role.ASSISTANT, content = listOf(TextBlock("done"))),
        )
        val items = ChatItems.build(msgs)
        assertEquals(listOf("u1", "group:g", "a", "n", "x"), items.map { it.key })
        val jury = items[1] as ChatItem.Jury
        assertEquals(listOf("j1", "j2"), jury.answers.map { it.id })
        assertEquals("v", jury.verdict?.id)
        assertIs<ChatItem.Aside>(items[2])
        assertIs<ChatItem.Notice>(items[3])
    }
}

class HubAddressTest {
    @Test
    fun classifiesHosts() {
        assertEquals(NetworkKind.VPN, HubAddress.classifyHost("100.101.102.103"))
        assertEquals(NetworkKind.PUBLIC, HubAddress.classifyHost("100.128.0.1"))
        assertEquals(NetworkKind.VPN, HubAddress.classifyHost("hub.tail1234.ts.net"))
        assertEquals(NetworkKind.LAN, HubAddress.classifyHost("192.168.1.20"))
        assertEquals(NetworkKind.LAN, HubAddress.classifyHost("10.0.2.2"))
        assertEquals(NetworkKind.LAN, HubAddress.classifyHost("172.20.0.5"))
        assertEquals(NetworkKind.PUBLIC, HubAddress.classifyHost("172.32.0.5"))
        assertEquals(NetworkKind.LAN, HubAddress.classifyHost("nas.local"))
        assertEquals(NetworkKind.LAN, HubAddress.classifyHost("nas"))
        assertEquals(NetworkKind.LOCALHOST, HubAddress.classifyHost("localhost"))
        assertEquals(NetworkKind.LOCALHOST, HubAddress.classifyHost("127.0.0.1"))
        assertEquals(NetworkKind.LOCALHOST, HubAddress.classifyHost("[::1]"))
        assertEquals(NetworkKind.VPN, HubAddress.classifyHost("fd7a:115c:a1e0::1"))
        assertEquals(NetworkKind.PUBLIC, HubAddress.classifyHost("example.com"))
        assertEquals(NetworkKind.PUBLIC, HubAddress.classifyHost("8.8.8.8"))
    }

    @Test
    fun warnsOnlyForPlainHttpToPublicHosts() {
        assertTrue(HubAddress.parse("http://example.com:8787")!!.needsWarning)
        assertFalse(HubAddress.parse("https://example.com")!!.needsWarning)
        assertFalse(HubAddress.parse("http://100.64.1.2:8787")!!.needsWarning)
        assertFalse(HubAddress.parse("http://192.168.1.4:8787/")!!.needsWarning)
        val bare = HubAddress.parse("192.168.1.4:8787")!!
        assertEquals("http://192.168.1.4:8787", bare.url)
        assertEquals("https://hub.example.com", HubAddress.parse("hub.example.com")!!.url)
        assertNull(HubAddress.parse("ftp://x"))
        assertNull(HubAddress.parse(""))
    }
}

class DeepLinkTest {
    @Test
    fun parsesPairLinks() {
        val link = DeepLink.parse("conclave://pair?url=https%3A%2F%2Fhub.tail.ts.net%3A8787&code=482913")
        assertEquals(DeepLink.Pair("https://hub.tail.ts.net:8787", "482913"), link)
        assertNull(DeepLink.parse("conclave://pair?url=https%3A%2F%2Fx"))
    }

    @Test
    fun parsesSessionLinks() {
        assertEquals(DeepLink.Session("abc"), DeepLink.parse("conclave://session/abc"))
        assertEquals(DeepLink.Session("abc"), DeepLink.parse("/s/abc"))
        assertEquals(DeepLink.Session("abc"), DeepLink.parse("https://hub.example.com/s/abc"))
        assertEquals(DeepLink.NewChat, DeepLink.parse("conclave://new"))
        assertEquals(DeepLink.Approvals, DeepLink.parse("conclave://approvals"))
        assertNull(DeepLink.parse("conclave://other"))
        assertNull(DeepLink.parse(null))
    }
}

class FormatTest {
    @Test
    fun formatsCountdowns() {
        assertEquals("now", Format.countdown(0))
        assertEquals("45s", Format.countdown(45_000))
        assertEquals("2m 05s", Format.countdown(125_000))
        assertEquals("4h 12m", Format.countdown((4 * 3600 + 12 * 60) * 1000L))
        assertEquals("2d 3h", Format.countdown((2 * 86_400 + 3 * 3600) * 1000L))
    }

    @Test
    fun formatsNumbers() {
        assertEquals("950", Format.tokens(950))
        assertEquals("1.2k", Format.tokens(1234))
        assertEquals("45k", Format.tokens(45_400))
        assertEquals("3.4M", Format.tokens(3_400_000))
        assertEquals("$0", Format.usd(0.0))
        assertEquals("$1.50", Format.usd(1.5))
        assertEquals("$1,234", Format.usd(1234.0))
        assertEquals("5m ago", Format.relative(1_000_000 - 5 * 60_000, now = 1_000_000))
        assertEquals("in 2h", Format.relative(1_000_000 + 2 * 3_600_000, now = 1_000_000))
    }

    @Test
    fun detectsModelFamilies() {
        assertEquals(ModelFamily.CLAUDE, ModelFamily.of("anthropic/claude-opus-5"))
        assertEquals(ModelFamily.CLAUDE, ModelFamily.of("claude-code"))
        assertEquals(ModelFamily.OPENAI, ModelFamily.of("openai/gpt-5.5"))
        assertEquals(ModelFamily.OPENAI, ModelFamily.of("codex"))
        assertEquals(ModelFamily.GEMINI, ModelFamily.of("google/gemini-3-pro"))
        assertEquals(ModelFamily.GLM, ModelFamily.of("zai/glm-5"))
        assertEquals(ModelFamily.OTHER, ModelFamily.of("ollama/qwen3"))
        assertEquals("gpt-5.5", Format.modelLabel("openai/gpt-5.5"))
    }
}

class SessionsTest {
    private val zone = ZoneOffset.UTC
    private fun at(day: Int, hour: Int) = LocalDateTime.of(2026, 10, day, hour, 0).toInstant(zone).toEpochMilli()

    @Test
    fun groupsByDateWithPinnedFirst() {
        val now = at(16, 12)
        val sessions = listOf(
            Session("a", updatedAt = at(16, 9)),
            Session("b", updatedAt = at(15, 9)),
            Session("c", updatedAt = at(12, 9)),
            Session("d", updatedAt = at(1, 9)),
            Session("p", updatedAt = at(2, 9), pinned = true),
            Session("e", updatedAt = at(16, 11)),
        )
        val groups = Sessions.group(sessions, SessionGrouping.DATE, now, zone)
        assertEquals(listOf("Pinned", "Today", "Yesterday", "This week", "This month"), groups.map { it.title })
        assertEquals(listOf("e", "a"), groups[1].sessions.map { it.id })
    }

    @Test
    fun groupsByAgentAndTask() {
        val sessions = listOf(
            Session("a", agent = "reviewer", updatedAt = 1),
            Session("b", agent = "coder", updatedAt = 2, taskId = "t1"),
            Session("c", agent = "coder", updatedAt = 3),
        )
        assertEquals(listOf("coder", "reviewer"), Sessions.group(sessions, SessionGrouping.AGENT).map { it.title })
        val byTask = Sessions.group(sessions, SessionGrouping.TASK, taskTitles = mapOf("t1" to "Ship v1"))
        assertEquals(listOf("Ship v1", "No task"), byTask.map { it.title })
    }
}

class ToolsTest {
    @Test
    fun summarizesTools() {
        assertEquals("Run: npm test", ToolSummary.of("Bash", buildJsonObject { put("command", "npm test\nmore") }))
        assertEquals("Edit /a/b.kt", ToolSummary.of("Edit", buildJsonObject { put("file_path", "/a/b.kt") }))
        assertEquals("mcp__x: hello", ToolSummary.of("mcp__x", buildJsonObject { put("q", "hello") }))
        assertEquals("Thing", ToolSummary.of("Thing", JsonObject(emptyMap())))
    }

    @Test
    fun parsesAndBuildsDiffs() {
        val lines = Diffs.parse("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n")
        assertEquals(
            listOf(DiffLine.Kind.META, DiffLine.Kind.META, DiffLine.Kind.HUNK, DiffLine.Kind.CONTEXT, DiffLine.Kind.DEL, DiffLine.Kind.ADD),
            lines.map { it.kind },
        )
        val edit = ToolUseBlock("t", "Edit", buildJsonObject { put("old_string", "a\nb"); put("new_string", "c") })
        assertEquals(listOf("-a", "-b", "+c"), Diffs.forTool(edit, null)!!.map { it.text })
        val withMeta = ToolResultBlock("t", JsonPrimitive("ok"), meta = dev.conclave.client.model.ToolResultMeta(diff = "+only"))
        assertEquals(listOf("+only"), Diffs.forTool(edit, withMeta)!!.map { it.text })
        assertNull(Diffs.forTool(ToolUseBlock("t", "Bash"), null))
    }
}
