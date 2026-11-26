import ConclaveKit
import Foundation
import Observation

/// One open chat's transcript: the newest page first (trimmed), older pages on demand, live events on top.
@MainActor @Observable
final class ChatModel {
    let sessionId: String
    let client: ConclaveClient
    private(set) var transcript: Transcript
    private(set) var loaded = false
    private(set) var loadingOlder = false
    private(set) var error: String?

    init(sessionId: String, client: ConclaveClient) {
        self.sessionId = sessionId
        self.client = client
        transcript = Transcript(sessionId: sessionId)
    }

    func loadIfNeeded() async {
        guard !loaded else { return }
        await reload()
    }

    func reload() async {
        do {
            let page = try await client.messages(sessionId, limit: TranscriptReducer.page, trim: true)
            transcript = TranscriptReducer.loaded(Transcript(sessionId: sessionId), page, paged: true)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    /// The page before the first message held. False when there was none to read.
    @discardableResult
    func loadOlder() async -> Bool {
        guard !loadingOlder, let before = TranscriptReducer.olderBefore(transcript) else { return false }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await client.messages(sessionId, beforeSeq: before, limit: TranscriptReducer.page, trim: true)
            transcript = TranscriptReducer.olderPage(transcript, page)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// After a reconnect: what came while the socket was down.
    func catchUp() async {
        guard loaded else { return }
        // nothing held yet: the newest page, never the whole chat
        guard let after = TranscriptReducer.reloadAfter(transcript) else { return await reload() }
        guard let fetched = try? await client.messages(sessionId, afterSeq: after, trim: true) else { return }
        transcript = TranscriptReducer.merge(transcript, fetched)
    }

    func apply(_ e: EngineEvent) {
        transcript = TranscriptReducer.apply(transcript, e)
    }
}
