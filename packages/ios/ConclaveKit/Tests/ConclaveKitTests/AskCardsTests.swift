import Foundation
import Testing
@testable import ConclaveKit

// The inline cards' rules (Android ui/chat/Cards.kt and logic/Inbox.kt approvalWider): what an approval
// offers and the answers body a question sends.
struct AskCardsTests {
    private let question: QuestionRequest = try! decode("""
    {"id":"q1","sessionId":"s1","questions":[
      {"question":"Which day?","options":[{"label":"Monday","description":"before the trip"},{"label":"Friday"}]},
      {"question":"Which parts?","multiSelect":true,"options":[{"label":"Docs"},{"label":"Tests"},{"label":"Code"}]}
    ]}
    """)

    @Test func wideChoicesOnlyWhenOffered() throws {
        var a = ApprovalRequest(id: "a1", sessionId: "s1")
        a.tool = "Bash"
        #expect(AskCards.wider(a))
        a.noAlways = true
        #expect(!AskCards.wider(a))
        a.noAlways = false
        a.tool = AskCards.pullRequest
        #expect(!AskCards.wider(a))
        // the body each button sends
        #expect(try encode(ApprovalResponse.allowOnce) == #"{"decision":"allow","scope":"once"}"#)
        #expect(try encode(ApprovalResponse.deny()) == #"{"decision":"deny"}"#)
    }

    @Test func singleReplacesMultipleToggles() {
        #expect(AskCards.tap(["Monday"], "Friday", multi: false) == ["Friday"])
        #expect(AskCards.tap(["Docs"], "Tests", multi: true) == ["Docs", "Tests"])
        #expect(AskCards.tap(["Docs", "Tests"], "Docs", multi: true) == ["Tests"])
    }

    @Test func sendsOnceEveryQuestionHasAnAnswer() {
        #expect(!AskCards.ready(question, picked: [0: ["Monday"]], other: [:]))
        #expect(!AskCards.ready(question, picked: [0: ["Monday"]], other: [1: "  "]))
        #expect(AskCards.ready(question, picked: [0: ["Monday"]], other: [1: "all of it"]))
        #expect(AskCards.ready(question, picked: [0: ["Monday"], 1: ["Code"]], other: [:]))
    }

    @Test func answersByQuestionTextOtherFirstLabelsInListOrder() {
        let a = AskCards.answers(question, picked: [0: ["Friday"], 1: ["Code", "Docs"]], other: [:])
        #expect(a == ["Which day?": "Friday", "Which parts?": "Docs, Code"])
        let b = AskCards.answers(question, picked: [0: ["Friday"]], other: [0: " Sunday "])
        #expect(b["Which day?"] == "Sunday")
    }
}
