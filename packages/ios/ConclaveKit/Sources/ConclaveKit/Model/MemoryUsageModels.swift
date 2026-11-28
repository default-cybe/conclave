import Foundation

// Wire shapes of Memory and Usage (Android model/Models.kt MemoryEntry, LimitState; model/Api.kt
// MemoryInput, UsageBucket, UsageSummary). Missing fields fall back, as the Kotlin client's.

public enum MemoryScope: String, WireEnum {
    case global, project, agent
    public static let fallback = MemoryScope.global
}

public enum MemoryKind: String, WireEnum {
    case profile, fact, episode, procedure
    public static let fallback = MemoryKind.fact

    public var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

/// One memory (MemoryEntry and MemoryHit in one shape: `score` is set for search hits).
public struct MemoryEntry: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var scope: MemoryScope = .global
    public var scopeKey: String?
    public var kind: MemoryKind = .fact
    public var content = ""
    public var tags: [String] = []
    public var sourceSessionId: String?
    public var importance: Double = 0
    public var createdAt: Int64 = 0
    public var updatedAt: Int64 = 0
    public var lastUsedAt: Int64?
    public var useCount: Int64 = 0
    public var score: Double?

    public init(id: String, scope: MemoryScope = .global, scopeKey: String? = nil, kind: MemoryKind = .fact, content: String = "",
                tags: [String] = [], updatedAt: Int64 = 0, useCount: Int64 = 0) {
        self.id = id
        self.scope = scope
        self.scopeKey = scopeKey
        self.kind = kind
        self.content = content
        self.tags = tags
        self.updatedAt = updatedAt
        self.useCount = useCount
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        scope = try c.or(.scope, .global)
        scopeKey = try? c.opt(.scopeKey)
        kind = try c.or(.kind, .fact)
        content = try c.or(.content, "")
        tags = (try? c.or(.tags, [String]())) ?? []
        sourceSessionId = try? c.opt(.sourceSessionId)
        importance = (try? c.or(.importance, 0.0)) ?? 0
        createdAt = (try? c.or(.createdAt, Int64(0))) ?? 0
        updatedAt = (try? c.or(.updatedAt, Int64(0))) ?? 0
        lastUsedAt = try? c.opt(.lastUsedAt)
        useCount = (try? c.or(.useCount, Int64(0))) ?? 0
        score = try? c.opt(.score)
    }
}

/// POST and PATCH /api/memory body; nil fields are left out (PATCH keeps them).
public struct MemoryInput: Sendable, Hashable, Encodable {
    public var content: String?
    public var kind: MemoryKind?
    public var scope: MemoryScope?
    public var scopeKey: String?
    public var tags: [String]?
    public var importance: Double?

    public init(content: String? = nil, kind: MemoryKind? = nil, scope: MemoryScope? = nil, scopeKey: String? = nil,
                tags: [String]? = nil, importance: Double? = nil) {
        self.content = content
        self.kind = kind
        self.scope = scope
        self.scopeKey = scopeKey
        self.tags = tags
        self.importance = importance
    }
}

/// One limit window of a plan or key: "5h", "7d", "requests / min".
public struct LimitWindow: Sendable, Hashable, Codable {
    public var name = ""
    /// 0 to 100.
    public var usedPercent: Double?
    public var remaining: Double?
    public var limit: Double?
    public var resetsAt: Int64?

    public init(name: String = "", usedPercent: Double? = nil, remaining: Double? = nil, limit: Double? = nil, resetsAt: Int64? = nil) {
        self.name = name
        self.usedPercent = usedPercent
        self.remaining = remaining
        self.limit = limit
        self.resetsAt = resetsAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.or(.name, "")
        usedPercent = try? c.opt(.usedPercent)
        remaining = try? c.opt(.remaining)
        limit = try? c.opt(.limit)
        resetsAt = try? c.opt(.resetsAt)
    }
}

/// GET /api/limits: one state per provider account, with its windows.
public struct LimitState: Sendable, Hashable, Codable, Identifiable {
    public var provider: String
    public var account: String?
    public var label = ""
    public var windows: [LimitWindow] = []
    public var updatedAt: Int64 = 0
    public var blocked: Bool?
    /// headers, oauth, logs, api, ledger or error
    public var source = "api"
    /// Why a signed in plan has no windows ("Usage not reported by Google").
    public var note: String?

    /// provider, or provider:account (core accounts/windows.ts limitKey).
    public var key: String { account?.isEmpty == false ? "\(provider):\(account!)" : provider }
    public var id: String { key }

