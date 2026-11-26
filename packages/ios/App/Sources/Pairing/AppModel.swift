import ConclaveKit
import Foundation
import Observation
import UIKit

/// The app's state: the saved pairing and the connect flow. Phase 2 adds sessions and the socket.
@MainActor @Observable
final class AppModel {
    private(set) var pairing: SavedPairing?
    var address = ""
    var code = ""
    var fingerprint: String?
    var alts: [String] = []
    var busy = false
    var error: String?

    private let store: PairingStore
    private let session: URLSession

    init(store: PairingStore, session: URLSession = .shared) {
        self.store = store
        self.session = session
        pairing = store.load()
    }

    /// A conclave://pair link fills the form; phase 2 opens sessions and chats.
    func open(_ url: URL) {
        guard case .pair(let u, let c, let a, let fp) = DeepLink.parse(url.absoluteString) else { return }
        address = u
        code = c
        alts = a
        fingerprint = fp
    }

    var canPair: Bool { !busy && HubAddress.parse(address) != nil && !code.trimmingCharacters(in: .whitespaces).isEmpty }

    func pair() async {
        guard let hub = HubAddress.parse(address) else {
            error = "Enter your hub's address."
            return
        }
        busy = true
        error = nil
        defer { busy = false }
        let code = code.trimmingCharacters(in: .whitespaces)
        let name = UIDevice.current.name
        do {
            let (used, res) = try await HubAddresses.firstAnswer([hub.url] + alts) { url in
                try await ConclaveClient(baseURL: url, session: self.session).pair(code: code, name: name, fingerprint: self.fingerprint)
            }
            let saved = SavedPairing(
                addresses: HubAddresses.atPairing(used: used, reply: res.addresses), token: res.token,
                hubName: res.hub.name, publicKey: res.identity?.publicKey
            )
            store.save(saved)
            pairing = saved
            self.code = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    func forget() {
        store.save(nil)
        pairing = nil
    }
}
