import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client ModelsTest.kt.
struct ModelsTests {
    @Test func decodesMergedModelEntries() throws {
        // one entry per model (core providers/merge.ts): the plan's entry says its route, the key's points at it
        let groups: [ModelGroup] = try decode("""
            [{"provider":"cliproxy","name":"CLIProxyAPI","type":"openai","configured":true,"enabled":true,
              "models":[{"id":"claude-opus-5-5","ref":"cliproxy/claude-opus-5-5","provider":"cliproxy","name":"Claude Opus 5.5",
                "via":"your Claude plan, then API key","refs":["cliproxy/claude-opus-5-5","anthropic/claude-opus-5-5"]}]},
             {"provider":"anthropic","name":"Anthropic","type":"anthropic","configured":true,"enabled":true,
              "models":[{"id":"claude-opus-5-5","ref":"anthropic/claude-opus-5-5","provider":"anthropic","name":"Claude Opus 5.5","sameAs":"cliproxy/claude-opus-5-5"}]}]
            """)
        let plan = groups[0].models[0]
        #expect(plan.via == "your Claude plan, then API key")
        #expect(plan.refs == ["cliproxy/claude-opus-5-5", "anthropic/claude-opus-5-5"])
        #expect(plan.sameAs == nil)
        #expect(groups[1].models[0].sameAs == "cliproxy/claude-opus-5-5")
    }

    @Test func decodesSessionWithUnknownFieldsAndEnums() throws {
        let s: Session = try decode("""
            {"id":"s1","title":"Fix build","agent":"coder","model":"anthropic/claude-sonnet-5-5","mode":"agent",
             "permissionMode":"acceptEdits","cwd":"/home/me/x","device":"local","status":"waiting_reset",
             "tags":["a"],"pinned":true,"archived":false,"createdAt":1,"updatedAt":2,
             "stats":{"messages":3,"inputTokens":10,"outputTokens":20,"cacheReadTokens":5,"costUsd":0.25},
             "resumeAt":1760000000000,"futureField":{"x":1}}
            """)
        #expect(s.id == "s1")
        #expect(s.permissionMode == .acceptEdits)
        #expect(s.status == .waitingReset)
        #expect(s.resumeAt == 1_760_000_000_000)
        #expect(s.stats.costUsd == 0.25)
        #expect(s.pinned)
    }

    @Test func unknownEnumValueFallsBackToDefault() throws {
        let s: Session = try decode(#"{"id":"s1","status":"hibernating","mode":"symphony"}"#)
        #expect(s.status == .idle)
        #expect(s.mode == .agent)
    }

    @Test func decodesAllContentBlockTypes() throws {
        let m: Message = try decode("""
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
            """)
        #expect(m.role == .assistant)
        #expect(m.kind == .normal)
        #expect(m.content.count == 7)
        #expect(m.content[0] == .thinking(ThinkingBlock(thinking: "hmm", signature: "sig")))
        #expect(m.content[2] == .text("Hello"))
        #expect(m.content[3] == .image(MediaBlock(mediaType: "image/png", data: "AAAA")))
        #expect(m.content[5].toolUse?.input["command"]?.string == "ls -la")
        #expect(m.content[6] == .unknown("server_tool_use"))
    }

    @Test func toolResultContentCanBeStringOrBlocks() throws {
        let a: ToolResultBlock = try decode(#"{"toolUseId":"t1","content":"ok","isError":false}"#)
        #expect(a.text == "ok")
        let b: ToolResultBlock = try decode("""
            {"toolUseId":"t1","content":[{"type":"text","text":"line"},{"type":"image","mediaType":"image/png"}],
             "meta":{"diff":"@@ -1 +1 @@","exitCode":0,"durationMs":12,"custom":"x"}}
            """)
        #expect(b.text == "line\n[image]")
        #expect(b.meta?["diff"]?.string == "@@ -1 +1 @@")
        #expect(b.meta?["exitCode"]?.number == 0)
    }

    @Test func encodesRequestsWithoutNulls() throws {
        #expect(try encode(JSONValue.object(SessionPatch(pinned: true).json)) == #"{"pinned":true}"#)
        #expect(try encode(CreateSessionInput(agent: "coder", mode: .jury)) == #"{"agent":"coder","mode":"jury"}"#)
        #expect(try encode(ApprovalResponse.allowAlways(rule: "Bash(npm test:*)")) == #"{"decision":"allow","rule":"Bash(npm test:*)","scope":"always"}"#)
        #expect(try encode(ApprovalResponse.deny()) == #"{"decision":"deny"}"#)
        // back to the agent's thinking is an explicit null, other switches left out
        let back = SessionPatch(chat: ChatSettingsPatch(agentThinking: true))
        #expect(try encode(JSONValue.object(back.json)) == #"{"chat":{"thinking":null}}"#)
    }

    @Test func parsesFrames() throws {
        #expect(Frame.parse(#"{"type":"hello","seq":42}"#) == .hello(seq: 42))
        #expect(Frame.parse(#"{"type":"resync","seq":50}"#) == .resync(seq: 50))
        #expect(Frame.parse("not json") == .malformed)
        #expect(Frame.parse(#"{"seq":1}"#) == .malformed)

        guard case .event(let delta) = Frame.parse(
            #"{"type":"message.delta","sessionId":"s1","messageId":"m1","index":1,"kind":"thinking","text":"ab","seq":7,"ts":100}"#
        ) else { Issue.record("not an event"); return }
        #expect(delta.seq == 7)
        #expect(delta.ts == 100)
        #expect(delta.event == .messageDelta(MessageDelta(sessionId: "s1", messageId: "m1", index: 1, kind: .thinking, text: "ab")))
        #expect(delta.event.sessionKey == "s1")

        guard case .event(let unknown) = Frame.parse(#"{"type":"brand.new","seq":8,"ts":1,"x":1}"#) else { Issue.record("not an event"); return }
        #expect(unknown.event == .other(type: "brand.new"))
        #expect(unknown.type == "brand.new")
    }

    @Test func parsesEventsWithNestedPayloads() throws {
        guard case .event(let a) = Frame.parse("""
            {"type":"approval.requested","seq":1,"ts":1,"approval":{"id":"a1","sessionId":"s1","toolUseId":"t1",
             "tool":"Bash","input":{"command":"rm -rf build"},"summary":"Run: rm -rf build","suggestedRule":"Bash(rm:*)","createdAt":5}}
            """), case .approvalRequested(let approval) = a.event else { Issue.record("no approval"); return }
        #expect(approval.summary == "Run: rm -rf build")
        #expect(a.event.sessionKey == "s1")

        guard case .event(let r) = Frame.parse(
            #"{"type":"approval.resolved","seq":2,"ts":1,"id":"a1","sessionId":"s1","response":{"decision":"allow","scope":"session"}}"#
        ) else { Issue.record("no event"); return }
        #expect(r.event == .approvalResolved(id: "a1", sessionId: "s1"))

        guard case .event(let c) = Frame.parse(
            #"{"type":"tool.completed","seq":3,"ts":1,"sessionId":"s1","toolUseId":"t1","result":{"type":"tool_result","toolUseId":"t1","content":"done"}}"#
        ), case .toolCompleted(_, _, let result) = c.event else { Issue.record("no tool.completed"); return }
        #expect(result.text == "done")
        #expect(!result.isError)
    }

    @Test func aKnownEventWithABadBodyIsStillAnEvent() {
        guard case .event(let e) = Frame.parse(#"{"type":"session.updated","seq":3,"ts":1}"#) else { Issue.record("dropped"); return }
        #expect(e.event == .other(type: "session.updated"))
    }
}
