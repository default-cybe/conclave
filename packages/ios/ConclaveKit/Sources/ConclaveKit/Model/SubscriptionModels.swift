import Foundation

// Subscription sign-in through the hub's CLIProxyAPI (core client/subscriptions.ts; Android
// model/Subscriptions.kt). States and flows stay strings, so a newer value still decodes.
// Tokens never leave the hub.

/// One plan the running CLIProxyAPI can sign in to (claude, codex, antigravity, ...).
public struct SubscriptionProvider: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name: String
    /// What signing in gives, in words ("Claude Pro or Max").
    public var plan: String
    /// "redirect" (ends on a localhost page) or "device" (a code typed on the provider's page).
    public var flow: String
    public var accounts: Int
    /// Shown under "More plans" rather than with the main rows.
    public var more: Bool

    public init(id: String, name: String? = nil, plan: String = "", flow: String = "redirect", accounts: Int = 0, more: Bool = false) {
        self.id = id
        self.name = name ?? id
        self.plan = plan
        self.flow = flow
        self.accounts = accounts
        self.more = more
    }

    private enum K: String, CodingKey { case id, name, plan, flow, accounts, more }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, id)
        plan = try c.or(.plan, "")
        flow = try c.or(.flow, "redirect")
        accounts = try c.or(.accounts, 0)
        more = try c.or(.more, false)
    }
}

/// A signed in account. state: active, refreshing, disabled, unavailable, error or unknown.
public struct SubscriptionAccount: Sendable, Hashable, Decodable, Identifiable {
    public var id: String { name }
    public var name: String
    public var provider: String
    public var providerName: String
    public var label: String?
    public var state: String
    public var detail: String?
    public var canRefresh: Bool

    public init(name: String, provider: String = "", providerName: String? = nil, label: String? = nil, state: String = "unknown", detail: String? = nil, canRefresh: Bool = false) {
        self.name = name
        self.provider = provider
        self.providerName = providerName ?? provider
        self.label = label
        self.state = state
        self.detail = detail
        self.canRefresh = canRefresh
    }

    private enum K: String, CodingKey { case name, provider, providerName, label, state, detail, canRefresh }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        name = try c.decode(String.self, forKey: .name)
        provider = try c.or(.provider, "")
        providerName = try c.or(.providerName, provider)
        label = try c.opt(.label)
        state = try c.or(.state, "unknown")
        detail = try c.opt(.detail)
        canRefresh = try c.or(.canRefresh, false)
    }
}

/// GET /api/subscriptions: the owner's hub-wide CLIProxyAPI, or a member's own.
public struct SubscriptionsStatus: Sendable, Hashable, Decodable {
    /// off, builtin or external
    public var mode = "off"
    /// off, installing, starting, on or error
    public var state = "off"
    public var detail: String?
    public var error: String?
    public var version: String?
    /// Sign-in and the accounts list work here.
    public var management = false
    public var managementNote: String?
    public var providers: [SubscriptionProvider] = []
    public var accounts: [SubscriptionAccount] = []

    public init(mode: String = "off", state: String = "off", management: Bool = false, providers: [SubscriptionProvider] = [], accounts: [SubscriptionAccount] = []) {
        self.mode = mode
        self.state = state
        self.management = management
        self.providers = providers
        self.accounts = accounts
    }

    private enum K: String, CodingKey { case mode, state, detail, error, version, management, managementNote, providers, accounts }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        mode = try c.or(.mode, "off")
        state = try c.or(.state, "off")
        detail = try c.opt(.detail)
        error = try c.opt(.error)
        version = try c.opt(.version)
        management = try c.or(.management, false)
        managementNote = try c.opt(.managementNote)
        providers = try c.or(.providers, [])
        accounts = try c.or(.accounts, [])
    }
}

/// POST /api/subscriptions/signin.
public struct SignInStart: Sendable, Hashable, Decodable {
    public var state: String
    public var provider: String
    /// The provider's sign-in page.
    public var url: String
    public var flow: String
    public var userCode: String?
    /// The hub catches the localhost redirect itself; false: paste the address from the browser bar.
    public var caught: Bool
    public var callbackHost: String?

    public init(state: String, provider: String = "", url: String, flow: String = "redirect", userCode: String? = nil, caught: Bool = false, callbackHost: String? = nil) {
        self.state = state
        self.provider = provider
        self.url = url
        self.flow = flow
        self.userCode = userCode
        self.caught = caught
        self.callbackHost = callbackHost
    }

    private enum K: String, CodingKey { case state, provider, url, flow, userCode, caught, callbackHost }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        state = try c.decode(String.self, forKey: .state)
        provider = try c.or(.provider, "")
        url = try c.decode(String.self, forKey: .url)
        flow = try c.or(.flow, "redirect")
        userCode = try c.opt(.userCode)
        caught = try c.or(.caught, false)
        callbackHost = try c.opt(.callbackHost)
    }
}

/// status: wait, ok, error or cancelled.
public struct SignInStatus: Sendable, Hashable, Decodable {
    public var status = "wait"
    public var error: String?

    private enum K: String, CodingKey { case status, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        status = try c.or(.status, "wait")
        error = try c.opt(.error)
    }
}

/// POST /api/providers/:id/test: a list of models, never a paid request.
public struct ProviderTestResult: Sendable, Hashable, Decodable {
    public var ok = false
    public var detail = ""
    public var latencyMs: Int?

    public init(ok: Bool, detail: String, latencyMs: Int? = nil) {
        self.ok = ok
        self.detail = detail
        self.latencyMs = latencyMs
    }

    private enum K: String, CodingKey { case ok, detail, latencyMs }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        ok = try c.or(.ok, false)
        detail = try c.or(.detail, "")
        latencyMs = try c.opt(.latencyMs)
    }
}
