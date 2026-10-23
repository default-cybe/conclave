package dev.conclave.client

import dev.conclave.client.logic.ChatList
import dev.conclave.client.logic.ChatLive
import dev.conclave.client.logic.ChatSources
import dev.conclave.client.logic.ChatTools
import dev.conclave.client.logic.ChatUnit
import dev.conclave.client.logic.ChatUnits
import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.LivePhase
import dev.conclave.client.model.ChatSettings
import dev.conclave.client.model.ChatSettingsPatch
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.CreateSessionInput
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.SearchResultRef
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionPatch
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ModelEffort
import dev.conclave.client.model.ThinkingLevel
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolResultMeta
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.isReminder
import dev.conclave.client.model.visibleText
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private fun m(
    id: String,
    seq: Long,
    role: Role = Role.ASSISTANT,
    vararg blocks: ContentBlock,
    kind: MessageKind = MessageKind.NORMAL,
    model: String? = null,
    stop: String? = "end_turn",
    meta: JsonObject? = null,
) = Message(id = id, sessionId = "c1", seq = seq, role = role, kind = kind, content = blocks.toList(), model = model, stopReason = if (role == Role.ASSISTANT) stop else null, meta = meta)

private fun user(id: String, seq: Long, text: String) = m(id, seq, Role.USER, TextBlock(text))

class ChatModelsTest {
    private val json = ConclaveJson

    @Test
    fun decodesChatSessionsAndOldSessions() {
        val chat = json.decodeFromString(
            Session.serializer(),
            """{"id":"c1","title":"Caddy","agent":"chat","kind":"chat","chat":{"webSearch":false,"memory":true,"thinking":"low"}}""",
        )
        assertTrue(chat.isChat)
        assertEquals(SessionKind.CHAT, chat.kind)
        assertEquals(ChatSettings(webSearch = false, memory = true, thinking = ThinkingLevel.LOW), chat.chat)

        val old = json.decodeFromString(Session.serializer(), """{"id":"s1","title":"Fix build"}""")
        assertFalse(old.isChat)
        assertNull(old.kind)
        assertNull(old.chatSettings)

        // a chat with no stored switches has both on
        val bare = json.decodeFromString(Session.serializer(), """{"id":"c2","kind":"chat"}""")
        assertEquals(ChatSettings(), bare.chatSettings)

        // a kind from a newer hub falls back to an agent session
        val future = json.decodeFromString(Session.serializer(), """{"id":"x","kind":"canvas","chat":{"webSearch":true,"memory":false,"thinking":"extreme"}}""")
        assertFalse(future.isChat)
        assertNull(future.chat?.thinking)
        // ultra is a level now (ChatGPT plans offer it)
        val ultra = json.decodeFromString(Session.serializer(), """{"id":"u","kind":"chat","chat":{"thinking":"ultra"}}""")
        assertEquals(ThinkingLevel.ULTRA, ultra.chat?.thinking)
        // Claude's two levels above high decode
        val max = json.decodeFromString(Session.serializer(), """{"id":"y","kind":"chat","chat":{"thinking":"max"}}""")
        assertEquals(ThinkingLevel.MAX, max.chat?.thinking)
    }

    @Test
    fun decodesThinkingDurationAndSearchResults() {
        val msg = json.decodeFromString(
            Message.serializer(),
            """{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"hm","durationMs":3400}]}""",
        )
        assertEquals(3400L, (msg.content[0] as ThinkingBlock).durationMs)

        val r = json.decodeFromString(
            ToolResultBlock.serializer(),
            """{"toolUseId":"t1","content":"...","meta":{"provider":"brave","count":2,"results":[
                {"title":"Automatic HTTPS","url":"https://caddyserver.com/docs/automatic-https","date":"2026-08-12"},
                {"title":"Caddy certificates","url":"https://tailscale.com/kb/1190"}]}}""",
        )
        assertEquals("brave", r.meta?.provider)
        assertEquals(2, r.meta?.count)
        assertEquals("2026-08-12", r.meta?.results?.first()?.date)

        val save = json.decodeFromString(ToolResultBlock.serializer(), """{"toolUseId":"t2","content":"Saved","meta":{"memoryId":"mem_1"}}""")
        assertEquals("mem_1", save.meta?.memoryId)
    }

