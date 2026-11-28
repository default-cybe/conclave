import ConclaveKit
import Foundation
import Security

/// What the app keeps for its hub: the addresses, the token and the pinned key.
struct SavedPairing: Codable, Equatable, Sendable {
    var addresses: [String]
    var token: String
    var hubName: String
    var publicKey: String?
    /// This app's row on the hub (DELETE /api/clients/:id signs it out). Missing on pairings from before 0.11.
    var clientId: String?
    /// Whose token this is, from the pairing or login reply. Missing on pairings from before several accounts.
    var account: AccountRef?

    /// Same hub and same person (Accounts.same).
    var signIn: SignInKey { SignInKey(addresses: addresses, publicKey: publicKey, account: account?.id, token: token) }
}

/// Every paired hub or account, and the index of the one in use.
struct SavedAccounts: Codable, Equatable, Sendable {
    var list: [SavedPairing]
    var active: Int
}

protocol PairingStore: Sendable {
    func load() -> SavedPairing?
    func save(_ p: SavedPairing?)
    func loadAccounts() -> SavedAccounts
    func saveAccounts(_ a: SavedAccounts)
}

/// A store that keeps one pairing (previews, the mock hub, tests) keeps the account in use only.
extension PairingStore {
    func loadAccounts() -> SavedAccounts { SavedAccounts(list: load().map { [$0] } ?? [], active: 0) }
    func saveAccounts(_ a: SavedAccounts) { save(a.list.indices.contains(a.active) ? a.list[a.active] : nil) }
}

/// Generic password items, readable only while the device is unlocked and never synced: "pairing" (the
/// account in use, what builds before several accounts read) and "accounts" (every account).
struct KeychainStore: PairingStore {
    private func query(_ account: String) -> [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "dev.conclave.app",
        kSecAttrAccount as String: account,
    ] }

    private func read(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private func write(_ account: String, _ data: Data?) {
        SecItemDelete(query(account) as CFDictionary)
        guard let data else { return }
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    func load() -> SavedPairing? {
        read("pairing").flatMap { try? JSONDecoder().decode(SavedPairing.self, from: $0) }
    }

    func save(_ p: SavedPairing?) {
        write("pairing", p.flatMap { try? JSONEncoder().encode($0) })
    }

    func loadAccounts() -> SavedAccounts {
        if let data = read("accounts"), let a = try? JSONDecoder().decode(SavedAccounts.self, from: data), !a.list.isEmpty { return a }
        // a pairing from before several accounts (or an unreadable list): it becomes the only account
        return SavedAccounts(list: load().map { [$0] } ?? [], active: 0)
    }

    func saveAccounts(_ a: SavedAccounts) {
        write("accounts", a.list.isEmpty ? nil : (try? JSONEncoder().encode(a)))
        // the one in use stays in "pairing" too, so an older build after a downgrade still finds it
        save(a.list.indices.contains(a.active) ? a.list[a.active] : nil)
    }
}
