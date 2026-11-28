import Foundation

// Accounts and their order (core client/accounts.ts; web settings/accounts.tsx). Each signed in plan
// and each API key is an account; the owner orders them per vendor. Keys and tokens never appear.

public struct PlanAccount: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var label: String
    public var vendor: String
    public var vendorName: String
    /// subscription or api
    public var kind: String
    public var plan: String?
    public var email: String?
    public var enabled: Bool
    /// ready, unknown, limited, cooldown, budget, paused or error
    public var state: String
    public var detail: String?
    public var until: Int64?
    public var windows: [LimitWindow]
    /// "Use when a model refuses".
    public var refusal: Bool
    public var gone: Bool

    public init(id: String, label: String = "", vendor: String = "", vendorName: String = "", kind: String = "api", enabled: Bool = true, state: String = "ready") {
        self.id = id
        self.label = label
        self.vendor = vendor
        self.vendorName = vendorName
        self.kind = kind
        self.enabled = enabled
        self.state = state
        windows = []
        refusal = false
        gone = false
    }

    private enum K: String, CodingKey { case id, label, vendor, vendorName, kind, plan, email, enabled, state, detail, until, windows, refusal, gone }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.or(.label, id)
        vendor = try c.or(.vendor, "")
        vendorName = try c.or(.vendorName, vendor)
        kind = try c.or(.kind, "api")
        plan = try? c.opt(.plan)
        email = try? c.opt(.email)
        enabled = try c.or(.enabled, true)
        state = try c.or(.state, "unknown")
        detail = try? c.opt(.detail)
        until = try? c.opt(.until)
        windows = (try? c.or(.windows, [LimitWindow]())) ?? []
        refusal = try c.or(.refusal, false)
        gone = try c.or(.gone, false)
    }
}

public struct AccountRoute: Sendable, Hashable, Decodable {
    public var vendor: String
    public var vendorName: String
    /// A model pattern; nil is the vendor's default order.
    public var match: String?
    public var order: [String]

    public init(vendor: String, vendorName: String = "", match: String? = nil, order: [String] = []) {
        self.vendor = vendor
        self.vendorName = vendorName
        self.match = match
        self.order = order
    }

    private enum K: String, CodingKey { case vendor, vendorName, match, order }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        vendor = try c.or(.vendor, "")
        vendorName = try c.or(.vendorName, vendor)
        match = try? c.opt(.match)
        order = try c.or(.order, [])
    }
}

/// GET /api/accounts.
public struct AccountsStatus: Sendable, Hashable, Decodable {
    public var accounts: [PlanAccount] = []
    public var routes: [AccountRoute] = []
    public var refreshedAt: Int64?
    /// CLIProxyAPI's management answers: pause, Try now and the order reach it.
    public var management = false

    public init(accounts: [PlanAccount] = [], routes: [AccountRoute] = [], management: Bool = true) {
        self.accounts = accounts
        self.routes = routes
        self.management = management
    }

    private enum K: String, CodingKey { case accounts, routes, refreshedAt, management }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        accounts = try c.or(.accounts, [])
        routes = try c.or(.routes, [])
        refreshedAt = try? c.opt(.refreshedAt)
        management = try c.or(.management, false)
    }
}

public enum AccountWords {
    /// The web's STATE_WORD: the word and its tone (ok, warn, fault, dim).
    public static func state(_ s: String) -> (String, Providers.Tone) {
        switch s {
        case "limited": ("At its limit", .warn)
        case "cooldown": ("Resting", .warn)
        case "budget": ("Budget spent", .fault)
        case "paused": ("Paused", .dim)
        case "error": ("Not working", .fault)
        default: ("Ready", .ok)
        }
    }

    /// The vendors' default orders, each with its accounts in order; accounts the route leaves out go last.
    public static func vendorOrders(_ s: AccountsStatus) -> [(AccountRoute, [PlanAccount])] {
        let byId = Dictionary(s.accounts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return s.routes.filter { $0.match == nil }.map { r in
            let listed = r.order.compactMap { byId[$0] }
            let rest = s.accounts.filter { $0.vendor == r.vendor && !r.order.contains($0.id) }
            return (r, listed + rest)
        }
    }

    /// The order after moving `id` by `by` (-1 up, 1 down); unchanged at either end.
    public static func moved(_ order: [String], _ id: String, by: Int) -> [String] {
        guard let i = order.firstIndex(of: id) else { return order }
        let j = i + by
        guard order.indices.contains(j) else { return order }
        var o = order
        o.swapAt(i, j)
        return o
    }
}

extension ConclaveClient {
    public func accounts() async throws -> AccountsStatus { try await get(["api", "accounts"]) }

    public func refreshAccounts() async throws -> AccountsStatus { try await call("POST", ["api", "accounts", "refresh"]) }

    public func setAccountOrder(vendor: String, order: [String]) async throws -> AccountsStatus {
        try await send("PUT", ["api", "accounts", "order"], JSONValue.object(["vendor": .string(vendor), "order": .array(order.map(JSONValue.string))]))
    }

    /// PATCH /api/accounts/:id with `enabled` or `refusal`.
    public func updateAccount(_ id: String, _ patch: JSONObject) async throws -> AccountsStatus {
        try await send("PATCH", ["api", "accounts", id], JSONValue.object(patch))
    }

    public func tryAccountNow(_ id: String) async throws -> AccountsStatus { try await call("POST", ["api", "accounts", id, "try"]) }

    public func removeAccount(_ id: String) async throws -> AccountsStatus { try await call("DELETE", ["api", "accounts", id]) }
}
