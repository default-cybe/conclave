import Foundation

// Memory and usage (packages/server routes.ts; Android ConclaveClient.kt memory and usage).
extension ConclaveClient {
    /// The person's memories, newest first; `kind` narrows to one kind.
    public func memories(kind: MemoryKind? = nil, limit: Int? = 200) async throws -> [MemoryEntry] {
        try await get(["api", "memory"], query: [("kind", kind?.rawValue), ("limit", limit.map(String.init))])
    }

    /// Search hits, best first. The hub answers [] for a blank query.
    public func searchMemory(_ query: String, limit: Int = 50) async throws -> [MemoryEntry] {
        try await get(["api", "memory", "search"], query: [("q", query), ("limit", String(limit))])
    }

    public func saveMemory(_ input: MemoryInput) async throws -> MemoryEntry {
        try await send("POST", ["api", "memory"], input)
    }

    public func updateMemory(_ id: String, _ patch: MemoryInput) async throws -> MemoryEntry {
        try await send("PATCH", ["api", "memory", id], patch)
    }

    public func deleteMemory(_ id: String) async throws { try await sendUnit("DELETE", ["api", "memory", id]) }

    /// Usage between `from` and `to` (ms); `tzOffset` in minutes, the sign of JavaScript's getTimezoneOffset.
    public func usage(from: Int64? = nil, to: Int64? = nil, tzOffset: Int? = nil) async throws -> UsageSummary {
        try await get(["api", "usage"], query: [("from", from.map { String($0) }), ("to", to.map { String($0) }), ("tzOffset", tzOffset.map(String.init))])
    }

    /// The stored plan and key limits.
    public func limits() async throws -> [LimitState] { try await get(["api", "limits"]) }

    /// The hub reads every plan's usage again (up to 8 s; admin only, a member gets 403).
    public func refreshLimits() async throws -> [LimitState] { try await call("POST", ["api", "limits", "refresh"]) }
}
