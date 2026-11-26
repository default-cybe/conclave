import Foundation

/// What the inline approval and question cards offer and send (Android ui/chat/Cards.kt, logic/Inbox.kt).
public enum AskCards {
    /// GitHub pushes and pull requests ask each time.
    public static let pullRequest = "PullRequest"

    /// The card offers "Allow for this chat" and "Always allow": not when the hub counts them as once
    /// (an untrusted session) or for a push or a pull request.
    public static func wider(_ a: ApprovalRequest) -> Bool { !a.noAlways && a.tool != pullRequest }

    /// A question card can send once every question has a pick or an Other answer.
    public static func ready(_ q: QuestionRequest, picked: [Int: Set<String>], other: [Int: String]) -> Bool {
        q.questions.indices.allSatisfy { !(picked[$0] ?? []).isEmpty || !(other[$0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// The answers body by question text: the Other answer when there is one, else the picked labels
    /// in the order the options list them, joined with ", ".
    public static func answers(_ q: QuestionRequest, picked: [Int: Set<String>], other: [Int: String]) -> [String: String] {
        var out: [String: String] = [:]
        for (i, question) in q.questions.enumerated() {
            let typed = (other[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let chosen = picked[i] ?? []
            out[question.question] = typed.isEmpty ? question.options.map(\.label).filter(chosen.contains).joined(separator: ", ") : typed
        }
        return out
    }

    /// A tap on an option: single choice replaces the pick, multiple choice toggles it.
    public static func tap(_ picked: Set<String>, _ label: String, multi: Bool) -> Set<String> {
        guard multi else { return [label] }
        return picked.contains(label) ? picked.subtracting([label]) : picked.union([label])
    }
}
