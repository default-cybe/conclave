import Foundation

// Devices, pairing codes, a session's files and subagents, and the person's own defaults.
extension ConclaveClient {
    /// The hub's own row (`local`) first, then the paired computers.
    public func devices() async throws -> [Device] { try await get(["api", "devices"]) }

    /// A pairing code of `kind`, 10 minutes long (packages/server routes.ts POST /api/pairing).
    public func makePairingCode(_ kind: PairKind) async throws -> PairingInfo {
        try await send("POST", ["api", "pairing"], ["kind": kind.rawValue])
    }

    /// Every file of a session, newest first.
    public func files(_ sessionId: String) async throws -> [SessionFile] { try await get(["api", "sessions", sessionId, "files"]) }

    /// The bytes of a tool's file: a shared file, or picture `image` (0 to 3) of a generated set.
    public func fileData(_ sessionId: String, toolUseId: String, image: Int? = nil) async throws -> Data {
        try await request("GET", ["api", "sessions", sessionId, "files", toolUseId], query: [("image", image.map(String.init)), ("inline", "1")]).0
    }

    /// The sessions a session started (subagents, delegated jobs), newest first as the hub lists them.
    public func children(_ sessionId: String) async throws -> [Session] { try await listSessions(parentId: sessionId) }

    public func me() async throws -> Me { try await get(["api", "me"]) }

    /// Sets the person's own default model; nil clears it (the hub's default applies again).
    /// The hub answers { ok: true }: read `me()` again for the saved state.
    public func setDefaultModel(_ ref: String?) async throws {
        try await sendUnit("PATCH", ["api", "me"], JSONValue.object(["defaultModel": ref.map { .string($0) } ?? .null]))
    }
}
