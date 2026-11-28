import Foundation

/// GET /api/clients (core client AppDto): an app signed in with a pairing code or a password.
/// Phones are apps, not devices; they talk to the hub and run no work.
public struct SignedInApp: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var platform: String?
    public var createdAt: Int64
    public var lastSeenAt: Int64?
    public var revoked: Bool
    public var online: Bool

    public init(id: String, name: String = "", platform: String? = nil, createdAt: Int64 = 0, lastSeenAt: Int64? = nil, revoked: Bool = false, online: Bool = false) {
        self.id = id
        self.name = name
        self.platform = platform
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.revoked = revoked
        self.online = online
    }

    private enum K: String, CodingKey { case id, name, platform, createdAt, lastSeenAt, revoked, online }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, "")
        platform = try c.opt(.platform)
        createdAt = try c.or(.createdAt, 0)
        lastSeenAt = try c.opt(.lastSeenAt)
        revoked = try c.or(.revoked, false)
        online = try c.or(.online, false)
    }

    /// What kind of app, in plain words (web lib/apps.ts appKind).
    public var kind: String {
        switch platform ?? "" {
        case "android": "Android"
        // the iPad app reports "ios" too
        case "ios": "iPhone or iPad"
        case "web": "Browser"
        case "desktop": "Desktop app"
        case "linux": "Terminal on Linux"
        case "darwin": "Terminal on macOS"
        case "win32": "Terminal on Windows"
        case "freebsd": "Terminal on FreeBSD"
        default: "App"
        }
    }

    /// "Android, online", "Browser, last seen 3h ago" (web signedin.tsx appLine).
    public func line(now: Int64) -> String {
        let seen = online ? "online" : lastSeenAt.map { at in
            let a = Ago.short(at, now: now)
            return a == "now" ? "last seen just now" : "last seen \(a) ago"
        } ?? "not seen yet"
        return "\(kind), \(seen)"
    }
}

extension ConclaveClient {
    public func signedInApps() async throws -> [SignedInApp] { try await get(["api", "clients"]) }
}