    @Test
    fun encodesChatRequests() {
        val create = json.encodeToString(
            CreateSessionInput.serializer(),
            CreateSessionInput(kind = SessionKind.CHAT, model = "anthropic/claude-sonnet-5-5", chat = ChatSettingsPatch(webSearch = false), prompt = "hi"),
        )
        assertEquals("""{"model":"anthropic/claude-sonnet-5-5","prompt":"hi","kind":"chat","chat":{"webSearch":false}}""", create)

        val c = ConclaveClient("http://hub.test", "t")
        assertEquals(
            """{"chat":{"memory":false}}""",
            c.sessionPatchJson(SessionPatch(chat = ChatSettingsPatch(memory = false))).toString(),
        )
        assertEquals(
            """{"chat":{"thinking":"high"}}""",
            c.sessionPatchJson(SessionPatch(chat = ChatSettingsPatch(thinking = ThinkingLevel.HIGH))).toString(),
        )
        // back to the agent's setting is an explicit null
        assertEquals(
            """{"chat":{"thinking":null}}""",
            c.sessionPatchJson(SessionPatch(chat = ChatSettingsPatch(agentThinking = true))).toString(),
        )
        assertEquals(
            """{"agent":"coder","cwd":"~/src","device":"madx","kind":"agent"}""",
            c.sessionPatchJson(SessionPatch(agent = "coder", cwd = "~/src", device = "madx", kind = SessionKind.AGENT)).toString(),
        )
    }

    @Test
    fun hidesTheHubsReminders() {
        val m = json.decodeFromString(
            Message.serializer(),
            """{"id":"u1","role":"user","meta":{"recalled":["mem_1"]},"content":[{"type":"text","text":"can caddy do certs?"},
               {"type":"text","text":"<system-reminder>\nRelevant memories:\n- [mem_1] Caddy runs in LXC 101.\n</system-reminder>"}]}""",
        )
        assertEquals("can caddy do certs?", m.content.visibleText())
        assertTrue(m.content[1].isReminder())
        assertFalse(m.content[0].isReminder())
    }

    @Test
    fun parsesChatLinks() {
        assertEquals(DeepLink.Chat("c1"), DeepLink.parse("conclave://chat/c1"))
        assertEquals(DeepLink.Chat("c 2"), DeepLink.parse("/chat/c%202"))
        assertEquals(DeepLink.NewChat, DeepLink.parse("conclave://chat"))
        assertEquals(DeepLink.Session("s1"), DeepLink.parse("https://hub.tail.ts.net/s/s1"))
    }

    @Test
    fun formatsShortDurations() {
        assertEquals("0s", Format.durationShort(200))
        assertEquals("12s", Format.durationShort(12_400))
        assertEquals("1m", Format.durationShort(65_000))
        assertEquals("1h 12m", Format.durationShort(72 * 60_000L))
        assertEquals("2h", Format.durationShort(120 * 60_000L))
        assertEquals("1d 3h", Format.durationShort(27 * 3_600_000L))
    }
}

class ChatUnitsTest {

    @Test
    fun groupsAssistantMessagesAndToolResultsIntoReplies() {
        val units = ChatUnits.build(
            listOf(
                user("u1", 1, "can caddy get certs?"),
                m("a1", 2, Role.ASSISTANT, ThinkingBlock("check docs", durationMs = 3_400), ToolUseBlock("t1", "WebSearch"), model = "anthropic/sonnet", stop = "tool_use"),
                m("r1", 3, Role.USER, ToolResultBlock("t1")),
                m("a2", 4, Role.ASSISTANT, TextBlock("Yes."), model = "anthropic/sonnet"),
                user("u2", 5, "thanks"),
                m("a3", 6, Role.ASSISTANT, TextBlock("Any time."), model = "openai/gpt-5.5"),
            ),
        )
        assertEquals(listOf("u1", "a1", "u2", "sw:a3", "a3"), units.map { it.key })
        val reply = units[1] as ChatUnit.Reply
        assertEquals(listOf("a1", "r1", "a2"), reply.messages.map { it.id })
        assertEquals("u1", reply.user?.id)
        assertEquals("Yes.", reply.text)
        assertEquals("a2", reply.last.id)
        assertEquals(4, reply.lastSeq)
        assertEquals(3, reply.blocks.size)
        assertEquals("openai/gpt-5.5", (units[3] as ChatUnit.Switch).model)
    }

