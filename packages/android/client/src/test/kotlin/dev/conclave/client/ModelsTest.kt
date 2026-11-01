package dev.conclave.client

import dev.conclave.client.model.ApprovalResponse
import dev.conclave.client.model.CreateSessionInput
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.PermissionMode
import dev.conclave.client.model.Role
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionMode
import dev.conclave.client.model.SessionPatch
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.UnknownBlock
import dev.conclave.client.model.string
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ModelsTest {
    private val json = ConclaveJson

    @Test
    fun decodesMergedModelEntries() {
        // one entry per model (core providers/merge.ts): the plan's entry says its route, the key's points at it
        val groups = json.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(dev.conclave.client.model.ModelGroup.serializer()),
            """
            [{"provider":"cliproxy","name":"CLIProxyAPI","type":"openai","configured":true,"enabled":true,
              "models":[{"id":"claude-opus-5-5","ref":"cliproxy/claude-opus-5-5","provider":"cliproxy","name":"Claude Opus 5.5",
                "via":"your Claude plan, then API key","refs":["cliproxy/claude-opus-5-5","anthropic/claude-opus-5-5"]}]},
             {"provider":"anthropic","name":"Anthropic","type":"anthropic","configured":true,"enabled":true,
              "models":[{"id":"claude-opus-5-5","ref":"anthropic/claude-opus-5-5","provider":"anthropic","name":"Claude Opus 5.5","sameAs":"cliproxy/claude-opus-5-5"}]}]
            """.trimIndent(),
        )
        val plan = groups[0].models[0]
        assertEquals("your Claude plan, then API key", plan.via)
        assertEquals(listOf("cliproxy/claude-opus-5-5", "anthropic/claude-opus-5-5"), plan.refs)
        assertNull(plan.sameAs)
        assertEquals("cliproxy/claude-opus-5-5", groups[1].models[0].sameAs)
    }

    @Test
    fun decodesSessionWithUnknownFieldsAndEnums() {
        val s = json.decodeFromString(
            Session.serializer(),
            """
            {"id":"s1","title":"Fix build","agent":"coder","model":"anthropic/claude-sonnet-5-5","mode":"agent",
             "permissionMode":"acceptEdits","cwd":"/home/me/x","device":"local","status":"waiting_reset",
             "tags":["a"],"pinned":true,"archived":false,"createdAt":1,"updatedAt":2,
             "stats":{"messages":3,"inputTokens":10,"outputTokens":20,"cacheReadTokens":5,"costUsd":0.25},
             "resumeAt":1760000000000,"futureField":{"x":1}}
            """.trimIndent(),
        )
        assertEquals("s1", s.id)
        assertEquals(PermissionMode.ACCEPT_EDITS, s.permissionMode)
        assertEquals(SessionStatus.WAITING_RESET, s.status)
        assertEquals(1760000000000L, s.resumeAt)
        assertEquals(0.25, s.stats.costUsd)
        assertTrue(s.pinned)
    }

    @Test
    fun unknownEnumValueFallsBackToDefault() {
        val s = json.decodeFromString(Session.serializer(), """{"id":"s1","status":"hibernating","mode":"symphony"}""")
        assertEquals(SessionStatus.IDLE, s.status)
        assertEquals(SessionMode.AGENT, s.mode)
    }

    @Test
    fun decodesAllContentBlockTypes() {
        val m = json.decodeFromString(
            Message.serializer(),
            """
            {"id":"m1","sessionId":"s1","seq":4,"role":"assistant","kind":"normal","model":"openai/gpt-5.5","createdAt":9,
             "content":[
               {"type":"thinking","thinking":"hmm","signature":"sig"},
               {"type":"redacted_thinking","data":"xx"},
               {"type":"text","text":"Hello"},
               {"type":"image","mediaType":"image/png","data":"AAAA"},
               {"type":"document","mediaType":"application/pdf","title":"Spec"},
               {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}},
               {"type":"server_tool_use","id":"zz"}
             ]}
            """.trimIndent(),
        )
        assertEquals(Role.ASSISTANT, m.role)
        assertEquals(MessageKind.NORMAL, m.kind)
        assertEquals(7, m.content.size)
        assertIs<ThinkingBlock>(m.content[0])
        assertEquals("Hello", (m.content[2] as TextBlock).text)
        assertEquals("image/png", (m.content[3] as ImageBlock).mediaType)
        val use = m.content[5] as ToolUseBlock
        assertEquals("ls -la", use.input.string("command"))
        assertIs<UnknownBlock>(m.content[6])
    }

    @Test
    fun toolResultContentCanBeStringOrBlocks() {
        val a = json.decodeFromString(ToolResultBlock.serializer(), """{"toolUseId":"t1","content":"ok","isError":false}""")
        assertEquals("ok", a.text)
        val b = json.decodeFromString(
            ToolResultBlock.serializer(),
            """{"toolUseId":"t1","content":[{"type":"text","text":"line"},{"type":"image","mediaType":"image/png"}],
               "meta":{"diff":"@@ -1 +1 @@","exitCode":0,"durationMs":12,"custom":"x"}}""",
        )
        assertEquals("line\n[image]", b.text)
        assertEquals("@@ -1 +1 @@", b.meta?.diff)
        assertEquals(0, b.meta?.exitCode)
    }

    @Test
    fun encodesRequestsWithoutNulls() {
        val patch = json.encodeToString(SessionPatch.serializer(), SessionPatch(pinned = true))
        assertEquals("""{"pinned":true}""", patch)
        val create = json.encodeToString(CreateSessionInput.serializer(), CreateSessionInput(agent = "coder", mode = SessionMode.JURY))
        assertEquals("""{"agent":"coder","mode":"jury"}""", create)
        val allow = json.encodeToString(ApprovalResponse.serializer(), ApprovalResponse.allowAlways("Bash(npm test:*)"))
        assertEquals("""{"decision":"allow","scope":"always","rule":"Bash(npm test:*)"}""", allow)
        val deny = json.encodeToString(ApprovalResponse.serializer(), ApprovalResponse.deny())
        assertEquals("""{"decision":"deny"}""", deny)
    }

    @Test
    fun parsesFrames() {
        assertEquals(Frame.Hello(42), Frame.parse("""{"type":"hello","seq":42}"""))
        assertEquals(Frame.Resync(50), Frame.parse("""{"type":"resync","seq":50}"""))
        assertEquals(Frame.Malformed, Frame.parse("not json"))
        assertEquals(Frame.Malformed, Frame.parse("""{"seq":1}"""))

        val delta = Frame.parse(
            """{"type":"message.delta","sessionId":"s1","messageId":"m1","index":1,"kind":"thinking","text":"ab","seq":7,"ts":100}""",
        )
        assertIs<Frame.Event>(delta)
        assertEquals(7, delta.envelope.seq)
        assertEquals(100, delta.envelope.ts)
        val ev = delta.envelope.event
        assertIs<EngineEvent.MessageDelta>(ev)
        assertEquals(1, ev.index)
        assertEquals("s1", ev.sessionKey)

        val unknown = Frame.parse("""{"type":"brand.new","seq":8,"ts":1,"x":1}""")
        assertIs<Frame.Event>(unknown)
        assertIs<EngineEvent.Unknown>(unknown.envelope.event)
        assertEquals("brand.new", unknown.envelope.type)

        val cfg = Frame.parse("""{"type":"config.updated","seq":9,"ts":1}""")
        assertIs<Frame.Event>(cfg)
        assertIs<EngineEvent.ConfigUpdated>(cfg.envelope.event)
    }

    @Test
    fun parsesEventsWithNestedPayloads() {
        val approval = Frame.parse(
            """{"type":"approval.requested","seq":1,"ts":1,"approval":{"id":"a1","sessionId":"s1","toolUseId":"t1",
                "tool":"Bash","input":{"command":"rm -rf build"},"summary":"Run: rm -rf build","suggestedRule":"Bash(rm:*)","createdAt":5}}""",
        ) as Frame.Event
        val ev = approval.envelope.event as EngineEvent.ApprovalRequested
        assertEquals("Run: rm -rf build", ev.approval.summary)
        assertEquals("s1", ev.sessionKey)

        val resolved = Frame.parse(
            """{"type":"approval.resolved","seq":2,"ts":1,"id":"a1","sessionId":"s1","response":{"decision":"allow","scope":"session"}}""",
        ) as Frame.Event
        val r = resolved.envelope.event as EngineEvent.ApprovalResolved
        assertEquals("session", r.response?.scope)

        val completed = Frame.parse(
            """{"type":"tool.completed","seq":3,"ts":1,"sessionId":"s1","toolUseId":"t1","result":{"type":"tool_result","toolUseId":"t1","content":"done"}}""",
        ) as Frame.Event
        val c = completed.envelope.event as EngineEvent.ToolCompleted
        assertEquals("done", c.result.text)
        assertFalse(c.result.isError)

        val limit = Frame.parse(
            """{"type":"limit.updated","seq":4,"ts":1,"limit":{"provider":"claude-max","label":"Claude Max","windows":[{"name":"5h","usedPercent":80.5,"resetsAt":99}],"updatedAt":1,"source":"oauth"}}""",
        ) as Frame.Event
        val l = limit.envelope.event as EngineEvent.LimitUpdated
        assertEquals(80.5, l.limit.windows.single().usedPercent)
        assertNull(l.limit.blocked)
    }
}
