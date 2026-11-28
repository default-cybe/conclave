import Foundation

/// What tells two sign ins apart (web lib/people.ts same): the hub, then the person on it.
public struct SignInKey: Sendable, Hashable {
    public var addresses: [String]
    public var publicKey: String?
    /// The account id from the pairing reply; nil on pairings from before several accounts.
    public var account: String?
    public var token: String

    public init(addresses: [String], publicKey: String?, account: String?, token: String) {
        self.addresses = addresses
        self.publicKey = publicKey
        self.account = account
        self.token = token
    }
}

/// Several paired hubs and accounts on one device (web components/AccountMenu.tsx, lib/people.ts).
public enum Accounts {
    /// Same hub (the same pinned key, else a shared address) and same person (the same account id,
    /// else, for a pairing from before accounts, the same token): a new sign in replaces it.
    public static func same(_ a: SignInKey, _ b: SignInKey) -> Bool {
        let hub: Bool
        if let ak = a.publicKey, let bk = b.publicKey { hub = ak == bk } else { hub = !Set(a.addresses).isDisjoint(with: b.addresses) }
        guard hub else { return false }
        if let x = a.account, let y = b.account { return x == y }
        return a.token == b.token
    }

    /// The index in use once `removed` is taken out of `count` accounts with `active` in use: the next
    /// one (the one before when the last went), the same one when another went. Nil when none is left.
    public static func activeAfterRemoving(_ removed: Int, active: Int, count: Int) -> Int? {
        let left = count - 1
        guard left > 0 else { return nil }
        if removed < active { return active - 1 }
        if removed > active { return min(active, left - 1) }
        return min(removed, left - 1)
    }
}