    @Test
    fun asideSitsUnderItsReplyAndIsPendingUntilSomethingFollows() {
        val meta = JsonObject(mapOf("messageId" to JsonPrimitive("a1")))
        val base = listOf(
            user("u1", 1, "q"),
            m("a1", 2, Role.ASSISTANT, TextBlock("first"), model = "anthropic/sonnet"),
            user("u2", 3, "more"),
            m("a2", 4, Role.ASSISTANT, TextBlock("second"), model = "anthropic/sonnet"),
            m("x1", 5, Role.ASSISTANT, TextBlock("I disagree"), kind = MessageKind.ASIDE, model = "openai/gpt-5.5", meta = meta),
        )
        val units = ChatUnits.build(base)
        assertEquals(listOf("u1", "a1", "x1", "u2", "a2"), units.map { it.key })
        assertFalse((units[2] as ChatUnit.Aside).pending)

        val last = ChatUnits.build(listOf(user("u1", 1, "q"), m("a1", 2, Role.ASSISTANT, TextBlock("first")), m("x1", 3, Role.ASSISTANT, TextBlock("hm"), kind = MessageKind.ASIDE, meta = meta)))
        assertTrue((last.last() as ChatUnit.Aside).pending)
    }

    @Test
    fun asideFollowsTheReplyTheAppAskedAbout() {
        val ok = JsonObject(mapOf("level" to JsonPrimitive("success")))
        val units = ChatUnits.build(
            listOf(
                user("u1", 1, "q"),
                m("a1", 2, Role.ASSISTANT, TextBlock("first")),
                user("u2", 3, "more"),
                m("a2", 4, Role.ASSISTANT, TextBlock("second")),
                m("x1", 5, Role.ASSISTANT, TextBlock("I disagree"), kind = MessageKind.ASIDE),
                m("n1", 6, Role.ASSISTANT, TextBlock("Second opinion from openai/gpt-5.5 added."), kind = MessageKind.NOTICE, meta = ok),
            ),
            targets = mapOf("x1" to "a1"),
        )
        // the aside answers the first reply; the success notice is not shown
        assertEquals(listOf("u1", "a1", "x1", "u2", "a2"), units.map { it.key })
    }

    @Test
    fun noticesAndHiddenMessages() {
        val units = ChatUnits.build(
            listOf(
                user("u1", 1, "q"),
                m("a1", 2, Role.ASSISTANT, TextBlock("partial"), stop = null),
                m("n1", 3, Role.ASSISTANT, TextBlock("Stopped by you."), kind = MessageKind.NOTICE),
            ),
            hide = setOf("a1"),
        )
        assertEquals(listOf("u1", "n1"), units.map { it.key })
        assertIs<ChatUnit.Notice>(units[1])
    }

    @Test
    fun countsRepliesAnEditRemoves() {
        val msgs = listOf(user("u1", 1, "a"), m("a1", 2), user("u2", 3, "b"), m("a2", 4), user("u3", 5, "c"), m("a3", 6))
        val units = ChatUnits.build(msgs)
        assertEquals(3, ChatList.repliesAfter(units, msgs[0]))
        assertEquals(1, ChatList.repliesAfter(units, msgs[4]))
    }
}

class ChatLiveTest {

    @Test
    fun phaseFollowsTheReply() {
        val results = mapOf("t1" to ToolResultBlock("t1"))
        assertEquals(LivePhase.WAITING, ChatLive.phase(listOf(m("a1", 1, stop = null)), emptyMap()))
        assertEquals(LivePhase.THINKING, ChatLive.phase(listOf(m("a1", 1, Role.ASSISTANT, ThinkingBlock("hmm"), stop = null)), emptyMap()))
        assertEquals(LivePhase.WRITING, ChatLive.phase(listOf(m("a1", 1, Role.ASSISTANT, ThinkingBlock("hmm"), TextBlock("Yes"), stop = null)), emptyMap()))
        assertEquals(LivePhase.TOOL, ChatLive.phase(listOf(m("a1", 1, Role.ASSISTANT, ToolUseBlock("t2", "WebSearch"), stop = null)), results))
        assertEquals(LivePhase.BETWEEN, ChatLive.phase(listOf(m("a1", 1, Role.ASSISTANT, ToolUseBlock("t1", "WebSearch"), stop = "tool_use")), results))
        // an empty text block does not count as writing yet
        assertEquals(LivePhase.WAITING, ChatLive.phase(listOf(m("a1", 1, Role.ASSISTANT, TextBlock(""), stop = null)), emptyMap()))
    }

