import ConclaveKit
import Foundation
import Observation
import UIKit

/// The app's state: the saved pairing, the connect flow and the hub in use.
@MainActor @Observable
final class AppModel {
    private(set) var pairing: SavedPairing?
    private(set) var hub: HubModel?
    var address = ""
    var code = ""
    var password = ""
    /// Whose password on a hub with several people; empty is the owner's.
    var account = ""
    var fingerprint: String?
    var alts: [String] = []
    var busy = false
    var error: String?
    var scanning = false
    /// After a password login, once: the hub's fingerprint to compare with Settings on the hub.
    var newSignIn: String?
    /// The address in use did not prove the pinned key: nothing with the token went there.
    var notYourHub: String?

    private let store: PairingStore
    private let session: URLSession
    private let transport: any LiveTransport
    /// Off only for the mock hub of CI screenshots, which has no key to prove.
    private let checksIdentity: Bool

    init(store: PairingStore, session: URLSession = .shared, transport: any LiveTransport = URLSessionLiveTransport(), checksIdentity: Bool = true) {
        self.store = store
        self.session = session
        self.transport = transport
        self.checksIdentity = checksIdentity
        pairing = store.load()
        if let pairing { hub = makeHub(pairing) }
    }

    /// A conclave://pair link (tapped, or read by the scanner) fills the form.
    func open(_ url: URL) {
        guard case .pair(let u, let c, let a, let fp) = DeepLink.parse(url.absoluteString) else { return }
        address = u
        code = c
        alts = a
        fingerprint = fp
    }

    /// The scanner read a code: a pairing link pairs at once.
    func scanned(_ text: String) {
        scanning = false
        guard let url = URL(string: text), case .pair = DeepLink.parse(text) else {
            error = "That QR code is not a Conclave pairing code."
            return
        }
        open(url)
        Task { await pair() }
    }

    var canPair: Bool { !busy && HubAddress.parse(address) != nil && !code.trimmingCharacters(in: .whitespaces).isEmpty }
    var canLogin: Bool { !busy && HubAddress.parse(address) != nil && !password.isEmpty }

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
            signedIn(used, res)
            self.code = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    func login() async {
        guard let hub = HubAddress.parse(address) else {
            error = "Enter your hub's address."
            return
        }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let res = try await ConclaveClient(baseURL: hub.url, session: session)
                .login(password: password, name: UIDevice.current.name, account: account)
            signedIn(hub.url, res)
            password = ""
            newSignIn = HubKeys.fingerprint(res.identity?.publicKey)
        } catch let e as ConclaveAPIError where e.status == 404 {
            error = "This hub has no password login. Update the hub, or use a pairing code."
        } catch let e as ConclaveAPIError where (400...403).contains(e.status) {
            error = e.message.isEmpty ? "Wrong name or password." : e.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A pairing or a login worked: keep the token, the hub's key and its addresses.
    private func signedIn(_ url: String, _ res: PairResponse) {
        let key = res.identity.map(\.publicKey).flatMap { HubKeys.rawKey($0) != nil ? $0 : nil }
        let saved = SavedPairing(
            addresses: HubAddresses.atPairing(used: url, reply: res.addresses), token: res.token,
            hubName: res.hub.name, publicKey: key
        )
        store.save(saved)
        pairing = saved
        notYourHub = nil
        hub = makeHub(saved)
    }

    /// Not your hub: use another of the hub's saved addresses first.
    func use(_ address: String) {
        guard var p = pairing else { return }
        p.addresses = [address] + p.addresses.filter { $0 != address }
        store.save(p)
        pairing = p
        notYourHub = nil
        hub = makeHub(p)
    }

    func forget() {
        hub?.stop()
        hub = nil
        store.save(nil)
        pairing = nil
        notYourHub = nil
    }

    private func makeHub(_ p: SavedPairing) -> HubModel {
        hub?.stop()
        // the key pinned at pairing; every address proves it before the token goes there
        let guardian = HubIdentityGuard(
            pinnedKey: p.publicKey,
            onPinned: { [weak self] id in await self?.pinned(id) },
            onMismatch: { [weak self] e in Task { @MainActor in self?.notYourHub = e.address } }
        )
        let client = ConclaveClient(baseURL: p.addresses.first ?? "", token: p.token, identity: checksIdentity ? guardian : nil, session: session)
        return HubModel(client: client, transport: transport)
    }

    /// A pairing from before identity: keep the first key the hub proved (trust on first use).
    private func pinned(_ id: HubIdentity) {
        guard var p = pairing, p.publicKey == nil else { return }
        p.publicKey = id.publicKey
        store.save(p)
        pairing = p
    }
}
