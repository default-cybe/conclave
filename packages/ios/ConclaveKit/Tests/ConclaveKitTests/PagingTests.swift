import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client PagingTest.kt: the newest page comes light (trim=1), older
// pages come on scroll with beforeSeq, and a picture the page left out is read from its block
// only when it shows.
struct PagingTests {
    private func msg(_ seq: Int64) -> Message {
        Message(id: "m\(seq)", sessionId: "s1", seq: seq, role: .user, content: [.text("\(seq)")])
    }

    @Test func readsTheNewestPageLightAndMarksWhatItCut() async throws {
        let hub = MockHub()
        hub.enqueue(try fixture("trimmed-page"))
        let list = try await hub.client("t").messages("s1", limit: TranscriptReducer.page, trim: true)
        let req = try #require(hub.take())
        #expect(req.path == "/api/sessions/s1/messages")
        #expect(req.query("limit") == "200")
        #expect(req.query("trim") == "1")
        #expect(req.query("afterSeq") == nil)

        // a cut picture names its block; a small one keeps its data and gets no ref
        guard case .image(let img) = list[0].content[1], case .image(let small) = list[2].content[0] else { Issue.record("no images"); return }
        #expect(BlockRef.of(img.url) == BlockRef(sessionId: "s1", messageId: "m1", index: 1))
        #expect(small.data == "AAAA")
        #expect(small.url == nil)

        // a tool's picture names its part
        guard case .toolResult(let r) = list[1].content[0] else { Issue.record("no tool result"); return }
        let shot = try #require(r.content.array?[1])
        #expect(shot["data"] == nil)
        #expect(BlockRef.of(shot["url"]?.string) == BlockRef(sessionId: "s1", messageId: "m2", index: 0, part: 1))
    }

    @Test func aWholeReadStaysAsItWas() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"m1","sessionId":"s1","seq":1,"role":"user","content":[]}]"#)
        _ = try await hub.client("t").messages("s1", afterSeq: 7)
        let req = try #require(hub.take())
        #expect(req.query("afterSeq") == "7")
        #expect(req.query("limit") == nil)
        #expect(req.query("trim") == nil)
        #expect(req.query("beforeSeq") == nil)
    }

    @Test func readsACutPictureFromItsBlock() async throws {
        let hub = MockHub()
        let c = hub.client("t")
        hub.enqueue(#"{"type":"image","mediaType":"image/png","data":"QUJD"}"#)
        #expect(try await c.blockData(BlockRef(sessionId: "s1", messageId: "m1", index: 1)) == "QUJD")
        #expect(try #require(hub.take()).path == "/api/sessions/s1/messages/m1/blocks/1")

        hub.enqueue(#"{"type":"tool_result","toolUseId":"t1","content":[{"type":"text","text":"shot"},{"type":"image","mediaType":"image/png","data":"WFla"}]}"#)
        #expect(try await c.blockData(BlockRef(sessionId: "s1", messageId: "m2", index: 0, part: 1)) == "WFla")
        #expect(try #require(hub.take()).path == "/api/sessions/s1/messages/m2/blocks/0")
    }

    @Test func refsRoundTripAndOtherUrlsAreNotRefs() {
        let ref = BlockRef(sessionId: "ses_0mwubt3145w1mp4ql0k", messageId: "msg_1", index: 3, part: 2)
        #expect(BlockRef.of(ref.url) == ref)
        let plain = BlockRef(sessionId: "s", messageId: "m", index: 0)
        #expect(BlockRef.of(plain.url) == plain)
        #expect(BlockRef.of("https://example.com/a.png") == nil)
        #expect(BlockRef.of(nil) == nil)
        #expect(BlockRef.of("conclave-block:s/m/x") == nil)
    }

    @Test func pagesBackToTheStart() {
        // a full newest page: older messages wait, read before the first one held
        var t = TranscriptReducer.loaded(Transcript(sessionId: "s1"), (101...300).map(msg), paged: true)
        #expect(t.older)
        #expect(TranscriptReducer.olderBefore(t) == 101)

        // a short older page: the start, and nothing more to read
        t = TranscriptReducer.olderPage(t, (1...100).map(msg))
        #expect(!t.older)
        #expect(TranscriptReducer.olderBefore(t) == nil)
        #expect(t.messages.map(\.seq) == Array(1...300))
    }

    @Test func aFullOlderPageKeepsGoingAndAShortChatHasNone() {
        var t = TranscriptReducer.loaded(Transcript(sessionId: "s1"), (401...600).map(msg), paged: true)
        t = TranscriptReducer.olderPage(t, (201...400).map(msg))
        #expect(t.older)
        #expect(TranscriptReducer.olderBefore(t) == 201)

        // a chat shorter than a page is whole at once
        let short = TranscriptReducer.loaded(Transcript(sessionId: "s1"), (1...5).map(msg), paged: true)
        #expect(!short.older)
        #expect(TranscriptReducer.olderBefore(short) == nil)

        // a reload after a reconnect (afterSeq) leaves what the paging knew
        let again = TranscriptReducer.loaded(t, [msg(601)], paged: false)
        #expect(again.older)
        #expect(again.lastSeq == 601)
    }
}
