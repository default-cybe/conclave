import Foundation

/// Where a hub URL points, for the plain-http warning on the connect screen. VPN is a private VPN
/// range (100.64.0.0/10, *.ts.net): plain http there is no worse than on a home network.
public enum NetworkKind: Sendable, Hashable {
    case localhost, vpn, lan, `public`
}

/// A hub URL, normalized and classified (Android logic/HubAddress.kt).
public struct HubAddress: Sendable, Hashable {
    public var url: String
    public var scheme: String
    public var host: String
    public var kind: NetworkKind

    public var isHTTPS: Bool { scheme == "https" }
    /// Plain http to a public address: traffic and token travel unencrypted.
    public var needsWarning: Bool { !isHTTPS && kind == .public }
    public var isPrivate: Bool { kind != .public }

    /// Adds http:// for a bare private host and https:// otherwise. Nil when it cannot be parsed.
    public static func parse(_ raw: String) -> HubAddress? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard !s.isEmpty else { return nil }
        if !s.contains("://") {
            let guess = s.before("/").before(":")
            s = (classifyHost(guess) == .public ? "https://" : "http://") + s
        }
        guard let c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = c.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased(), !host.isEmpty else { return nil }
        return HubAddress(url: s, scheme: scheme, host: host, kind: classifyHost(host))
    }

    public static func classifyHost(_ raw: String) -> NetworkKind {
        var host = raw.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        if host == "localhost" || host.hasSuffix(".localhost") { return .localhost }
        if host.hasSuffix(".ts.net") { return .vpn }
        if [".local", ".lan", ".home.arpa", ".internal"].contains(where: host.hasSuffix) { return .lan }
        if let o = ipv4(host) {
            switch (o[0], o[1]) {
            case (127, _): return .localhost
            case (100, 64...127): return .vpn // CGNAT, VPNs such as Tailscale
            case (10, _), (172, 16...31), (192, 168), (169, 254): return .lan
            default: return .public
            }
        }
        if host.contains(":") {
            if host == "::1" { return .localhost }
            if host.hasPrefix("fd7a:115c:a1e0:") { return .vpn }
            if host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe80:") { return .lan }
            return .public
        }
        // a single-label name ("nas") only resolves on a local network
        return host.contains(".") ? .public : .lan
    }

    static func ipv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let out = parts.compactMap { Int($0) }.filter { (0...255).contains($0) }
        return out.count == 4 ? out : nil
    }
}

/// A hub's list of addresses (Android logic/Remote.kt HubAddresses).
public enum HubAddresses {
    /// "https://x.example/" to "https://x.example". Nil for anything that is not http or https with
    /// a host, or that carries a query, a fragment or a login.
    public static func normalize(_ raw: String?) -> String? {
        guard var s = raw?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        while s.hasSuffix("/") { s.removeLast() }
        guard !s.isEmpty, let c = URLComponents(string: s), let scheme = c.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = c.host, !host.isEmpty,
              c.query == nil, c.fragment == nil, c.user == nil, c.password == nil else { return nil }
        return s
    }

    public static func host(_ url: String?) -> String {
        guard let url, let h = URLComponents(string: url.trimmingCharacters(in: .whitespaces))?.host else { return "" }
        return h.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
    }

    /// Valid addresses in order, each once.
    public static func dedupe(_ urls: [String]) -> [String] {
        var out: [String] = []
        for u in urls {
            guard let n = normalize(u), !out.contains(where: { $0.caseInsensitiveCompare(n) == .orderedSame }) else { continue }
            out.append(n)
        }
        return out
    }

    /// What to save at pairing: the hub's own list (best first). From an older hub that sends none,
    /// only the address the code worked on: a QR code's alts are not the hub's word, and the token
    /// must never go to an address only a code named.
    public static func atPairing(used: String, reply: [String]) -> [String] {
        let fromHub = dedupe(reply)
        return fromHub.isEmpty ? dedupe([used]) : fromHub
    }

    /// Pairing: `attempt` at each of `urls` in order (the code's best address, then its alts),
    /// moving on only when an address does not answer. The hub's own answer (a wrong or used code)
    /// and another machine at the address stop at once. Throws the last failure.
    public static func firstAnswer<T>(_ urls: [String], _ attempt: (String) async throws -> T) async throws -> (url: String, result: T) {
        var failure: Error?
        for url in urls {
            do {
                return (url, try await attempt(url))
            } catch let e where e is ConclaveAPIError || e is HubIdentityError || e is PasswordOverHTTPError {
                throw e
            } catch {
                failure = error
            }
        }
        throw failure ?? URLError(.cannotConnectToHost)
    }
}

/// Where a password may go: https, or plain http to this device or a private address
/// (HUB-LOGIN-AND-IDENTITY.md section 1).
public enum PasswordRule {
    public static let refused = "Use the https address of your hub to log in with a password."

    public static func allowed(_ url: String) -> Bool {
        let s = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = s.range(of: "://") else { return false }
        switch s[..<r.lowerBound].lowercased() {
        case "https": return true
        case "http": return isPrivateAddress(s)
        default: return false
        }
    }

    /// This machine or a private network. Takes a URL or a bare host.
    public static func isPrivateAddress(_ urlOrHost: String) -> Bool {
        let s = urlOrHost.trimmingCharacters(in: .whitespaces)
        return privateHost(HubAddresses.host(s.contains("://") ? s : "http://\(s)"))
    }

    public static func privateHost(_ raw: String) -> Bool {
        var host = raw.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return false }
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") || host.hasSuffix(".ts.net") { return true }
        if let o = HubAddress.ipv4(host) {
            switch (o[0], o[1]) {
            case (127, _), (10, _), (172, 16...31), (192, 168), (100, 64...127): return true
            default: return false
            }
        }
        if host.contains(":") {
            if host == "::1" { return true }
            // fd00::/8: the first group is fdXX
            let first = host.before(":")
            return first.count == 4 && first.hasPrefix("fd") && first.allSatisfy(\.isHexDigit)
        }
        return false
    }
}

/// The password goes nowhere but https or a private address.
public struct PasswordOverHTTPError: Error, LocalizedError, Sendable {
    public var errorDescription: String? { PasswordRule.refused }
}