    @Test
    fun theLiveReplyIsTheLastOneNothingYouSentFollows() {
        val asked = user("u1", 1, "caddy certs?")
        val writing = m("a1", 2, Role.ASSISTANT, TextBlock("Yes."), stop = null)
        val notice = m("n1", 3, Role.ASSISTANT, TextBlock("Steering: shorter"), kind = MessageKind.NOTICE)
        val units = ChatUnits.build(listOf(asked, writing, notice))
        // a notice after the reply leaves it live
        assertEquals(1, ChatLive.liveIndex(units, running = true))
        assertEquals(-1, ChatLive.liveIndex(units, running = false))
        assertFalse(ChatLive.awaiting(units, running = true))

        // between a tool call and its next message the reply is still being written
        val search = ToolUseBlock(id = "t1", name = "WebSearch", input = JsonObject(emptyMap()))
        val tooling = ChatUnits.build(listOf(asked, m("a2", 2, Role.ASSISTANT, search, stop = "tool_use"), m("r1", 3, Role.USER, ToolResultBlock("t1"))))
        assertEquals(1, ChatLive.liveIndex(tooling, running = true))

        // a finished reply is done while the next turn starts (the hub runs before it stores your message)
        val done = ChatUnits.build(listOf(asked, m("a3", 2, Role.ASSISTANT, TextBlock("Yes."))))
        assertEquals(-1, ChatLive.liveIndex(done, running = true))
        assertFalse(ChatLive.awaiting(done, running = true))

        // your next message waits for its own reply
        val next = ChatUnits.build(listOf(asked, writing, user("u2", 4, "and tailscale?")))
        assertEquals(-1, ChatLive.liveIndex(next, running = true))
        assertTrue(ChatLive.awaiting(next, running = true))
        assertFalse(ChatLive.awaiting(next, running = false))
        assertTrue(ChatLive.awaiting(ChatUnits.build(listOf(asked)), running = true))

        // a message queued behind the reply does not end it
        val queued = listOf(ChatUnit.User(asked), ChatUnit.Reply(listOf(writing), asked, null), ChatUnit.User(user("u3", 5, "later"), queued = true))
        assertEquals(1, ChatLive.liveIndex(queued, running = true))
        assertFalse(ChatLive.awaiting(queued, running = true))
    }

    @Test
    fun lastLineOfAThought() {
        assertEquals("Then check the docs for the ts.net integration.", ChatLive.lastLine("Memory says CT 101.\n\nThen check the docs for the ts.net integration.\n"))
        assertEquals("Caddy runs in CT 101. Check it.", ChatLive.lastLine("Caddy runs in CT 101. Check it."))
        assertEquals("", ChatLive.lastLine(""))
        assertEquals("Thought for 1s", ChatLive.thoughtFor(200))
        assertEquals("Thought for 12s", ChatLive.thoughtFor(12_400))
        assertEquals("Thought for 1m 5s", ChatLive.thoughtFor(65_000))
    }
}

class ChatSourcesTest {
    private val results = listOf(
        SearchResultRef("Automatic HTTPS", "https://caddyserver.com/docs/automatic-https"),
        SearchResultRef("Caddy certificates", "https://tailscale.com/kb/1190/caddy-certificates"),
        SearchResultRef("Enabling HTTPS", "https://www.tailscale.com/kb/1153/enabling-https/"),
    )

