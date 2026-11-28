import Foundation

// The hub's own settings (routes.ts GET and PATCH /api/config). PATCH merges and range-checks the
// app-edited values (core config/schema.ts CONFIG_NUMBERS and choices) and refuses one out of range.
extension ConclaveClient {
    /// The merged config (a member gets the parts they use).
    public func hubConfig() async throws -> JSONValue {
        let r: JSONValue = try await get(["api", "config"])
        return r["config"] ?? r
    }

    public func patchConfig(_ patch: JSONValue) async throws {
        try await sendUnit("PATCH", ["api", "config"], patch)
    }
}

public enum ConfigPath {
    /// The value at "limits.stuck.minutes" in a config.
    public static func value(_ config: JSONValue?, _ path: String) -> JSONValue? {
        path.split(separator: ".").reduce(config) { v, k in v?[String(k)] }
    }

    /// {"limits": {"stuck": {"minutes": value}}} for "limits.stuck.minutes": PATCH /api/config merges it.
    public static func patch(_ path: String, _ value: JSONValue) -> JSONValue {
        path.split(separator: ".").reversed().reduce(value) { acc, k in .object([String(k): acc]) }
    }

    /// A number box's text as the hub takes it: empty is 0 (no limit), else a finite number >= 0;
    /// whole unless `fraction`. Nil when it is not one.
    public static func number(_ text: String, fraction: Bool = false) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "")
        if t.isEmpty { return 0 }
        guard let n = Double(t), n.isFinite, n >= 0, fraction || n == n.rounded() else { return nil }
        return n
    }
}
