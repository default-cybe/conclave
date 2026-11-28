import Foundation

/// One named secret as Settings > Secrets lists it (core config/secret-names.ts): never its value.
public struct SecretInfo: Sendable, Hashable, Decodable, Identifiable {
    public var id: String { name }
    public var name: String
    /// The first 4 characters; none for a short value or one the hub manages.
    public var prefix: String?
    public var setAt: Int64?
    /// Where the hub sets it, for a name another page manages.
    public var managedBy: String?

    public init(name: String, prefix: String? = nil, setAt: Int64? = nil, managedBy: String? = nil) {
        self.name = name
        self.prefix = prefix
        self.setAt = setAt
        self.managedBy = managedBy
    }
}

public enum SecretWords {
    /// Why a name typed in Add cannot be saved, or nil (web secretNameError; core SECRET_NAME).
    public static func nameError(_ name: String, taken: [String]) -> String? {
        if name.isEmpty { return nil }
        let ok = name.count <= 64 && name.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || $0 == "." || $0 == "-" || $0 == "_" }
        if !ok || name == "__proto__" || name == "constructor" { return "Use 1 to 64 lowercase letters, digits, dots, dashes and underscores." }
        if taken.contains(name) { return "\(name) exists. Use Replace on its row." }
        return nil
    }

    /// "ghp_…, set 3d ago" (web Meta).
    public static func meta(_ s: SecretInfo, now: Int64) -> String {
        [s.prefix.map { $0 + "…" }, s.setAt.map { at in let a = Ago.short(at, now: now); return a == "now" ? "set just now" : "set \(a) ago" }]
            .compactMap { $0 }.joined(separator: ", ")
    }
}

private struct SecretList: Decodable { var values: [SecretInfo] = [] }

// The owner's are the hub's (GET/PUT /api/secrets kind values); a member's are their own (/api/me/secrets).
extension ConclaveClient {
    public func secrets(member: Bool) async throws -> [SecretInfo] {
        let r: SecretList = try await get(member ? ["api", "me", "secrets"] : ["api", "secrets"])
        return r.values
    }

    /// Save a named secret, or delete it with nil.
    public func setSecret(_ name: String, _ value: String?, member: Bool) async throws {
        let v = value.map(JSONValue.string) ?? .null
        if member {
            try await sendUnit("PUT", ["api", "me", "secrets"], JSONValue.object(["key": .string(name), "value": v]))
        } else {
            try await sendUnit("PUT", ["api", "secrets"], JSONValue.object(["kind": .string("values"), "key": .string(name), "value": v]))
        }
    }
}