    @Test
    fun citedLinksComeFirstOnePerHost() {
        val text = "See [Tailscale](https://tailscale.com/kb/1153/enabling-https) and [docs](https://caddyserver.com/docs/automatic-https#ts)."
        val sources = ChatSources.of(text, results)
        // www. is dropped, so the two tailscale pages share a host
        assertEquals(listOf("tailscale.com", "caddyserver.com"), sources.map { it.host })
        assertEquals(listOf(1, 2), sources.map { it.n })
    }

    @Test
    fun withoutCitationsEveryResultCounts() {
        val sources = ChatSources.of("No links here.", results)
        assertEquals(listOf("caddyserver.com", "tailscale.com"), sources.map { it.host })
        assertEquals("Automatic HTTPS", sources.first().title)
        assertTrue(ChatSources.of("x", emptyList()).isEmpty())
    }

    @Test
    fun collectsSearchAndFetchResults() {
        val msgs = listOf(
            m("a1", 1, Role.ASSISTANT, ToolUseBlock("t1", "WebSearch"), ToolUseBlock("t2", "WebFetch", JsonObject(mapOf("url" to JsonPrimitive("https://example.org/page")))), ToolUseBlock("t3", "WebSearch")),
        )
        val res = mapOf(
            "t1" to ToolResultBlock("t1", meta = ToolResultMeta(results = results.take(1))),
            "t2" to ToolResultBlock("t2"),
            "t3" to ToolResultBlock("t3", isError = true, meta = ToolResultMeta(results = results)),
        )
        assertEquals(listOf("https://caddyserver.com/docs/automatic-https", "https://example.org/page"), ChatSources.results(msgs, res).map { it.url })
    }
}

class ChatToolsTest {
    private fun input(vararg pairs: Pair<String, String>) = JsonObject(pairs.associate { it.first to JsonPrimitive(it.second) })

    @Test
    fun webRowsSayWhatHappened() {
        val search = ToolUseBlock("t1", "WebSearch", input("query" to "caddy tailscale"))
        val running = ChatTools.line(search, null)
        assertEquals("Searching the web", running.words)
        assertEquals("caddy tailscale", running.detail)
        assertTrue(running.live)
        val done = ChatTools.line(search, ToolResultBlock("t1", meta = ToolResultMeta(count = 3, results = List(3) { SearchResultRef("r$it", "https://x$it.org") })))
        assertEquals("Searched the web, 3 results", done.words)
        assertFalse(done.live)
        assertEquals("Search failed", ChatTools.line(search, ToolResultBlock("t1", isError = true)).words)

        val fetch = ToolUseBlock("t2", "WebFetch", input("url" to "https://www.caddyserver.com/docs"))
        assertEquals("Reading" to "caddyserver.com", ChatTools.line(fetch, null).let { it.words to it.detail })
        assertEquals("Read caddyserver.com", ChatTools.line(fetch, ToolResultBlock("t2")).words)
    }

    @Test
    fun runningToolsAreOneStep() {
        assertEquals(null, ChatTools.runningStep(emptyList()))
        val a = ToolUseBlock("t1", "WebFetch", input("url" to "https://caddyserver.com/docs"))
        val b = ToolUseBlock("t2", "WebFetch", input("url" to "https://tailscale.com/kb"))
        val c = ToolUseBlock("t3", "WebFetch", input("url" to "https://caddyserver.com/x"))
        val pages = ChatTools.runningStep(listOf(a, b, c))!!
        assertEquals("Reading 3 pages", pages.words)
        assertEquals("caddyserver.com, tailscale.com", pages.detail)
        val search = ToolUseBlock("t4", "WebSearch", input("query" to "caddy tailscale"))
        assertEquals("Searching the web" to "caddy tailscale", ChatTools.runningStep(listOf(a, search))!!.let { it.words to it.detail })
    }

