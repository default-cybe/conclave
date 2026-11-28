import Foundation

/// Which messages Copy, Edit and Retry act on, and where a rewind cuts (Android ChatViewModel retryLast and
/// retryBefore, ChatItems.isToolResultsOnly, AgentResults.isContextOnly; the web's Turn.tsx edit).
public enum SessionActions {
    /// Said instead of a retry after a failed provider call: replaying the turn could repeat completed operations.
    public static let providerRetry = "Use Retry with another model. Replaying this turn could repeat completed operations."

    /// A message the owner wrote: a normal user message with words, a picture or a document of theirs.
    /// Tool results and hub context (reminders, a background task's report) are not.
    public static func isOwn(_ m: Message) -> Bool {
        m.role == .user && m.kind == .normal && m.content.contains { b in
            switch b {
            case .text(let t): !b.isReminder && !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .image, .document: true
            default: false
            }
        }
    }

    /// The last message the owner wrote: what Retry sends again.
    public static func lastUser(_ messages: [Message]) -> Message? { messages.last(where: isOwn) }

    /// The owner's message a reply answers: the last one of theirs before `seq`.
    public static func asker(_ messages: [Message], before seq: Int64) -> Message? {
        messages.last { $0.seq < seq && isOwn($0) }
    }

    /// Where Edit and Retry rewind to: the hub keeps messages up to this seq, so `user` and all after it leave.
    public static func rewindSeq(_ user: Message) -> Int64 { user.seq - 1 }

    /// Why Retry must not replay the last turn now (a provider failure is retried with another model); nil when it may.
    public static func retryRefusal(_ messages: [Message]) -> String? {
        NextModel.providerFailure(messages) == nil ? nil : providerRetry
    }

    /// The ids of replies that end a turn: the last normal assistant message before the next message of the
    /// owner's, or before the end. Copy and Retry show under these.
    public static func turnEnds(_ messages: [Message]) -> Set<String> {
        var out: Set<String> = []
        var open = true
        for m in messages.reversed() {
            if isOwn(m) { open = true } else if open, m.role == .assistant, m.kind == .normal {
                out.insert(m.id)
                open = false
            }
        }
        return out
    }

    /// A turn's words, for its Copy: the text of every normal reply after the owner's message up to `end`.
    public static func turnText(_ messages: [Message], end: Message) -> String {
        let from = asker(messages, before: end.seq)?.seq ?? Int64.min
        return messages.filter { $0.seq > from && $0.seq <= end.seq && $0.role == .assistant && $0.kind == .normal }
            .map { $0.content.visibleText }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// What Copy puts on the clipboard for one message: the words without the hub's reminders.
    public static func copyText(_ m: Message) -> String { m.content.visibleText }
}
