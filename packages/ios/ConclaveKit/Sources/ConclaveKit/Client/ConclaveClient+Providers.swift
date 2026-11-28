import Foundation

// Provider keys and plan sign-in (Settings > Providers and Subscriptions; Android
// ConclaveClientProviders.kt). Keys go to the hub and never come back.
extension ConclaveClient {
    /// Save a provider key, or remove it with nil (PUT /api/secrets kind providers).
    public func setProviderKey(_ provider: String, _ value: String?) async throws {
        try await sendUnit("PUT", ["api", "secrets"], JSONValue.object(["kind": .string("providers"), "key": .string(provider), "value": value.map(JSONValue.string) ?? .null]))
    }

    public func testProvider(_ provider: String) async throws -> ProviderTestResult {
        try await call("POST", ["api", "providers", provider, "test"])
    }

    /// The whole GET /api/config answer: `secrets` lists which providers have a key.
    public func configSecrets() async throws -> JSONValue {
        let r: JSONValue = try await get(["api", "config"])
        return r["secrets"] ?? .null
    }

    public func subscriptions() async throws -> SubscriptionsStatus { try await get(["api", "subscriptions"]) }

    public func startBuiltinSubscriptions() async throws -> SubscriptionsStatus {
        try await send("PUT", ["api", "subscriptions"], JSONValue.object(["mode": .string("builtin")]))
    }

    public func startSignIn(_ provider: String) async throws -> SignInStart {
        try await send("POST", ["api", "subscriptions", "signin"], JSONValue.object(["provider": .string(provider)]))
    }

    public func signInStatus(_ state: String) async throws -> SignInStatus { try await get(["api", "subscriptions", "signin", state]) }

    /// A redirect the hub could not catch: the address pasted from the browser bar.
    public func finishSignIn(_ state: String, url: String) async throws -> SignInStatus {
        try await send("POST", ["api", "subscriptions", "signin", state, "callback"], JSONValue.object(["url": .string(url)]))
    }

    public func cancelSignIn(_ state: String) async throws { try await sendUnit("DELETE", ["api", "subscriptions", "signin", state]) }

    public func removeSubscriptionAccount(_ name: String) async throws -> SubscriptionsStatus {
        try await call("DELETE", ["api", "subscriptions", "accounts", name])
    }

    public func refreshSubscriptionAccount(_ name: String) async throws -> SubscriptionsStatus {
        try await call("POST", ["api", "subscriptions", "accounts", name, "refresh"])
    }
}
