import Foundation

/// The hub's pinned key and which addresses proved it lately. One per pairing, shared by every
/// client for that hub, since the address in use changes (Android HubIdentity.kt).
///
/// Before the first request or socket with the token to an address (not this device), `ensure`
/// has it sign a fresh nonce and checks the signature with the pinned key. A success holds for
/// `ttlMs` at that address; a reconnect checks again (`forget`). A stranger throws
/// `HubIdentityError` and nothing with the token goes there. No answer throws the URLError as it
/// is: the hub is offline, not a stranger.
///
/// A pairing from before identity has no pinned key. As the TypeScript client does, nothing
/// blocks it: the first proof is kept (`onPinned`), and a hub older than identity is left as it was.
public actor HubIdentityGuard {
    public static let defaultTTLMs: Int64 = 10 * 60_000

    public private(set) var pinnedKey: String?
    public let ttlMs: Int64
    private let onPinned: @Sendable (HubIdentity) async -> Void
    private let onMismatch: @Sendable (HubIdentityError) -> Void
    private let now: @Sendable () -> Int64
    private var checked: [String: Int64] = [:]
    // one check per address at a time: callers that come meanwhile wait for its answer
    private var running: [String: Task<Void, Error>] = [:]

    public init(
        pinnedKey: String? = nil, ttlMs: Int64 = defaultTTLMs,
        onPinned: @escaping @Sendable (HubIdentity) async -> Void = { _ in },
        onMismatch: @escaping @Sendable (HubIdentityError) -> Void = { _ in },
        now: @escaping @Sendable () -> Int64 = { nowMs() }
    ) {
        self.pinnedKey = pinnedKey
        self.ttlMs = ttlMs
        self.onPinned = onPinned
        self.onMismatch = onMismatch
        self.now = now
    }

    /// This device: nothing to check.
    public static func exempt(_ address: String) -> Bool {
        HubAddress.classifyHost(HubAddresses.host(address)) == .localhost
    }

    /// `address` proved the key less than `ttlMs` ago, or it is this device.
    public func isFresh(_ address: String) -> Bool {
        if Self.exempt(address) { return true }
        guard let at = checked[key(address)] else { return false }
        return now() - at < ttlMs
    }

    /// The next request or socket to `address` checks it again (after a reconnect).
    public func forget(_ address: String) { checked[key(address)] = nil }

    /// `address` just proved the key (pairing checked it): no second check right away.
    public func trust(_ address: String) { checked[key(address)] = now() }

    /// Proves the hub at `client`'s address holds the pinned key, unless it did lately.
    public func ensure(_ client: ConclaveClient) async throws {
        let address = client.baseURL
        if isFresh(address) { return }
        let k = key(address)
        if let task = running[k] { return try await task.value }
        let task = Task { try await self.check(client) }
        running[k] = task
        defer { running[k] = nil }
        try await task.value
    }

    private func check(_ client: ConclaveClient) async throws {
        guard let pinned = pinnedKey else {
            // trust on first use, best effort: a key to keep, or as before until the next check
            // no answer still throws: offline is not "older than identity"
            let first: HubIdentity?
            do {
                first = try await client.proveIdentity()
            } catch is HubIdentityError {
                first = nil
            } catch is ConclaveAPIError {
                first = nil
            }
            if let first, pinnedKey == nil {
                pinnedKey = first.publicKey
                await onPinned(first)
            }
            trust(client.baseURL)
            return
        }
        do {
            _ = try await client.proveIdentity(expectedKey: pinned)
        } catch let e as HubIdentityError {
            onMismatch(e)
            throw e
        }
        trust(client.baseURL)
    }

    private func key(_ address: String) -> String {
        (HubAddresses.normalize(address) ?? address.trimmingCharacters(in: .whitespaces)).lowercased()
    }
}
