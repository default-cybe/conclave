import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client NextModelTest.kt: "Try the next model" after a refusal,
// message.deleted in the transcript, and the step notices changing in place. The transcript is
// the web mock's (packages/web/src/mock/data.ts fwTranscript).

private func msg(
    _ id: String, _ seq: Int64, _ role: Role = .assistant, _ blocks: ContentBlock...,
    kind: MessageKind = .normal, stopReason: String? = nil, meta: JSONObject? = nil, model: String? = nil
) -> Message {
    Message(id: id, sessionId: "s_fw", seq: seq, role: role, kind: kind, content: blocks, model: model, stopReason: stopReason, meta: meta)
}

private func notice(_ id: String, _ seq: Int64, _ text: String, _ meta: JSONObject) -> Message {
    msg(id, seq, .assistant, .text(text), kind: .notice, meta: meta)
}

private func reseq(_ m: Message, _ seq: Int64) -> Message {
    var out = m
    out.seq = seq
    return out
}

private let offerMeta: JSONObject = ["type": "refusal", "canTryNext": true, "level": "warning"]

private let ask1 = msg("u1", 1, .user, .text("Walk me through the stack overflow in httpd."))
private let answered = notice("n1", 2, "Opus 5.5 (neu) declined. Answered by Opus 5.5 (personal).", ["type": "refusal", "outcome": "answered", "level": "info"])
private let reply1 = msg("a1", 3, .assistant, .text("handle_login() copies the user field with strcpy."), stopReason: "end_turn", model: "cliproxy/claude-opus-5-5")
private let ask2 = msg("u2", 4, .user, .text("Now draft the vendor advisory."))
private let refused = msg("a2", 5, .assistant, .text("I can not help with that part."), stopReason: "refusal", model: "cliproxy/claude-opus-5-5")
private let offer = notice("n2", 6, "The model refused to continue.", offerMeta)
private let transcript = [ask1, answered, reply1, ask2, refused, offer]

