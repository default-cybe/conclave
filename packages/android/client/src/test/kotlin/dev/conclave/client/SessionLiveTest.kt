package dev.conclave.client

import dev.conclave.client.logic.SessionActivity
import dev.conclave.client.logic.SessionLive
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolUseBlock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The session live line's step: what the turn is doing, in the web's words. */
class SessionLiveTest {

    private fun input(vararg pairs: Pair<String, String>) = JsonObject(pairs.associate { it.first to JsonPrimitive(it.second) })

    private fun msg(id: String, seq: Long, role: Role, vararg blocks: ContentBlock, stop: String? = "end_turn") =
        Message(id = id, sessionId = "s1", seq = seq, role = role, kind = MessageKind.NORMAL, content = blocks.toList(), createdAt = seq, stopReason = stop)

    @Test
    fun nothingStreamingIsThinking() {
        val user = msg("u1", 1, Role.USER, TextBlock("hi"))
        assertEquals(SessionActivity.Thinking(streaming = false), SessionLive.activity(listOf(user), emptySet()))
        // a tool result just went back and nothing streams yet: still thinking
        val done = msg("a1", 2, Role.ASSISTANT, ToolUseBlock("t1", "Bash", input("command" to "ls")), stop = "tool_use")
        assertEquals(SessionActivity.Thinking(streaming = false), SessionLive.activity(listOf(user, done), emptySet()))
    }

    @Test
    fun aStreamingMessageThinksOrWrites() {
        val user = msg("u1", 1, Role.USER, TextBlock("hi"))
        val thought = msg("a1", 2, Role.ASSISTANT, ThinkingBlock("let me see"), stop = null)
        assertEquals(SessionActivity.Thinking(streaming = true), SessionLive.activity(listOf(user, thought), emptySet()))
        val writing = msg("a1", 2, Role.ASSISTANT, ThinkingBlock("let me see"), TextBlock("The answer"), stop = null)
        assertEquals(SessionActivity.Writing, SessionLive.activity(listOf(user, writing), emptySet()))
        // an empty text block that only opened does not count yet
        val opened = msg("a1", 2, Role.ASSISTANT, ThinkingBlock("let me see"), TextBlock(""), stop = null)
        assertEquals(SessionActivity.Thinking(streaming = true), SessionLive.activity(listOf(user, opened), emptySet()))
    }

    @Test
    fun theNewestRunningToolIsTheStep() {
        val a = msg(
            "a1", 2, Role.ASSISTANT,
            ToolUseBlock("t1", "Read", input("file_path" to "src/auth.ts")),
            ToolUseBlock("t2", "Bash", input("command" to "bun test\nbun run lint")),
            stop = "tool_use",
        )
        assertEquals(SessionActivity.Tool("Running", "bun test", "t2"), SessionLive.activity(listOf(a), setOf("t1", "t2")))
        assertEquals(SessionActivity.Tool("Reading", "src/auth.ts", "t1"), SessionLive.activity(listOf(a), setOf("t1")))
    }

    @Test
    fun verbsMatchTheWeb() {
        fun step(name: String, vararg pairs: Pair<String, String>) = SessionLive.step(ToolUseBlock("t", name, input(*pairs)))
        assertEquals("Searching the web" to "caddy tailscale", step("WebSearch", "query" to "caddy tailscale"))
        assertEquals("Reading" to "caddyserver.com", step("WebFetch", "url" to "https://www.caddyserver.com/docs"))
        assertEquals("Checking memory" to null, step("MemorySearch", "query" to "x"))
        assertEquals("Planning" to null, step("TodoWrite"))
        assertEquals("Editing" to "src/a.ts", step("Edit", "file_path" to "src/a.ts"))
        assertEquals("Editing" to "notes.ipynb", step("NotebookEdit", "notebook_path" to "notes.ipynb"))
        assertEquals("Searching" to "TODO", step("Grep", "pattern" to "TODO"))
        assertEquals("Subagent working on" to "the tests", step("Task", "description" to "the tests"))
        assertEquals("Running" to "github list_issues", step("mcp__github__list_issues"))
        assertEquals("Running" to "pdf", step("Skill", "skill" to "pdf"))
        assertEquals("Running" to "Lookup cats", step("Lookup", "q" to "cats"))
        assertEquals("Running" to "Lookup", step("Lookup"))
    }
}
