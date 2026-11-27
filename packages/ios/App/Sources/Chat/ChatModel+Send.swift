import ConclaveKit
import Foundation
import UIKit

/// A message sent while the session was idle, on screen until the hub stores it (Android ChatViewModels Pending).
struct Outgoing: Equatable {
    var text: String
    var files: [Attachment]
    /// Message ids held when it was sent: the first new user message is its copy.
    var known: Set<String>

    func isAnswered(by m: Message) -> Bool {
        m.role == .user && m.kind == .normal && !known.contains(m.id) && !m.content.allSatisfy { $0.toolResult != nil }
    }
}

// Writing: send, the queue, stop, approvals and questions (Android ChatViewModels.kt).
extension ChatModel {
    /// The session takes no new turn now: a send waits in its queue.
    func busy(_ s: Session?) -> Bool {
        guard outgoing == nil else { return true }
        return [.running, .waitingApproval, .waitingInput].contains(s?.status ?? .idle)
    }

    var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty }

    func send(busy: Bool, dropLost: Bool = false) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = self.files
        guard !text.isEmpty || !files.isEmpty else { return }
        draft = ""
        self.files = []
        sendError = nil
        lostFile = nil
        let loss = dropLost ? "drop" : nil
        if busy {
            let id = PendingQueue.newId()
            transcript = TranscriptReducer.sent(transcript, PendingQueue.item(id, text: text, attachments: files, whenBusy: "queue", at: nowMs()))
            let r = try? await client.send(sessionId, SendInput(text: text, attachments: files.isEmpty ? nil : files, whenBusy: "queue", pendingId: id, attachmentLoss: loss))
            transcript = TranscriptReducer.answered(transcript, id, r)
            if r == nil { restore(text, files, "Could not queue the message.") }
            return
        }
        outgoing = Outgoing(text: text, files: files, known: Set(transcript.messages.map(\.id)))
        do {
            let r = try await client.send(sessionId, SendInput(text: text, attachments: files.isEmpty ? nil : files, attachmentLoss: loss))
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            // the session was busy after all: the queue shows it
            if r.queued { outgoing = nil }
        } catch {
            outgoing = nil
            let words = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
            restore(text, files, words)
            lostFile = Attach.lostWords(words)
        }
    }

    private func restore(_ text: String, _ files: [Attachment], _ why: String) {
        if draft.isEmpty { draft = text }
        self.files = files + self.files
        sendError = why
    }

    func stop() async {
        do { try await client.abort(sessionId) } catch { sendError = error.localizedDescription }
    }

    /// Takes a waiting message off; [edit] puts its words back in the composer.
    func unqueue(_ item: QueuedMessage, edit: Bool) async {
        transcript = TranscriptReducer.removed(transcript, item.id)
        do {
            try await client.unqueue(sessionId, pendingId: item.id)
        } catch let e as ConclaveAPIError where e.status == 404 || e.status == 409 {
            // it already ran or left: nothing to edit
            if edit { sendError = "That message already started." }
            return
        } catch {
            transcript = TranscriptReducer.unremoved(transcript, item)
            sendError = error.localizedDescription
            return
        }
        if edit { draft = draft.isEmpty ? item.text : draft + "\n" + item.text }
    }

    func answer(_ a: ApprovalRequest, _ r: ApprovalResponse) async {
        do {
            try await client.resolveApproval(a.id, r)
            transcript.approvals.removeAll { $0.id == a.id }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            sendError = error.localizedDescription
        }
    }

    func answer(_ q: QuestionRequest, _ answers: [String: String]) async {
        do {
            try await client.answerQuestion(q.id, answers)
            transcript.questions.removeAll { $0.id == q.id }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch { sendError = error.localizedDescription }
    }

    /// Approvals, questions and the queue waiting here when the chat opens; later ones come as events.
    func loadWaiting() async {
        let version = transcript.queueVersion
        let asked = nowMs()
        if let list = try? await client.queue(sessionId) {
            transcript = TranscriptReducer.loadedQueue(transcript, list, askedAt: asked, version: version)
        }
        if let a = try? await client.approvals() { transcript.approvals = Asks.of(a, sessionId) }
        if let q = try? await client.questions() { transcript.questions = Asks.of(q, sessionId) }
    }
}
