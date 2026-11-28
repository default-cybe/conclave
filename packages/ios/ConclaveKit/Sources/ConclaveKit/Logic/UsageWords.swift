import Foundation

/// The Usage page's ranges (Android UsageRange).
public enum UsageRange: Int, Sendable, CaseIterable, Hashable {
    case week = 7, month = 30, quarter = 90

    public var days: Int { rawValue }
    public var label: String { "\(rawValue) days" }
}

/// Numbers and words of the Usage page (Android logic/Format.kt, logic/Home.kt percent, web Meter.tsx windowLabel).
public enum UsageWords {
    /// "4h 12m", "2m 05s", "45s", "2d 3h"; zero or less is "now".
    public static func countdown(_ ms: Int64) -> String {
        if ms <= 0 { return "now" }
        let total = (ms + 999) / 1000
        let d = total / 86_400, h = total % 86_400 / 3600, m = total % 3600 / 60, s = total % 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m " + (s < 10 ? "0\(s)" : "\(s)") + "s" }
        return "\(s)s"
    }

    /// 950, "1.2k", "45k", "3.4M", "1.2B".
    public static func tokens(_ n: Int64) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", Double(n) / 1e9) }
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1e6) }
        if n >= 10_000 { return "\(Int64((Double(n) / 1000).rounded()))k" }
        if n >= 1000 { return String(format: "%.1fk", Double(n) / 1e3) }
        return "\(n)"
    }

    /// "$0", "$0.0040", "$1.50", "$1,234".
    public static func usd(_ v: Double) -> String {
        if v == 0 { return "$0" }
        if abs(v) < 0.01 { return String(format: "$%.4f", v) }
        if abs(v) < 100 { return String(format: "$%.2f", v) }
        let digits = String(Int64(abs(v).rounded()))
        var out = ""
        for (i, ch) in digits.enumerated() {
            if i > 0 && (digits.count - i) % 3 == 0 { out.append(",") }
            out.append(ch)
        }
        return (v < 0 ? "-$" : "$") + out
    }

    /// 0.82 is "82%".
    public static func percent(_ fraction: Double) -> String { String(format: "%.0f%%", fraction * 100) }

    /// Used percent of a window, 0 to 100, or nil when unknown; blocked counts as full.
    public static func used(_ w: LimitWindow, blocked: Bool = false) -> Int? {
        if blocked { return 100 }
        var pct = w.usedPercent
        if pct == nil, let lim = w.limit, lim > 0, let rem = w.remaining { pct = (1 - rem / lim) * 100 }
        guard let pct else { return nil }
        return min(100, max(0, Int(pct.rounded())))
    }

    public enum Level: Sendable { case normal, warn, fault }

    /// Neutral under 70%, warn from 70%, fault from 90% (Android Gauge).
    public static func level(_ pct: Int?) -> Level {
        guard let pct else { return .normal }
        return pct >= 90 ? .fault : pct >= 70 ? .warn : .normal
    }

    /// A credit balance, not a window: "40 balance".
    public static func balance(_ w: LimitWindow) -> String? {
        guard used(w) == nil, w.limit == nil, let r = w.remaining else { return nil }
        return "\(r == r.rounded() ? String(Int64(r)) : String(format: "%.2f", r)) balance"
    }

    /// "5h" is "5 hours", "7d" "Week", "7d opus" "Week, Opus", "requests / min" "Requests per minute".
    public static func windowLabel(_ name: String) -> String {
        let n = name.trimmingCharacters(in: .whitespaces).lowercased()
        guard !n.isEmpty else { return "" }
        let parts = n.split(whereSeparator: \.isWhitespace).map(String.init)
        let map = ["5h": "5 hours", "1h": "Hour", "24h": "Day", "1d": "Day", "daily": "Day", "7d": "Week", "weekly": "Week", "week": "Week", "monthly": "Month", "30d": "Month"]
        if let base = map[parts[0]] {
            var rest = parts.dropFirst().joined(separator: " ")
            if let r = rest.range(of: #"\b(prompts?|block)\b"#, options: .regularExpression) { rest.removeSubrange(r) }
            rest = rest.trimmingCharacters(in: .whitespaces)
            return rest.isEmpty ? base : "\(base), \(rest.prefix(1).uppercased())\(rest.dropFirst())"
        }
        var s = n
        for (pattern, words) in [(#"\s*/\s*min(ute)?\b"#, " per minute"), (#"\s*/\s*day\b"#, " per day"), (#"\s*/\s*h(our)?\b"#, " per hour")] {
            if let r = s.range(of: pattern, options: .regularExpression) { s.replaceSubrange(r, with: words) }
        }
        return s.prefix(1).uppercased() + s.dropFirst()
    }

    /// "resets in 2h 10m", "reset" once past, nil without a time.
    public static func reset(_ w: LimitWindow, now: Int64) -> String? {
        guard let at = w.resetsAt else { return nil }
        return at > now ? "resets in \(countdown(at - now))" : "reset"
    }

    /// The plan's name; the account added when the hub's label does not name it.
    public static func planName(_ l: LimitState) -> String {
        guard let a = l.account, !a.trimmingCharacters(in: .whitespaces).isEmpty, !l.label.contains(a) else { return l.label.isEmpty ? l.provider : l.label }
        return l.label.isEmpty ? a : "\(l.label) · \(a)"
    }

    /// "read from OAuth, updated 5m ago", "blocked, updated just now", "not read".
    public static func source(_ l: LimitState, now: Int64) -> (text: String, fault: Bool) {
        let a = l.updatedAt > 0 ? Ago.short(l.updatedAt, now: now) : ""
        let age = a.isEmpty ? "" : a == "now" ? ", updated just now" : ", updated \(a) ago"
        if l.blocked == true { return ("blocked\(age)", true) }
        if l.source == "error" { return ("not read", true) }
        let name = ["oauth": "OAuth", "api": "the API", "ledger": "the ledger"][l.source] ?? l.source
        return ("read from \(name)\(age)", false)
    }

    /// Limits in the order Android lists them: by label, else key.
    public static func sorted(_ limits: [LimitState]) -> [LimitState] {
        limits.sorted { ($0.label.isEmpty ? $0.key : $0.label).localizedCaseInsensitiveCompare($1.label.isEmpty ? $1.key : $1.label) == .orderedAscending }
    }

    /// The Totals tiles (Android KpiGrid): a plan's bill beside its worth at API prices.
    public static func tiles(_ s: UsageSummary) -> [(label: String, value: String)] {
        let t = s.totals
        let plans = ApiValue.planServed(t)
        var out: [(label: String, value: String)] = [(plans ? "Billed" : "Cost", usd(t.costUsd))]
        if plans { out.append(("At API prices", usd(ApiValue.worth(t.costUsd, t.apiValueUsd)))) }
        out += [("Calls", "\(t.calls)"), ("Input tokens", tokens(t.inputTokens)), ("Output tokens", tokens(t.outputTokens)),
                ("Cache hit rate", percent(s.cacheHitRate)), ("Saved by cache", usd(s.cacheSavingsUsd))]
        return out
    }

    /// "Max $4.10, average $1.20" over the chart's days.
    public static func chartLine(_ days: [UsageBucket]) -> String {
        let costs = days.map(\.costUsd)
        let avg = costs.isEmpty ? 0 : costs.reduce(0, +) / Double(costs.count)
        return "Max \(usd(costs.max() ?? 0)), average \(usd(avg))"
    }

    /// "11-27" from a "2026-11-27" day key.
    public static func shortDay(_ key: String) -> String {
        let c = Array(key)
        return c.count >= 10 && c[4] == "-" ? String(c[5..<10]) : key
    }

    /// "120 calls, 1.2M in, 45k out, worth $3.10 at API prices".
    public static func modelLine(_ b: UsageBucket) -> String {
        "\(b.calls) calls, \(tokens(b.inputTokens)) in, \(tokens(b.outputTokens)) out" + (ApiValue.worthLine(b.costUsd, b.apiValueUsd).map { ", \($0)" } ?? "")
    }
}

/// What plan use is worth at API prices (Android logic/ApiValue.kt, web features/usage/value.ts).
public enum ApiValue {
    /// Never less than what was billed; the bill from a hub that does not say.
    public static func worth(_ billed: Double, _ value: Double?) -> Double { max(billed, value ?? billed) }

    public static func saved(_ billed: Double, _ value: Double?) -> Double { max(0, worth(billed, value) - billed) }

    /// A plan served some of these calls: worth more than they billed by half a cent or more.
    public static func planServed(_ billed: Double, _ value: Double?) -> Bool { saved(billed, value) >= 0.005 }

    public static func planServed(_ b: UsageBucket) -> Bool { planServed(b.costUsd, b.apiValueUsd) }

    /// "Billed $0, worth $41.20 at API prices", or "Billed $12.50" for a key.
    public static func billedLine(_ billed: Double, _ value: Double?) -> String {
        "Billed \(UsageWords.usd(billed))" + (planServed(billed, value) ? ", worth \(UsageWords.usd(worth(billed, value))) at API prices" : "")
    }

    public static func worthLine(_ billed: Double, _ value: Double?) -> String? {
        planServed(billed, value) ? "worth \(UsageWords.usd(worth(billed, value))) at API prices" : nil
    }

    /// "Your plans saved you about $212 this month", nil when they saved under a cent.
    public static func savedSentence(_ totals: UsageBucket?) -> String? {
        guard let totals, planServed(totals) else { return nil }
        return "Your plans saved you about \(UsageWords.usd(saved(totals.costUsd, totals.apiValueUsd))) this month"
    }

    public static func savedDetail(_ totals: UsageBucket) -> String {
        let est = (totals.estimatedUsd ?? 0) >= 0.005 ? " Calls from before the hub kept this are priced from today's list prices." : ""
        return "Worth \(UsageWords.usd(worth(totals.costUsd, totals.apiValueUsd))) at API prices, billed \(UsageWords.usd(totals.costUsd)).\(est)"
    }
}

/// The Memory page's words (Android MemoryScreen).
public enum MemoryWords {
    /// "updated 3h ago, used 4 times".
    public static func meta(_ m: MemoryEntry, now: Int64) -> String {
        let a = Ago.short(m.updatedAt, now: now)
        let updated = m.updatedAt <= 0 ? "" : a == "now" ? "updated just now, " : "updated \(a) ago, "
        return updated + (m.useCount == 1 ? "used once" : "used \(m.useCount) times")
    }

    /// "project: conclave", "global".
    public static func scope(_ m: MemoryEntry) -> String {
        m.scopeKey.map { $0.isEmpty ? m.scope.rawValue : "\(m.scope.rawValue): \($0)" } ?? m.scope.rawValue
    }

    /// The tags field: comma separated, blanks dropped.
    public static func tags(_ text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// "3 memories", "1 memory".
    public static func count(_ n: Int) -> String { n == 1 ? "1 memory" : "\(n) memories" }
}
