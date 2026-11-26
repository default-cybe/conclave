import ConclaveKit
import Foundation
import Testing
@testable import Conclave

// The bubble of a message sent while idle stays until the hub's copy of it arrives (Android ChatViewModels onMessage).
struct OutgoingTests {
    private func msg(_ id: String, _ role: Role, _ content: [ContentBlock] = [.text("hi")]) -> Message {
        Message(id: id, sessionId: "s1", seq: 1, role: role, kind: .normal, content: content, createdAt: 1)
    }

    @Test func theFirstNewUserMessageIsItsCopy() {
        let o = Outgoing(text: "hi", files: [], known: ["old"])
        #expect(o.isAnswered(by: msg("new", .user)))
        #expect(!o.isAnswered(by: msg("old", .user)))
        #expect(!o.isAnswered(by: msg("new", .assistant)))
        // a tool result rides in a user message and is not yours
        #expect(!o.isAnswered(by: msg("new", .user, [.toolResult(ToolResultBlock(toolUseId: "t1"))])))
    }
}
