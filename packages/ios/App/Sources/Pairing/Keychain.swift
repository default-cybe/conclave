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
}

protocol PairingStore: Sendable {
    func load() -> SavedPairing?
    func save(_ p: SavedPairing?)
}

/// One generic password item, readable only while the device is unlocked and never synced.
struct KeychainStore: PairingStore {
    private var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "dev.conclave.app",
        kSecAttrAccount as String: "pairing",
    ] }

    func load() -> SavedPairing? {
        var q = query
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(SavedPairing.self, from: data)
    }

    func save(_ p: SavedPairing?) {
        SecItemDelete(query as CFDictionary)
        guard let p, let data = try? JSONEncoder().encode(p) else { return }
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}