    public init(provider: String, account: String? = nil, label: String = "", windows: [LimitWindow] = [], updatedAt: Int64 = 0,
                blocked: Bool? = nil, source: String = "api", note: String? = nil) {
        self.provider = provider
        self.account = account
        self.label = label
        self.windows = windows
        self.updatedAt = updatedAt
        self.blocked = blocked
        self.source = source
        self.note = note
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.or(.provider, "")
        account = try? c.opt(.account)
        label = try c.or(.label, "")
        windows = (try? c.or(.windows, [LimitWindow]())) ?? []
        updatedAt = (try? c.or(.updatedAt, Int64(0))) ?? 0
        blocked = try? c.opt(.blocked)
        source = try c.or(.source, "api")
        note = try? c.opt(.note)
    }
}

/// One row of a usage summary: totals, a day, a model or an account.
public struct UsageBucket: Sendable, Hashable, Codable {
    public var key = ""
    public var inputTokens: Int64 = 0
    public var outputTokens: Int64 = 0
    public var cacheReadTokens: Int64 = 0
    public var cacheWriteTokens: Int64 = 0
    /// What was billed: 0 for calls a signed in plan served.
    public var costUsd: Double = 0
    /// The same tokens at the models' API prices; nil from a hub before it was kept.
    public var apiValueUsd: Double?
    /// The part of `apiValueUsd` priced on read for rows from before it was kept.
    public var estimatedUsd: Double?
    public var calls: Int64 = 0

    public init(key: String = "", inputTokens: Int64 = 0, outputTokens: Int64 = 0, costUsd: Double = 0, apiValueUsd: Double? = nil,
                estimatedUsd: Double? = nil, calls: Int64 = 0) {
        self.key = key
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.costUsd = costUsd
        self.apiValueUsd = apiValueUsd
        self.estimatedUsd = estimatedUsd
        self.calls = calls
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = (try? c.or(.key, "")) ?? ""
        inputTokens = (try? c.or(.inputTokens, Int64(0))) ?? 0
        outputTokens = (try? c.or(.outputTokens, Int64(0))) ?? 0
        cacheReadTokens = (try? c.or(.cacheReadTokens, Int64(0))) ?? 0
        cacheWriteTokens = (try? c.or(.cacheWriteTokens, Int64(0))) ?? 0
        costUsd = (try? c.or(.costUsd, 0.0)) ?? 0
        apiValueUsd = try? c.opt(.apiValueUsd)
        estimatedUsd = try? c.opt(.estimatedUsd)
        calls = (try? c.or(.calls, Int64(0))) ?? 0
    }
}

/// GET /api/usage: totals and breakdowns for a range.
public struct UsageSummary: Sendable, Hashable, Codable {
    public var from: Int64 = 0
    public var to: Int64 = 0
    public var totals = UsageBucket()
    public var byDay: [UsageBucket] = []
    public var byModel: [UsageBucket] = []
    /// By account (models.accounts id); "" for calls no account served.
    public var byAccount: [UsageBucket] = []
    /// Fraction of input tokens served from cache.
    public var cacheHitRate: Double = 0
    public var cacheSavingsUsd: Double = 0
    public var savedUsd: Double?

    public init(totals: UsageBucket = UsageBucket(), byDay: [UsageBucket] = [], byModel: [UsageBucket] = [], byAccount: [UsageBucket] = [],
                cacheHitRate: Double = 0, cacheSavingsUsd: Double = 0) {
        self.totals = totals
        self.byDay = byDay
        self.byModel = byModel
        self.byAccount = byAccount
        self.cacheHitRate = cacheHitRate
        self.cacheSavingsUsd = cacheSavingsUsd
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = (try? c.or(.from, Int64(0))) ?? 0
        to = (try? c.or(.to, Int64(0))) ?? 0
        totals = (try? c.or(.totals, UsageBucket())) ?? UsageBucket()
        byDay = (try? c.or(.byDay, [UsageBucket]())) ?? []
        byModel = (try? c.or(.byModel, [UsageBucket]())) ?? []
        byAccount = (try? c.or(.byAccount, [UsageBucket]())) ?? []
        cacheHitRate = (try? c.or(.cacheHitRate, 0.0)) ?? 0
        cacheSavingsUsd = (try? c.or(.cacheSavingsUsd, 0.0)) ?? 0
        savedUsd = try? c.opt(.savedUsd)
    }
}
