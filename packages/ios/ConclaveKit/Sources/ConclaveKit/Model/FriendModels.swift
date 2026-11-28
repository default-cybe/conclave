import Foundation

// Friends: two Conclave hubs with different owners that send each other signed, sealed messages
// (core client/friends.ts; Android model/Friends.kt). States stay strings.

public struct FriendGrants: Sendable, Hashable, Decodable {
    public var receiveShares = true
    private enum K: String, CodingKey { case receiveShares }
    public init() {}
    public init(from decoder: Decoder) throws {
        receiveShares = (try? decoder.container(keyedBy: K.self).or(.receiveShares, true)) ?? true
    }
}

public struct Friend: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name = ""
    public var fingerprint = ""
    /// pending, active, blocked (a key change waits for the owner) or removed
    public var status = "active"
    /// pending: "in" they asked, "out" we asked
    public var direction = "out"
    public var verified = false
    /// Four groups of five digits both owners see.
    public var safetyCode = ""
    public var grants = FriendGrants()
    public var lastSeen: Int64?
    public var lastError: String?
    public var blockedReason: String?
    public var queued = 0
    public var unread: Int?

    public var asked: Bool { status == "pending" && direction == "in" }

    public init(id: String, name: String = "", status: String = "active", direction: String = "out") {
        self.id = id
        self.name = name
        self.status = status
        self.direction = direction
    }

    private enum K: String, CodingKey { case id, name, fingerprint, status, direction, verified, safetyCode, grants, lastSeen, lastError, blockedReason, queued, unread }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, "")
        fingerprint = try c.or(.fingerprint, "")
        status = try c.or(.status, "active")
        direction = try c.or(.direction, "out")
        verified = try c.or(.verified, false)
        safetyCode = try c.or(.safetyCode, "")
        grants = (try? c.or(.grants, FriendGrants())) ?? FriendGrants()
        lastSeen = try? c.opt(.lastSeen)
        lastError = try? c.opt(.lastError)
        blockedReason = try? c.opt(.blockedReason)
        queued = try c.or(.queued, 0)
        unread = try? c.opt(.unread)
    }
}

/// A note or share that came from a friend (GET /api/friends/inbox).
public struct FriendInboxItem: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var friendId = ""
    public var type = ""
    public var text: String?
    public var receivedAt: Int64 = 0

    private enum K: String, CodingKey { case id, friendId, type, text, receivedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        friendId = try c.or(.friendId, "")
        type = try c.or(.type, "")
        text = try? c.opt(.text)
        receivedAt = try c.or(.receivedAt, 0)
    }
}

/// A note this hub sent or will send (GET /api/friends/outbox). state: queued, sending, delivered or failed.
public struct FriendOutboxItem: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var friendId = ""
    public var type = ""
    public var state = "queued"
    public var text: String?
    public var createdAt: Int64 = 0
    public var lastError: String?

    private enum K: String, CodingKey { case id, friendId, type, state, text, createdAt, lastError, payload }
    private struct Payload: Decodable { var text: String? }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        friendId = try c.or(.friendId, "")
        type = try c.or(.type, "")
        state = try c.or(.state, "queued")
        let own: String? = try? c.opt(.text)
        let payload: Payload? = try? c.opt(.payload)
        text = own ?? payload?.text
        createdAt = try c.or(.createdAt, 0)
        lastError = try? c.opt(.lastError)
    }
}

public struct FriendInvite: Sendable, Hashable, Decodable {
    /// conclave://friend?fp=...&url=...
    public var link = ""
    public var expiresAt: Int64 = 0
    /// Set when friends may not reach this hub.
    public var warning: String?

    private enum K: String, CodingKey { case link, expiresAt, warning }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        link = try c.or(.link, "")
        expiresAt = try c.or(.expiresAt, 0)
        warning = try? c.opt(.warning)
    }
}

public enum FriendWords {
    /// The state word and tone (ok, warn, fault, dim, live, neutral).
    public static func state(_ f: Friend) -> (String, String) {
        switch f.status {
        case "pending": return f.asked ? ("Asks to be friends", "warn") : ("Waiting for them", "dim")
        case "blocked": return ("Blocked", "fault")
        case "removed": return ("Removed", "dim")
        default:
            if f.lastError != nil { return ("Not reached", "warn") }
            return (f.verified ? "Verified" : "Not verified", f.verified ? "ok" : "neutral")
        }
    }

    /// Requests that need the owner first, then friends by name.
    public static func ordered(_ list: [Friend]) -> [Friend] {
        list.filter { $0.status != "removed" }.sorted { a, b in
            if a.asked != b.asked { return a.asked }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    /// A link a friend sent: the conclave://friend form only.
    public static func linkOK(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.hasPrefix("conclave://friend?") && t.contains("fp=")
    }
}

extension ConclaveClient {
    public func friends() async throws -> [Friend] { try await get(["api", "friends"]) }

    public func createFriendInvite() async throws -> FriendInvite {
        try await send("POST", ["api", "friends", "invites"], JSONValue.object([:]))
    }

    /// Use a friend's link: the hub checks their hub's key, then sends the request.
    public func acceptFriendInvite(_ link: String) async throws -> Friend {
        try await send("POST", ["api", "friends", "accept"], JSONValue.object(["link": .string(link.trimmingCharacters(in: .whitespacesAndNewlines))]))
    }

    public func acceptFriend(_ id: String) async throws -> Friend { try await call("POST", ["api", "friends", id, "accept"]) }

    public func declineFriend(_ id: String) async throws { try await sendUnit("POST", ["api", "friends", id, "decline"]) }

    public func verifyFriend(_ id: String, _ verified: Bool) async throws -> Friend {
        try await send("POST", ["api", "friends", id, "verify"], JSONValue.object(["verified": .bool(verified)]))
    }

    public func removeFriend(_ id: String) async throws { try await sendUnit("DELETE", ["api", "friends", id]) }

    public func sendFriendNote(_ id: String, text: String) async throws -> FriendOutboxItem {
        try await send("POST", ["api", "friends", id, "notes"], JSONValue.object(["text": .string(text)]))
    }

    public func friendInbox(_ id: String) async throws -> [FriendInboxItem] { try await get(["api", "friends", "inbox"], query: [("friend", id)]) }

    public func friendOutbox(_ id: String) async throws -> [FriendOutboxItem] { try await get(["api", "friends", "outbox"], query: [("friend", id)]) }
}
