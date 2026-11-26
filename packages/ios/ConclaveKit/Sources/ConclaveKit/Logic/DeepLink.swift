import Foundation

/// App links (Android logic/HubAddress.kt DeepLink). Phase 1 reads the ones the connect screen and
/// notices need; friend, share, map, memory and meeting links come with their pages.
public enum DeepLink: Sendable, Hashable {
    /// conclave://pair?url=...&code=...&fp=...&alt=...: `url` is the hub's best address, each alt
    /// another one. `fp` is the hub's fingerprint: an address proves it before the code goes there.
    case pair(url: String, code: String, alts: [String] = [], fp: String? = nil)
    /// conclave://session/<id> or a hub path /s/<id>.
    case session(String)
    /// conclave://chat/<id> or a hub path /chat/<id>.
    case chat(String)
    /// conclave://new or conclave://chat.
    case newChat
    case approvals

    public static func parse(_ raw: String?) -> DeepLink? {
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        // hub notice links are app paths
        if s.hasPrefix("/") { return fromPath(s) }
        guard let c = URLComponents(string: s), let scheme = c.scheme?.lowercased() else { return nil }
        if scheme == "http" || scheme == "https" { return fromPath(c.percentEncodedPath) }
        guard scheme == "conclave" else { return nil }
        let first = c.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).before("/")
        let id = first.isEmpty ? nil : first
        switch (c.host ?? "").lowercased() {
        case "pair":
            let q = c.queryItems ?? []
            func all(_ k: String) -> [String] { q.filter { $0.name == k }.compactMap { $0.value?.trimmingCharacters(in: .whitespaces) } }
            guard let url = all("url").first(where: { !$0.isEmpty }), let code = all("code").first(where: { !$0.isEmpty }) else { return nil }
            var alts: [String] = []
            for a in all("alt") where !a.isEmpty && a != url && !alts.contains(a) { alts.append(a) }
            return .pair(url: url, code: code, alts: alts, fp: all("fp").first { !$0.isEmpty }?.lowercased())
        case "session", "s": return id.map { .session($0) }
        case "chat": return id.map { .chat($0) } ?? .newChat
        case "new": return .newChat
        case "approvals": return .approvals
        default: return nil
        }
    }

    private static func fromPath(_ raw: String) -> DeepLink? {
        // a reminder's link carries ?open=1: the path alone names the page
        let parts = raw.before("?").before("#").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .split(separator: "/", omittingEmptySubsequences: false).map { $0.removingPercentEncoding ?? String($0) }
        guard parts.count >= 2, !parts[1].isEmpty else { return nil }
        switch parts[0] {
        case "s", "sessions", "session": return .session(parts[1])
        case "chat": return .chat(parts[1])
        default: return nil
        }
    }
}
