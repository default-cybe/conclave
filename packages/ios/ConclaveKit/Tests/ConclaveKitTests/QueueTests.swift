import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client QueueTest.kt: messages sent while a session works show at once,
// the hub's list takes them over, the stored message takes their place in the same copy, and a
// load never lays an older list over a newer one.
struct QueueTests {
    private func q(_ id: String, _ text: String? = nil, whenBusy: String = "queue") -> QueuedMessage {
        QueuedMessage(id: id, text: text ?? id, at: 1, whenBusy: whenBusy)
    }

    private func user(_ id: String, _ seq: Int64, _ pending: String..., whenBusy: String? = nil) -> Message {
        var meta: JSONObject = [:]
        if !pending.isEmpty { meta["pendingIds"] = .array(pending.map { .string($0) }) }
        if let whenBusy { meta["whenBusy"] = .string(whenBusy) }
        return Message(id: id, sessionId: "s1", seq: seq, role: .user, kind: .normal, content: [.text(id)], createdAt: seq, meta: meta.isEmpty ? nil : meta)
    }

    private func ids(_ t: Transcript) -> [String] { t.pending.map(\.id) }

    @Test func theEventAndTheSendDecodeAndEncode() throws {
        let frame = Frame.parse(#"{"type":"session.queue","seq":7,"ts":5,"sessionId":"s1","queue":[{"id":"q_1","text":"next","at":3,"whenBusy":"steer","attachments":[{"name":"a.png","mediaType":"image/png"}]}]}"#)
        guard case .event(let env) = frame, case .sessionQueue(_, let queue) = env.event else {
            Issue.record("not a session.queue event: \(frame)")
            return
        }
        #expect(env.event.sessionKey == "s1")
        #expect(queue.count == 1)
        let item = try #require(queue.first)
        #expect(item.id == "q_1")
        #expect(item.text == "next")
        #expect(item.at == 3)
        #expect(item.whenBusy == "steer")
        #expect(item.attachments.map(\.name) == ["a.png"])
        #expect(item.attachments.map(\.mediaType) == ["image/png"])
        #expect(try decode(#"{"queued":true,"pendingId":"q_1"}"#) == SendResult(queued: true, pendingId: "q_1"))
        let body = try encode(SendInput(text: "hi", whenBusy: "queue", pendingId: "a_x1y2z3"))
        #expect(body.contains(#""pendingId":"a_x1y2z3""#), "\(body)")
        // an idle send carries no id, as before
        #expect(!(try encode(SendInput(text: "hi"))).contains("pendingId"))
    }

    @Test func theRules() {
        #expect(PendingQueue.shown([q("a"), q("b")], [Sending(q("b")), Sending(q("c"))]).map(\.id) == ["a", "b", "c"])
        let hub = [q("a")]
        #expect(PendingQueue.shown(hub, []) == hub)

        let sending = [Sending(q("mine")), Sending(q("done"), confirmedAt: 100)]
        #expect(PendingQueue.afterHubList(sending, [q("other")]).map(\.item.id) == ["mine", "done"])
        #expect(PendingQueue.afterHubList(sending, [q("mine")]).map(\.item.id) == ["done"])
        // a load asked after the hub answered "done" is the whole truth; one asked before is not
        #expect(PendingQueue.afterHubList(sending, [], loadedFrom: 200).map(\.item.id) == ["mine"])
        #expect(PendingQueue.afterHubList(sending, [], loadedFrom: 50).map(\.item.id) == ["mine", "done"])

        #expect(PendingQueue.pendingIds(user("u", 1, "a", "b")) == ["a", "b"])
        #expect(PendingQueue.pendingIds(user("u", 1)).isEmpty)
        #expect(PendingQueue.replacesPending(user("u", 1, "a")))
        // the row of the stored message keeps the waiting one's key
        #expect(PendingQueue.keyOf(user("u", 1, "a")) == "p:a")
        #expect(PendingQueue.keyOf(user("u", 1)) == "u")

        var r1 = SeededRandom(1), r2 = SeededRandom(2)
        let id = PendingQueue.newId(now: 1_700_000_000_000, using: &r1)
        #expect(PendingQueue.validId(id), "\(id)")
        #expect(id.hasPrefix("a_"))
        #expect(!PendingQueue.validId("no spaces!"))
        #expect(id != PendingQueue.newId(now: 1_700_000_000_000, using: &r2))
    }

    @Test func theWords() {
        #expect(PendingQueue.pendingWord("queue") == "Queued")
        #expect(PendingQueue.pendingWord("steer") == "Sending to the running turn")
        #expect(PendingQueue.pendingWord("queue", held: true) == "Stopped")
        #expect(PendingQueue.storedWord(user("u", 1, "a", whenBusy: "queue").meta) == "Queued")
        #expect(PendingQueue.storedWord(user("u", 1, "a", whenBusy: "steer").meta) == "Steered the running turn")
        #expect(PendingQueue.storedWord(user("u", 1).meta) == nil)
        let item = PendingQueue.item("a_1", text: "look", attachments: [Attachment(mediaType: "image/png", data: "eA==", name: "x.png")], whenBusy: "steer", at: 9)
        var want = QueuedMessage(id: "a_1", text: "look", at: 9, whenBusy: "steer")
        want.attachments = [QueuedAttachment(name: "x.png", mediaType: "image/png")]
        #expect(item == want)
    }

    @Test func yoursShowsAtOnceAndTheHubsListTakesItOver() {
        var t = TranscriptReducer.sent(Transcript(sessionId: "s1"), q("a_1", "next"))
        #expect(ids(t) == ["a_1"])
        // an event from before the hub had it keeps it
        t = TranscriptReducer.apply(t, .sessionQueue(sessionId: "s1", queue: [q("other")]))
        #expect(ids(t) == ["other", "a_1"])
        t = TranscriptReducer.apply(t, .sessionQueue(sessionId: "s1", queue: [q("other"), q("a_1", "next")]))
        #expect(ids(t) == ["other", "a_1"])
        #expect(t.sending.isEmpty)
        #expect(t.queueVersion == 2)
        // another session's list leaves this one alone
        #expect(TranscriptReducer.apply(t, .sessionQueue(sessionId: "s2", queue: [])) == t)
    }

    @Test func theStoredMessageTakesItsPlaceInOneCopy() {
        var t = TranscriptReducer.apply(Transcript(sessionId: "s1"), .sessionQueue(sessionId: "s1", queue: [q("a"), q("b")]))
        t = TranscriptReducer.sent(t, q("c"))
        t = TranscriptReducer.apply(t, .messageCreated(user("u-a", 3, "a", whenBusy: "queue")))
        // the message is there and its bubble is not, in the same copy
        #expect(t.messages.map(\.id) == ["u-a"])
        #expect(ids(t) == ["b", "c"])
        t = TranscriptReducer.apply(t, .messageCreated(user("u-c", 4, "c")))
        #expect(ids(t) == ["b"])
        // a message without ids leaves the list as it is
        let before = t
        t = TranscriptReducer.apply(t, .messageCreated(user("u5", 5)))
        #expect(t.queue == before.queue)
        // a transcript load that brings the message drops its bubble too
        var u = TranscriptReducer.apply(Transcript(sessionId: "s1"), .sessionQueue(sessionId: "s1", queue: [q("x")]))
        u = TranscriptReducer.merge(u, [user("u-x", 1, "x")])
        #expect(ids(u).isEmpty)
    }

    @Test func theHubsAnswer() {
        var t = TranscriptReducer.sent(Transcript(sessionId: "s1"), q("a_1"))
        t = TranscriptReducer.answered(t, "a_1", SendResult(queued: true, pendingId: "a_1"), now: 10)
        #expect(t.sending.map(\.confirmedAt) == [10])
        // the session was free after all and it ran at once, or the send failed: it leaves
        t = TranscriptReducer.sent(t, q("a_2"))
        t = TranscriptReducer.answered(t, "a_2", SendResult(queued: false))
        #expect(ids(t) == ["a_1"])
        t = TranscriptReducer.sent(t, q("a_3"))
        t = TranscriptReducer.answered(t, "a_3", nil)
        #expect(ids(t) == ["a_1"])
    }

    @Test func removeTakesItOffAndARefusalPutsItBack() {
        var t = TranscriptReducer.apply(Transcript(sessionId: "s1"), .sessionQueue(sessionId: "s1", queue: [q("a"), q("b")]))
        t = TranscriptReducer.sent(t, q("c"))
        t = TranscriptReducer.removed(t, "a")
        t = TranscriptReducer.removed(t, "c")
        #expect(ids(t) == ["b"])
        t = TranscriptReducer.unremoved(t, q("a"))
        #expect(ids(t) == ["b", "a"])
        // never twice
        #expect(TranscriptReducer.unremoved(t, q("b")) == t)
    }

    @Test func aLoadNeverLaysAnOlderListOverANewerOne() {
        var t = TranscriptReducer.merge(Transcript(sessionId: "s1"), [user("u-a", 1, "a")])
        t = TranscriptReducer.loadedQueue(t, [q("a"), q("b")], askedAt: 5, version: t.queueVersion)
        // never one already in the transcript
        #expect(ids(t) == ["b"])
        let version = t.queueVersion
        t = TranscriptReducer.apply(t, .sessionQueue(sessionId: "s1", queue: [q("c")]))
        t = TranscriptReducer.loadedQueue(t, [q("b")], askedAt: 6, version: version)
        #expect(ids(t) == ["c"])
        // a confirmed send the load does not list is gone; an unconfirmed one is still on its way
        var u = TranscriptReducer.answered(TranscriptReducer.sent(Transcript(sessionId: "s1"), q("a_1")), "a_1", SendResult(queued: true, pendingId: "a_1"), now: 10)
        u = TranscriptReducer.sent(u, q("a_2"))
        u = TranscriptReducer.loadedQueue(u, [], askedAt: 20, version: u.queueVersion)
        #expect(ids(u) == ["a_2"])
    }
}
