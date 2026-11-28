import ConclaveKit
import Foundation
import Observation

/// One open chat's transcript: the newest page first (trimmed), older pages on demand, live events on top.
@MainActor @Observable
final class ChatModel {
    let sessionId: String
    let client: ConclaveClient
    // set by the send side too (ChatModel+Send.swift)
    var transcript: Transcript
    private(set) var loaded = false
    private(set) var loadingOlder = false
    private(set) var error: String?

    // the composer (ChatModel+Send.swift)
    var draft = ""
    var files: [Attachment] = []
    /// A message sent while idle, shown at once until the hub's copy arrives.
    var outgoing: Outgoing?
    /// Why the last send, stop or answer failed, for the composer's line.
    var sendError: String?
    /// The hub could not read a file: the words to ask "Send without it?" with.
    var lostFile: String?
    /// The "/" menu's commands (ChatModel+Send loadCommands): /btw, then the hub's.
    var commands: [CommandDef] = []
    /// What the last command said (Compacted., an aside's answer), over the composer.
    var notice: String?
    /// The Markdown /export made, for the share sheet.
    var exported: String?

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
            await loadWaiting()
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
        if case .messageCreated(let m) = e, let o = outgoing, o.isAnswered(by: m) { outgoing = nil }
    }
}
