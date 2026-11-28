#if DEBUG
import Foundation

/// Memory and Usage fixtures for `-mockHub`: notes, two plans with resets ahead of now, a month of spend.
extension MockHub {
    /// Status and JSON for the memory, usage and limits routes; nil for every other route.
    static func memoryReply(_ method: String, _ url: URL, _ body: Data?) -> (Int, String)? {
        let path = url.path
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let q = { (name: String) in query.first { $0.name == name }?.value }
        let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let notes = memoryNotes()
        switch (method, path) {
        case ("GET", "/api/memory"):
            return (200, memoryJSON(notes.filter { n in q("kind").map { n["kind"] as? String == $0 } ?? true }))
        case ("GET", "/api/memory/search"):
            let words = (q("q") ?? "").lowercased()
            return (200, memoryJSON(words.isEmpty ? [] : notes.filter { ($0["content"] as? String ?? "").lowercased().contains(words) }))
        case ("POST", "/api/memory"):
            var n: [String: Any] = ["id": "mem-\(UUID().uuidString.prefix(6))", "scope": "global", "kind": "fact", "tags": [String](), "createdAt": memoryNow, "updatedAt": memoryNow, "useCount": 0]
            for (k, v) in input { n[k] = v }
            return (200, memoryJSON(n))
        case ("GET", "/api/usage"): return (200, memoryUsage)
        case ("GET", "/api/limits"), ("POST", "/api/limits/refresh"): return (200, memoryLimits)
        default: break
        }
        let p = path.split(separator: "/").map(String.init)
        guard p.count == 3, p[0] == "api", p[1] == "memory" else { return nil }
        guard var n = notes.first(where: { $0["id"] as? String == p[2] }) else { return (404, #"{"error":"unknown memory"}"#) }
        if method == "DELETE" { return (200, #"{"ok":true}"#) }
        if method == "PATCH" {
            for (k, v) in input { n[k] = v }
            n["updatedAt"] = memoryNow
        }
        return (200, memoryJSON(n))
    }

    private static var memoryNow: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private static func memoryAgo(_ h: Double) -> Int64 { memoryNow - Int64(h * 3_600_000) }
    private static func memoryAhead(_ min: Double) -> Int64 { memoryNow + Int64(min * 60_000) }

    private static func memoryJSON(_ v: Any) -> String {
        String(decoding: (try? JSONSerialization.data(withJSONObject: v)) ?? Data("null".utf8), as: UTF8.self)
    }

    private static func memoryNotes() -> [[String: Any]] {
        func note(_ id: String, _ kind: String, _ content: String, _ tags: [String], _ h: Double, _ used: Int, scope: String = "global", key: String? = nil) -> [String: Any] {
            var n: [String: Any] = ["id": id, "scope": scope, "kind": kind, "content": content, "tags": tags, "importance": 0.6,
                                    "createdAt": memoryAgo(h + 200), "updatedAt": memoryAgo(h), "useCount": used]
            if let key { n["scopeKey"] = key }
            return n
        }
        return [
            note("mem1", "profile", "The owner prefers pnpm", ["tools"], 2, 14),
            note("mem2", "fact", "Hub runs on Proxmox CT conclave", ["homelab", "proxmox"], 5, 9),
            note("mem3", "profile", "The owner prefers short answers that include the technical details and the best evidence.", ["style"], 26, 31),
            note("mem4", "procedure", "Deploys run with make release on the server, then the hub reloads by itself.", ["deploy"], 50, 3, scope: "project", key: "conclave"),
            note("mem5", "fact", "The owner's daily reminders are in the America/Los_Angeles timezone.", ["reminders"], 72, 6),
            note("mem6", "episode", "Moved auth middleware to jose on 2026-11-20; the old token check was removed.", ["auth"], 190, 1, scope: "project", key: "conclave"),
        ]
    }

    // Claude Max 5-hour at 42% and weekly at 71%, ChatGPT Pro well under; both read a few minutes ago
    private static var memoryLimits: String {
        """
        [{"provider":"anthropic","label":"Claude Max 20x","source":"oauth","updatedAt":\(memoryAgo(0.05)),"windows":[
           {"name":"5h","usedPercent":42,"resetsAt":\(memoryAhead(130))},
           {"name":"7d","usedPercent":71,"resetsAt":\(memoryAhead(3 * 1440 + 260))}]},
         {"provider":"openai","label":"ChatGPT Pro","source":"oauth","updatedAt":\(memoryAgo(0.1)),"windows":[
           {"name":"5h","usedPercent":18,"resetsAt":\(memoryAhead(212))},
           {"name":"7d","usedPercent":9,"resetsAt":\(memoryAhead(5 * 1440 + 90))}]}]
        """
    }

    private static var memoryUsage: String {
        let day: TimeInterval = 86_400
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        let days = (0..<30).map { i -> [String: Any] in
            let cost = [0.0, 0.42, 0.18, 1.2, 0.0, 0.66, 0.31][i % 7]
            let worth = 9.0 + Double((i * 37) % 23)
            return ["key": f.string(from: Date().addingTimeInterval(-Double(29 - i) * day)), "costUsd": cost, "apiValueUsd": worth + cost,
                    "calls": 30 + (i * 13) % 40, "inputTokens": 900_000 + i * 41_000, "outputTokens": 60_000 + i * 2_300]
        }
        let summary: [String: Any] = [
            "from": memoryAgo(720), "to": memoryNow,
            "totals": ["key": "total", "costUsd": 12.4, "apiValueUsd": 486.2, "calls": 1240, "inputTokens": 38_400_000, "outputTokens": 2_150_000],
            "byDay": days,
            "byModel": [
                ["key": "anthropic/claude-opus-5-5", "costUsd": 0, "apiValueUsd": 352.8, "calls": 610, "inputTokens": 24_100_000, "outputTokens": 1_320_000],
                ["key": "openai/gpt-5.5", "costUsd": 0, "apiValueUsd": 121.0, "calls": 402, "inputTokens": 11_800_000, "outputTokens": 690_000],
                ["key": "zai/glm-5", "costUsd": 12.4, "apiValueUsd": 12.4, "calls": 228, "inputTokens": 2_500_000, "outputTokens": 140_000],
            ],
            "byAccount": [
                ["key": "claude-max", "costUsd": 0, "apiValueUsd": 352.8, "calls": 610],
                ["key": "chatgpt-pro", "costUsd": 0, "apiValueUsd": 121.0, "calls": 402],
                ["key": "zai-key", "costUsd": 12.4, "apiValueUsd": 12.4, "calls": 228],
            ],
            "cacheHitRate": 0.82, "cacheSavingsUsd": 96.4,
        ]
        return memoryJSON(summary)
    }
}
#endif
