import Foundation
import Testing
@testable import ConclaveKit

// Copy, Edit, Retry and their routes. The isOwn cases port packages/android/client AgentResultsTest.kt
// noEmptyBubble and ChatModeTest.kt contextOnlyUserMessagesAreNotRetryOrEditTargets.

private func m(_ id: String, _ seq: Int64, _ role: Role, _ blocks: ContentBlock..., kind: MessageKind = .normal, meta: JSONObject? = nil) -> Message {
    Message(id: id, sessionId: "s1", seq: seq, role: role, kind: kind, content: blocks, meta: meta)
}

private let reminder = ContentBlock.text("<system-reminder>\nHook feedback\n</system-reminder>")

struct SessionActionsTests {
    @Test func contextOnlyAndToolResultsAreNotOwn() {
        #expect(!SessionActions.isOwn(m("u3", 1, .user, .toolResult(ToolResultBlock(toolUseId: "t1")), reminder)))
        #expect(!SessionActions.isOwn(m("u4", 1, .user, .text("  "))))
        #expect(!SessionActions.isOwn(m("u5", 1, .user, reminder)))
        #expect(!SessionActions.isOwn(m("n1", 1, .user, .text("hi"), kind: .notice)))
        #expect(SessionActions.isOwn(m("u1", 1, .user, .text("can caddy get certs?"))))
        #expect(SessionActions.isOwn(m("u2", 1, .user, .image(MediaBlock(mediaType: "image/png", data: "AA==")))))
    }

    @Test func retryTargetSkipsContextAndToolResults() {
        let list = [
            m("u1", 1, .user, .text("can caddy get certs?")),
            m("a1", 2, .assistant, .text("Yes.")),
            m("c1", 3, .user, reminder),
            m("a2", 4, .assistant, .toolUse(ToolUseBlock(id: "t1", name: "Bash"))),
            m("r1", 5, .user, .toolResult(ToolResultBlock(toolUseId: "t1"))),
            m("a3", 6, .assistant, .text("Done.")),
        ]
        let last = SessionActions.lastUser(list)
        #expect(last?.id == "u1")
        #expect(last.map(SessionActions.rewindSeq) == 0)
        #expect(SessionActions.asker(list, before: 6)?.id == "u1")
        #expect(SessionActions.turnEnds(list) == ["a3"])
        #expect(SessionActions.turnText(list, end: list[5]) == "Yes.\n\nDone.")
    }

    @Test func turnEndsPerTurn() {
        let list = [
            m("u1", 1, .user, .text("one")),
            m("a1", 2, .assistant, .text("first")),
            m("u2", 3, .user, .text("two")),
            m("a2", 4, .assistant, .text("second")),
            m("n1", 5, .assistant, .text("Switched"), kind: .notice),
        ]
        #expect(SessionActions.turnEnds(list) == ["a1", "a2"])
        #expect(SessionActions.turnText(list, end: list[3]) == "second")
        #expect(SessionActions.lastUser(list)?.id == "u2")
    }

    @Test func providerFailureRefusesRetry() {
        let list = [
            m("u1", 1, .user, .text("hi")),
            m("n1", 2, .assistant, .text("The provider failed."), kind: .notice, meta: ["type": "provider_error", "canRetry": true]),
        ]
        #expect(SessionActions.retryRefusal(list) == SessionActions.providerRetry)
        #expect(SessionActions.retryRefusal(Array(list.prefix(1))) == nil)
    }

    @Test func copyLeavesRemindersOut() {
        #expect(SessionActions.copyText(m("u1", 1, .user, reminder, .text("my words"))) == "my words")
    }

    @Test func forkPostsFromSeq() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"id":"s2","title":"Fork"}"#)
        hub.enqueue(#"{"id":"s3"}"#)
        let s = try await hub.client().forkSession("s1", fromSeq: 7)
        #expect(s.id == "s2")
        let req = try #require(hub.take())
        #expect(req.method == "POST")
        #expect(req.path == "/api/sessions/s1/fork")
        #expect(req.json == ["fromSeq": 7])
        _ = try await hub.client().forkSession("s1")
        let whole = try #require(hub.take())
        #expect(whole.json == [:])
    }

    @Test func rewindPostsSeqAndFiles() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"id":"s1"}"#)
        _ = try await hub.client().rewind("s1", seq: 4, restoreFiles: true)
        let req = try #require(hub.take())
        #expect(req.path == "/api/sessions/s1/rewind")
        #expect(req.json == ["restoreFiles": true, "seq": 4])
    }

    @Test func moveAndPlacePatch() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"resolved":false,"reason":"offline","line":"macbook is offline.","candidates":[]}"#)
        hub.enqueue(#"{"id":"s1","agent":"security"}"#)
        let r = try await hub.client().moveSession("s1", device: "d3")
        #expect(!r.resolved && r.reason == "offline" && r.line == "macbook is offline." && r.session == nil)
        let move = try #require(hub.take())
        #expect(move.path == "/api/sessions/s1/move")
        #expect(move.json == ["device": "d3"])
        let s = try await hub.client().updateSession("s1", SessionPlacePatch(agent: "security"))
        #expect(s.agent == "security")
        let patch = try #require(hub.take())
        #expect(patch.method == "PATCH")
        #expect(patch.json == ["agent": "security"])
    }
}