struct NextModelTests {
    @Test func decodesMessageDeleted() {
        let frame = Frame.parse(#"{"type":"message.deleted","seq":7,"ts":1,"sessionId":"s_fw","messageId":"a2"}"#)
        guard case .event(let env) = frame else {
            Issue.record("not an event: \(frame)")
            return
        }
        #expect(env.event == .messageDeleted(sessionId: "s_fw", messageId: "a2"))
        #expect(env.event.sessionKey == "s_fw")
        #expect(env.type == "message.deleted")
    }

    @Test func aDeletedReplyLeavesTheTranscriptAtOnce() {
        var t = TranscriptReducer.merge(Transcript(sessionId: "s_fw"), transcript)
        t = TranscriptReducer.apply(t, .messageDeleted(sessionId: "s_fw", messageId: "a2"))
        #expect(t.messages.map(\.id) == ["u1", "n1", "a1", "u2", "n2"])
        // another chat's, or one that is not here: nothing changes
        #expect(TranscriptReducer.apply(t, .messageDeleted(sessionId: "other", messageId: "a1")) == t)
        #expect(TranscriptReducer.apply(t, .messageDeleted(sessionId: "s_fw", messageId: "gone")) == t)
    }

    @Test func aDeletedReplysCallsStopRunning() {
        let use = ToolUseBlock(id: "t1", name: "Bash")
        var t = TranscriptReducer.apply(Transcript(sessionId: "s_fw"), .messageCreated(msg("a3", 1, .assistant, .toolUse(use))))
        t = TranscriptReducer.apply(t, .toolStarted(sessionId: "s_fw", messageId: "a3", toolUseId: "t1", name: "Bash", input: [:]))
        t = TranscriptReducer.apply(t, .toolProgress(sessionId: "s_fw", toolUseId: "t1", text: "running"))
        #expect(t.runningTools == ["t1"])
        t = TranscriptReducer.apply(t, .messageDeleted(sessionId: "s_fw", messageId: "a3"))
        #expect(t.messages.isEmpty)
        #expect(t.runningTools.isEmpty)
        #expect(t.toolProgress.isEmpty)
    }

    @Test func theStepNoticeChangesInPlace() {
        // the automatic walk: the refused reply goes, one notice says the step, then the answer
        var t = TranscriptReducer.merge(Transcript(sessionId: "s_fw"), [ask1])
        t = TranscriptReducer.apply(t, .messageCreated(msg("a0", 2, .assistant, .text("I can"), model: "cliproxy/neu/claude-opus-5-5")))
        t = TranscriptReducer.apply(t, .messageDeleted(sessionId: "s_fw", messageId: "a0"))
        let trying = notice("n1", 3, "Opus 5.5 (neu) declined. Trying Opus 5.5 (personal).", ["type": "refusal", "outcome": "trying", "level": "warning"])
        t = TranscriptReducer.apply(t, .messageCreated(trying))
        t = TranscriptReducer.apply(t, .messageCreated(reseq(reply1, 4)))
        t = TranscriptReducer.apply(t, .messageUpdated(reseq(answered, 3)))
        #expect(t.messages.map(\.id) == ["u1", "n1", "a1"])
        #expect(t.messages[1].content.plainText == "Opus 5.5 (neu) declined. Answered by Opus 5.5 (personal).")
    }

    @Test func providerFailureSurvivesSwitchAndIncidentalNoticesAndExpiryButNotNewTurns() {
        let failure = notice("error", 7, "Error", ["type": "provider_error", "canRetry": true])
        let switched = notice("switch", 8, "Switched model", ["type": "handoff"])
        let incidental = notice("info", 9, "Status update", ["level": "info"])
        #expect(NextModel.providerFailure(transcript + [failure, switched, incidental]) == failure)
        var expired = failure
        expired.meta = ["type": "provider_error", "canRetry": false, "retryExpired": true]
        #expect(NextModel.providerFailure(transcript + [expired, switched]) == expired)
        #expect(NextModel.providerFailure(transcript + [failure, switched, msg("u3", 10, .user, .text("New request"))]) == nil)
        #expect(NextModel.providerFailure(transcript + [failure, reseq(reply1, 10)]) == nil)
    }

    @Test func offersOnlyOnARefusalNoticeThatSaysSo() {
        #expect(NextModel.offers(offer))
        #expect(!NextModel.offers(answered))
        #expect(!NextModel.offers(notice("x", 9, "No.", ["type": "refusal", "canTryNext": false])))
        #expect(!NextModel.offers(notice("x", 9, "No.", ["type": "refusal", "canTryNext": "true"])))
        #expect(!NextModel.offers(notice("x", 9, "No.", ["type": "limit", "canTryNext": true])))
        #expect(!NextModel.offers(notice("x", 9, "No.", [:])))
        // a reply is never the offer, whatever its meta says
        var reply = refused
        reply.meta = offerMeta
        #expect(!NextModel.offers(reply))
    }

    @Test func theOfferIsTheRefusedReplyAndItsNotice() throws {
        let o = try #require(NextModel.of(transcript, .idle))
        #expect(o.notice.id == "n2")
        #expect(o.reply.id == "a2")
        // a failed turn or a limit still takes it; a running one or one waiting on you does not
        #expect(NextModel.of(transcript, .error)?.reply.id == "a2")
        #expect(NextModel.of(transcript, .waitingReset)?.reply.id == "a2")
        #expect(NextModel.of(transcript, .running) == nil)
        #expect(NextModel.of(transcript, .waitingApproval) == nil)
        #expect(NextModel.of(transcript, .waitingInput) == nil)
        #expect(NextModel.of(transcript, nil) == nil)
    }

    @Test func theNotRunAnswersAndOtherNoticesDoNotEndIt() {
        // a refused reply with calls: they were answered "Not run", then the notice
        let use = ToolUseBlock(id: "t1", name: "Bash")
        var withCalls = refused
        withCalls.content = [.text("Running it."), .toolUse(use)]
        let notRun = msg("r1", 6, .user, .toolResult(ToolResultBlock(toolUseId: "t1", content: "Not run: the model refused.", isError: true)))
        let callsNotice = notice("n3", 7, "The model refused, so the tool calls in its reply were not run.", offerMeta)
        let list = [ask1, answered, reply1, ask2, withCalls, notRun, callsNotice]
        #expect(NextModel.of(list, .idle)?.reply.id == "a2")
        // a notice after it (a step that came to nothing) leaves it standing
        let later = notice("n4", 8, "Background task finished.", ["level": "info"])
        #expect(NextModel.of(list + [later], .idle)?.notice.id == "n3")
    }

    @Test func aReplyOrAMessageOfYoursAfterItEndsIt() {
        #expect(NextModel.of(transcript + [msg("u3", 7, .user, .text("Never mind."))], .idle) == nil)
        #expect(NextModel.of(transcript + [msg("a3", 7, .assistant, .text("Here is a draft."), stopReason: "end_turn")], .idle) == nil)
        // a second opinion after it: the hub takes only the last reply
        #expect(NextModel.of(transcript + [msg("x1", 7, .assistant, .text("Another view."), kind: .aside)], .idle) == nil)
    }

    @Test func goneOnceTheHubDropsTheRefusedReply() {
        var t = TranscriptReducer.merge(Transcript(sessionId: "s_fw"), transcript)
        #expect(NextModel.of(t.messages, .idle)?.reply.id == "a2")
        t = TranscriptReducer.apply(t, .messageDeleted(sessionId: "s_fw", messageId: "a2"))
        #expect(NextModel.of(t.messages, .idle) == nil)
    }

    @Test func theNewestRefusalWins() throws {
        let refusedAgain = msg("a4", 9, .assistant, .text("No."), stopReason: "refusal")
        let offerAgain = notice("n5", 10, "The model refused to continue.", offerMeta)
        let list = transcript + [msg("a3", 7, .assistant, .text("Draft."), stopReason: "end_turn"), msg("u3", 8, .user, .text("More.")), refusedAgain, offerAgain]
        let o = try #require(NextModel.of(list, .idle))
        #expect(o.notice.id == "n5")
        #expect(o.reply.id == "a4")
        // a notice that offers it after a reply that was not refused offers nothing
        #expect(NextModel.of([ask1, reply1, reseq(offer, 4)], .idle) == nil)
    }

    @Test func theWordsAreShortAndPlain() {
        #expect(NextModel.label == "Try the next model")
        #expect(NextModel.busy == "Trying")
        for w in [NextModel.label, NextModel.busy] {
            #expect(!w.contains { $0 == "\u{2014}" || $0 == "\u{2013}" })
        }
    }
}
