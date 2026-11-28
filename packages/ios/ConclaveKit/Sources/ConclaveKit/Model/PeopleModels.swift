import Foundation

// People on the hub (core client/people.ts; web settings/people.tsx). Owner only.

public struct PersonSpend: Sendable, Hashable, Decodable {
    public var provider: String
    public var name: String
    public var monthlyUsd: Double?
    public var spentUsd: Double

    private enum K: String, CodingKey { case provider, name, monthlyUsd, spentUsd }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        provider = try c.or(.provider, "")
        name = try c.or(.name, provider)
        monthlyUsd = try? c.opt(.monthlyUsd)
        spentUsd = try c.or(.spentUsd, 0)
    }
}

/// GET /api/people: one person (the owner, or a member).
public struct Person: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    /// The sign-in name.
    public var name: String
    public var displayName: String?
    /// owner or member
    public var role: String
    public var disabled: Bool
    public var email: String?
    public var passwordSet: Bool
    /// An invite link waits until this time.
    public var inviteExpiresAt: Int64?
    public var createdAt: Int64
    public var devices: Int
    public var apps: Int
    /// Hub keys this person may use: provider id to its monthly cap (nil: no cap).
    public var providers: [String: Double?]
    public var spend: [PersonSpend]
    public var ownPlans: Int?
    public var webSearch: Bool

    public init(id: String, name: String, role: String = "member") {
        self.id = id
        self.name = name
        self.role = role
        disabled = false
        passwordSet = false
        createdAt = 0
        devices = 0
        apps = 0
        providers = [:]
        spend = []
        webSearch = false
    }

    private struct Grant: Decodable { var monthlyUsd: Double? }
    private enum K: String, CodingKey { case id, name, displayName, role, disabled, email, passwordSet, inviteExpiresAt, createdAt, devices, apps, providers, spend, ownPlans, webSearch }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, id)
        displayName = try? c.opt(.displayName)
        role = try c.or(.role, "member")
        disabled = try c.or(.disabled, false)
        email = try? c.opt(.email)
        passwordSet = try c.or(.passwordSet, false)
        inviteExpiresAt = try? c.opt(.inviteExpiresAt)
        createdAt = try c.or(.createdAt, 0)
        devices = try c.or(.devices, 0)
        apps = try c.or(.apps, 0)
        let g = (try? c.or(.providers, [String: Grant]())) ?? [:]
        providers = g.mapValues { $0.monthlyUsd }
        spend = (try? c.or(.spend, [PersonSpend]())) ?? []
        ownPlans = try? c.opt(.ownPlans)
        webSearch = try c.or(.webSearch, false)
    }

    public var shownName: String { displayName.flatMap { $0.isEmpty ? nil : $0 } ?? name }
    public var isOwner: Bool { role == "owner" }
}

/// An invite link: shown once, good once, for 7 days.
public struct Invite: Sendable, Hashable, Decodable {
    public var url: String
    public var expiresAt: Int64
}

public struct PersonCreated: Sendable, Hashable, Decodable {
    public var person: Person
    public var invite: Invite?
}

/// A device code for a person's workspace on the hub machine, with the commands filled in.
public struct WorkspaceCode: Sendable, Hashable, Decodable {
    public struct Commands: Sendable, Hashable, Decodable { public var linux: [String] = []; public var docker: [String] = [] }
    public var code: String
    public var expiresAt: Int64
    public var commands: Commands
}

public enum PeopleWords {
    /// "Invite waits, 6 days left", "Password set", "No password yet" (web people.tsx status words).
    public static func signIn(_ p: Person, now: Int64) -> String {
        if p.disabled { return "Turned off" }
        if let at = p.inviteExpiresAt, at > now, !p.passwordSet {
            // Ago.short words a span back from now; the time left is the same span
            let left = Ago.short(now - (at - now), now: now)
            return left == "now" ? "Invite waits, ends soon" : "Invite waits, \(left) left"
        }
        return p.passwordSet ? "Password set" : "No password yet"
    }

    /// "$3.20 of $10.00 this month on Anthropic" for each hub key with spend or a cap.
    public static func spend(_ p: Person) -> [String] {
        p.spend.map { s in
            let spent = String(format: "$%.2f", s.spentUsd)
            return (s.monthlyUsd.map { "\(spent) of " + String(format: "$%.2f", $0) } ?? "\(spent), no cap") + " this month on \(s.name)"
        }
    }

    /// A password the hub takes: 12 characters or more.
    public static func passwordOK(_ s: String) -> Bool { s.count >= 12 }

    /// The sign-in name: one word, lowercase letters, digits, dots, dashes, underscores.
    public static func nameOK(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 32 && s.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || "._-".contains($0) }
    }
}

extension ConclaveClient {
    public func people() async throws -> [Person] { try await get(["api", "people"]) }

    /// Add a member with a password now, or with an invite link (no password).
    public func addPerson(name: String, displayName: String?, email: String?, password: String?) async throws -> PersonCreated {
        var b: JSONObject = ["name": .string(name)]
        if let displayName, !displayName.isEmpty { b["displayName"] = .string(displayName) }
        if let email, !email.isEmpty { b["email"] = .string(email) }
        if let password, !password.isEmpty { b["password"] = .string(password) } else { b["invite"] = .bool(true) }
        return try await send("POST", ["api", "people"], JSONValue.object(b))
    }

    /// PATCH: displayName, email, providers ({id: {monthlyUsd}}), webSearch.
    public func updatePerson(_ id: String, _ patch: JSONObject) async throws -> Person {
        try await send("PATCH", ["api", "people", id], JSONValue.object(patch))
    }

    public func removePerson(_ id: String) async throws { try await sendUnit("DELETE", ["api", "people", id]) }

    public func setPersonDisabled(_ id: String, _ disabled: Bool) async throws -> Person {
        try await call("POST", ["api", "people", id, disabled ? "disable" : "enable"])
    }

    public func resetPersonPassword(_ id: String, _ password: String) async throws -> Person {
        try await send("POST", ["api", "people", id, "password"], JSONValue.object(["password": .string(password)]))
    }

    public func newInvite(_ id: String) async throws -> Invite { try await call("POST", ["api", "people", id, "invite"]) }

    public func workspaceCode(_ id: String) async throws -> WorkspaceCode { try await call("POST", ["api", "people", id, "workspace"]) }
}
