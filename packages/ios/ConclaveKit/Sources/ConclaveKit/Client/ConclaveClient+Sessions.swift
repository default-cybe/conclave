import Foundation

// Sessions, the transcript, sending, approvals and models. Other pages add their own files.
extension ConclaveClient {
    public func listSessions(
        archived: Bool? = nil, search: String? = nil, limit: Int? = nil, offset: Int? = nil,
        parentId: String? = nil, kind: SessionKind? = nil, agent: String? = nil, tag: String? = nil
    ) async throws -> [Session] {
        try await get(["api", "sessions"], query: [
            ("agent", agent), ("archived", archived.map { "\($0)" }), ("search", search), ("limit", limit.map { "\($0)" }),
            ("parentId", parentId), ("kind", kind?.rawValue), ("tag", tag), ("offset", offset.map { "\($0)" }),
        ])
    }

    /// Every top-level session, page by page up to 40 pages: a day of subagents must not push
    /// older chats out of the list. Their children load with the parent.
    public func topLevelSessions(archived: Bool, page: Int = 500) async throws -> [Session] {
        var out: [Session] = []
        var offset = 0
        while offset < 40 * page {
            let got = try await listSessions(archived: archived, limit: page, offset: offset, parentId: "none")
            out += got
            if got.count < page { break }
            offset += page
        }
        return out
    }

    public func session(_ id: String) async throws -> Session { try await get(["api", "sessions", id]) }

    public func createSession(_ input: CreateSessionInput) async throws -> Session { try await send("POST", ["api", "sessions"], input) }

    public func updateSession(_ id: String, _ patch: SessionPatch) async throws -> Session {
        try await send("PATCH", ["api", "sessions", id], JSONValue.object(patch.json))
    }

    public func deleteSession(_ id: String) async throws { try await sendUnit("DELETE", ["api", "sessions", id]) }

    /// The owner opened it: no longer unread.
    public func markSeen(_ id: String) async throws -> Session { try await call("POST", ["api", "sessions", id, "seen"]) }

    /// The transcript, whole when no cursor or `limit` is given. `limit` alone is the newest page,
    /// `beforeSeq` the page before it. `trim`: blocks over 100 KB come light, and each picture
    /// they cut gets a `BlockRef` url (Trimmed).
    public func messages(_ id: String, afterSeq: Int64? = nil, beforeSeq: Int64? = nil, limit: Int? = nil, trim: Bool = false) async throws -> [Message] {
        let list: [Message] = try await get(["api", "sessions", id, "messages"], query: [
            ("afterSeq", afterSeq.map { "\($0)" }), ("beforeSeq", beforeSeq.map { "\($0)" }),
            ("limit", limit.map { "\($0)" }), ("trim", trim ? "1" : nil),
        ])
        return trim ? list.map(Trimmed.mark) : list
    }

    /// The base64 of the picture or document `ref` names, read from the hub's block route; nil when the block holds none.
    public func blockData(_ ref: BlockRef) async throws -> String? {
        let block: ContentBlock = try await get(["api", "sessions", ref.sessionId, "messages", ref.messageId, "blocks", String(ref.index)])
        switch block {
        case .image(let m), .document(let m): return m.data
        case .toolResult(let r):
            // a tool's picture: the hub's {data} or Anthropic's {source: {data}}
            guard let part = ref.part, let parts = r.content.array, parts.indices.contains(part) else { return nil }
            return (parts[part]["data"] ?? parts[part]["source"]?["data"])?.string
        default: return nil
        }
    }

    public func send(_ id: String, _ input: SendInput) async throws -> SendResult {
        try await send("POST", ["api", "sessions", id, "messages"], input)
    }

    public func abort(_ id: String) async throws { try await sendUnit("POST", ["api", "sessions", id, "abort"]) }

    /// Messages waiting while the session works, in the order they will run.
    public func queue(_ id: String) async throws -> [QueuedMessage] { try await get(["api", "sessions", id, "queue"]) }

    /// Take a waiting message off before it runs: 409 once its turn started, 404 when it is gone.
    public func unqueue(_ id: String, pendingId: String) async throws {
        try await sendUnit("DELETE", ["api", "sessions", id, "queue", pendingId])
    }

    /// "Try the next model" on a refused reply: the hub drops `messageId` and runs the turn again
    /// on the next model of the owner's list (409 when it is not the last reply).
    public func tryNextModel(_ id: String, messageId: String? = nil) async throws -> NextModelResult {
        let body: JSONObject = messageId.map { ["messageId": .string($0)] } ?? [:]
        return try await send("POST", ["api", "sessions", id, "next-model"], JSONValue.object(body))
    }

    public func approvals() async throws -> [ApprovalRequest] { try await get(["api", "approvals"]) }

    public func resolveApproval(_ id: String, _ response: ApprovalResponse) async throws {
        try await sendUnit("POST", ["api", "approvals", id], response)
    }

    public func questions() async throws -> [QuestionRequest] { try await get(["api", "questions"]) }

    public func answerQuestion(_ id: String, _ answers: [String: String]) async throws {
        try await sendUnit("POST", ["api", "questions", id], ["answers": answers] as [String: [String: String]])
    }

    public func models() async throws -> [ModelGroup] { try await get(["api", "models"]) }
}
