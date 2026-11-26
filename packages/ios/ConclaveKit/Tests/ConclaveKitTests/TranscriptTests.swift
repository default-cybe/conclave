import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client LogicTest.kt (TranscriptTest): deltas, placeholders, sorting,
// tool results, merges and where a reload starts.
struct TranscriptTests {
    private func msg(_ id: String, _ seq: Int64, _ role: Role = .assistant, _ blocks: ContentBlock..., stopReason: String? = nil) -> Message {
        Message(id: id, sessionId: "s1", seq: seq, role: role, content: blocks, stopReason: stopReason)
    }

    private func delta(_ sid: String, _ index: Int, _ kind: DeltaKind, _ text: String, _ mid: String = "m1") -> EngineEvent {
        .messageDelta(MessageDelta(sessionId: sid, messageId: mid, index: index, kind: kind, text: text))
    }

    @Test func appliesDeltasToTheRightBlock() {
        var t = Transcript(sessionId: "s1")
        t = TranscriptReducer.apply(t, .messageCreated(msg("m1", 1)))
        t = TranscriptReducer.apply(t, delta("s1", 0, .thinking, "Let me "))
        t = TranscriptReducer.apply(t, delta("s1", 0, .thinking, "think"))
        t = TranscriptReducer.apply(t, delta("s1", 1, .text, "Hel"))
        t = TranscriptReducer.apply(t, delta("s1", 1, .text, "lo"))
        t = TranscriptReducer.apply(t, delta("s1", 2, .toolInput, "{\"comm"))
        t = TranscriptReducer.apply(t, delta("other", 1, .text, "IGNORED"))
        #expect(t.messages.count == 1)
        let content = t.messages[0].content
        #expect(content.count == 3)
        #expect(content[0] == .thinking(ThinkingBlock(thinking: "Let me think")))
        #expect(content[1] == .text("Hello"))
        #expect(content[2].toolUse?.partialInput == "{\"comm")
    }

    @Test func deltaBeforeCreateMakesPlaceholderThenGetsReplaced() {
        var t = TranscriptReducer.merge(Transcript(sessionId: "s1"), [msg("m0", 1, .user, .text("hi"))])
        t = TranscriptReducer.apply(t, delta("s1", 0, .text, "Yo"))
        #expect(t.messages.map(\.id) == ["m0", "m1"])
        #expect(t.messages[1].seq == 2)
        t = TranscriptReducer.apply(t, .messageUpdated(msg("m1", 2, .assistant, .text("Yo there"))))
        #expect(t.messages[1].content == [.text("Yo there")])
    }

    @Test func keepsMessagesSortedAndCollectsToolResults() {
        let use = ToolUseBlock(id: "t1", name: "Bash", input: ["command": "ls"])
        var t = Transcript(sessionId: "s1")
        t = TranscriptReducer.apply(t, .messageCreated(msg("m3", 3, .user, .toolResult(ToolResultBlock(toolUseId: "t1", content: "a.txt")))))
        t = TranscriptReducer.apply(t, .messageCreated(msg("m2", 2, .assistant, .toolUse(use))))
        #expect(t.messages.map(\.id) == ["m2", "m3"])
        #expect(t.toolResults["t1"]?.text == "a.txt")

        t = TranscriptReducer.apply(t, .toolStarted(sessionId: "s1", messageId: "m2", toolUseId: "t2", name: "Read", input: [:]))
        t = TranscriptReducer.apply(t, .toolProgress(sessionId: "s1", toolUseId: "t2", text: "reading"))
        #expect(t.runningTools.contains("t2"))
        #expect(t.toolProgress["t2"] == "reading")
        t = TranscriptReducer.apply(t, .toolCompleted(sessionId: "s1", toolUseId: "t2", result: ToolResultBlock(toolUseId: "t2", content: "ok")))
        #expect(!t.runningTools.contains("t2"))
        #expect(t.toolProgress["t2"] == nil)
        #expect(t.toolResults["t2"]?.text == "ok")
    }

    @Test func mergeDeduplicatesById() {
        var t = TranscriptReducer.merge(Transcript(sessionId: "s1"), [msg("a", 1), msg("b", 2)])
        t = TranscriptReducer.merge(t, [msg("b", 2, .assistant, .text("new")), msg("c", 3)])
        #expect(t.messages.map(\.id) == ["a", "b", "c"])
        #expect(t.messages[1].content == [.text("new")])
        #expect(t.lastSeq == 3)
    }

    @Test func aLateFetchDoesNotUndoAFinishedReply() {
        // the GET left while the reply streamed; message.updated with the end came before its answer
        var t = TranscriptReducer.apply(Transcript(sessionId: "s1"), .messageCreated(msg("m1", 1)))
        t = TranscriptReducer.apply(t, .messageUpdated(msg("m1", 1, .assistant, .text("Done."), stopReason: "end_turn")))
        t = TranscriptReducer.merge(t, [msg("m0", 0, .user, .text("hi")), msg("m1", 1)])
        #expect(t.messages.map(\.id) == ["m0", "m1"])
        #expect(t.messages[1].content == [.text("Done.")])
        #expect(t.messages[1].stopReason == "end_turn")

        // a finished copy from the hub still replaces a finished one here (the hub cleared old tool output)
        t = TranscriptReducer.merge(t, [msg("m1", 1, .assistant, .text("Cleared."), stopReason: "end_turn")])
        #expect(t.messages[1].content == [.text("Cleared.")])
    }

    @Test func aReloadStartsBeforeTheReplyStillOpen() {
        #expect(TranscriptReducer.reloadAfter(Transcript(sessionId: "s1")) == nil)
        // a reply left open by a turn that failed (the hub dropped it), then one that ended
        let failed = msg("a0", 2, .assistant)
        let done = msg("a1", 4, .assistant, .text("Yes."), stopReason: "end_turn")
        let asked = msg("u2", 5, .user, .text("And?"))
        var t = TranscriptReducer.merge(Transcript(sessionId: "s1"), [msg("u1", 1, .user, .text("Hi")), failed, msg("u1b", 3, .user, .text("Again")), done, asked])
        #expect(TranscriptReducer.reloadAfter(t) == 5)
        // the reply that streamed when the socket dropped comes again, with what followed it
        t = TranscriptReducer.merge(t, [msg("a2", 6, .assistant, .text("Half")), msg("u3", 7, .user, .text("Queued"))])
        #expect(TranscriptReducer.reloadAfter(t) == 5)
    }
}