    @Test
    fun memoryRowsCountNotes() {
        val search = ToolUseBlock("t1", "MemorySearch", input("query" to "deadline"))
        val result = ToolResultBlock(
            "t1",
            content = JsonPrimitive("2 memories:\n\n[mm5] (fact, global, 2026-10-01)\nCaddy runs in LXC 101.\n\n[mm11] (fact, global, 2026-09-20 #uni)\nCOMP3310 assignment 2 is due 24 October."),
        )
        assertEquals("Checked memory, 2 notes", ChatTools.line(search, result).words)
        val notes = ChatTools.notes(result)
        assertEquals(listOf("mm5", "mm11"), notes.map { it.id })
        assertEquals("COMP3310 assignment 2 is due 24 October.", notes[1].text)
        assertEquals("Checked memory, nothing found", ChatTools.line(search, ToolResultBlock("t1", content = JsonPrimitive("No memories match \"x\"."))).words)

        val msgs = listOf(m("a1", 1, Role.ASSISTANT, search))
        assertEquals("Caddy runs in LXC 101.", ChatTools.findNote(msgs, mapOf("t1" to result), "mm5"))
        assertNull(ChatTools.findNote(msgs, mapOf("t1" to result), "nope"))

        assertEquals("Saved to memory", ChatTools.line(ToolUseBlock("t2", "MemorySave"), ToolResultBlock("t2")).words)
        assertEquals("Memory check did not finish.", ChatTools.line(search, null, live = false).words)
        assertEquals("Using mcp tool", ChatTools.line(ToolUseBlock("t4", "mcp__mcp__tool"), null).words)
        assertEquals("Retired a note", ChatTools.line(ToolUseBlock("t3", "MemoryForget"), ToolResultBlock("t3")).words)
    }
}

class ChatListTest {
    private val zone = ZoneId.of("Australia/Sydney")
    private fun at(month: Int, day: Int, hour: Int = 12) = LocalDateTime.of(2026, month, day, hour, 0).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun groupsByLastActivity() {
        val now = at(10, 17, 20)
        assertEquals("Today", ChatList.group(at(10, 17, 1), now, zone).second)
        assertEquals("Yesterday", ChatList.group(at(10, 16, 23), now, zone).second)
        assertEquals("Previous 7 days", ChatList.group(at(10, 11), now, zone).second)
        assertEquals("Previous 30 days", ChatList.group(at(9, 20), now, zone).second)
        assertEquals("August", ChatList.group(at(8, 3), now, zone).second)
        assertEquals("December 2025", ChatList.group(LocalDateTime.of(2025, 12, 1, 9, 0).atZone(zone).toInstant().toEpochMilli(), now, zone).second)

        val sessions = listOf(
            Session("c1", kind = SessionKind.CHAT, updatedAt = at(10, 17, 9)),
            Session("s1", updatedAt = at(10, 17, 10)),
            Session("c2", kind = SessionKind.CHAT, updatedAt = at(10, 17, 11)),
            Session("c3", kind = SessionKind.CHAT, updatedAt = at(10, 10)),
            Session("c4", kind = SessionKind.CHAT, updatedAt = at(10, 17), archived = true),
        )
        val groups = ChatList.groups(sessions, now, zone)
        assertEquals(listOf("Today", "Previous 7 days"), groups.map { it.title })
        assertEquals(listOf("c2", "c1"), groups[0].chats.map { it.id })
    }

    @Test
    fun greetsByTimeOfDay() {
        assertEquals("Good morning, Kai.", ChatList.greeting("Kai", 8))
        assertEquals("Good afternoon.", ChatList.greeting(null, 13))
        assertEquals("Good evening.", ChatList.greeting("  ", 21))
        assertEquals("Good evening, Kai.", ChatList.greeting("Kai", 2))
    }

    @Test
    fun composerWords() {
        assertEquals("Web, memory", ChatList.toolsLabel(ChatSettings()))
        assertEquals("Web", ChatList.toolsLabel(ChatSettings(memory = false)))
        assertEquals("Memory", ChatList.toolsLabel(ChatSettings(webSearch = false)))
        assertEquals("No web, no memory", ChatList.toolsLabel(ChatSettings(webSearch = false, memory = false)))
        val opus = ModelEffort(levels = listOf("low", "medium", "high", "xhigh", "max"), off = false, defaultLevel = "medium")
        assertEquals("Effort medium", ChatList.effortLabel(null, opus))
        assertEquals("Effort extra high", ChatList.effortLabel(ThinkingLevel.XHIGH, opus))
        assertEquals("Effort default", ChatList.effortLabel(null, ModelEffort(levels = listOf("low", "high"))))
        assertEquals("Caddy, branch", ChatList.branchTitle("Caddy"))
    }
}
