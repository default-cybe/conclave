import Foundation

/// "Try the next model" after a refusal (POST /api/sessions/:id/next-model; Android logic/NextModel.kt).
public enum NextModel {
    public static let label = "Try the next model"
    /// While the hub takes it.
    public static let busy = "Trying"

    /// The notice that offers it and the refused reply it drops.
    public struct Offer: Sendable, Hashable {
        public var notice: Message
        public var reply: Message
    }

    /// A failed provider call stays unresolved through switch and incidental notices, even after expiry.
    public static func providerFailure(_ messages: [Message]) -> Message? {
        for m in messages.reversed() {
            if m.kind != .notice { return nil }
            if m.meta?["type"]?.string == "provider_error" { return m }
        }
        return nil
    }

    /// A refusal notice that offers the next model (canTryNext must be the boolean true).
    public static func offers(_ m: Message) -> Bool {
        m.kind == .notice && m.meta?["type"]?.string == "refusal" && m.meta?["canTryNext"]?.bool == true
    }

    /// The newest offering notice while only notices and the "Not run" answers to the refused
    /// reply's calls came after it. A reply, a message of yours or a newer offer ends it.
    public static func notice(_ messages: [Message]) -> Message? {
        for m in messages.reversed() {
            if offers(m) { return m }
            let toolResultsOnly = !m.content.isEmpty && m.content.allSatisfy { $0.toolResult != nil }
            if m.kind == .notice || (m.role == .user && m.kind == .normal && toolResultsOnly) { continue }
            return nil
        }
        return nil
    }

    /// The reply [notice] is about: the last reply before it, when it ended in a refusal.
    public static func refused(_ messages: [Message], _ notice: Message) -> Message? {
        guard let at = messages.firstIndex(where: { $0.id == notice.id }) else { return nil }
        let reply = messages[..<at].last { $0.role == .assistant && $0.kind == .normal }
        return reply?.stopReason == "refusal" ? reply : nil
    }

    /// Nothing runs and nothing waits on you: the hub takes it only then.
    public static func ready(_ status: SessionStatus?) -> Bool {
        guard let status else { return false }
        return status != .running && status != .waitingApproval && status != .waitingInput
    }

    public static func of(_ messages: [Message], _ status: SessionStatus?) -> Offer? {
        guard ready(status), let n = notice(messages), let r = refused(messages, n) else { return nil }
        return Offer(notice: n, reply: r)
    }
}
