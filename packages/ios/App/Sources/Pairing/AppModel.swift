import ConclaveKit
import Foundation
import Observation
import UIKit

/// The app's state: the saved pairings, the connect flow and the hub in use.
@MainActor @Observable
final class AppModel {
    /// Every paired hub or account on this device (Switch account), in the order they were added.
    private(set) var accounts: [SavedPairing] = []
    /// The one in use, an index into `accounts`.
    private(set) var activeIndex = 0
    /// The pairing in use; nil shows Connect.
    var pairing: SavedPairing? { accounts.indices.contains(activeIndex) ? accounts[activeIndex] : nil }
    private(set) var hub: HubModel?
    /// Add account: Connect shows over the hub in use (AddAccountSheet) until a pairing works or it is closed.
    var adding = false
    /// The fingerprint of a password login made while adding, shown once the add sheet closed.
    private var pendingSignIn: String?
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
        let saved = store.loadAccounts()
        accounts = saved.list
        activeIndex = saved.list.indices.contains(saved.active) ? saved.active : 0
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
            let added = adding
            signedIn(hub.url, res)
            password = ""
            // a sheet cannot open while the add sheet closes: AddAccountSheet shows it after
            if added { pendingSignIn = HubKeys.fingerprint(res.identity?.publicKey) } else { newSignIn = HubKeys.fingerprint(res.identity?.publicKey) }
        } catch let e as ConclaveAPIError where e.status == 404 {
            error = "This hub has no password login. Update the hub, or use a pairing code."
        } catch let e as ConclaveAPIError where (400...403).contains(e.status) {
            error = e.message.isEmpty ? "Wrong name or password." : e.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A pairing or a login worked: keep the token, the hub's key and its addresses. The same person
    /// on the same hub again replaces their old sign in; anyone else is added. The new one is in use.
    private func signedIn(_ url: String, _ res: PairResponse) {
        let key = res.identity.map(\.publicKey).flatMap { HubKeys.rawKey($0) != nil ? $0 : nil }
        let saved = SavedPairing(
            addresses: HubAddresses.atPairing(used: url, reply: res.addresses), token: res.token,
            hubName: res.hub.name, publicKey: key, clientId: res.clientId.isEmpty ? nil : res.clientId, account: res.account
        )
        if let i = accounts.firstIndex(where: { Accounts.same($0.signIn, saved.signIn) }) {
            accounts[i] = saved
            activeIndex = i
        } else {
            accounts.append(saved)
            activeIndex = accounts.count - 1
        }
        persist()
        adding = false
        notYourHub = nil
        hub = makeHub(saved)
    }

    /// Not your hub: use another of the hub's saved addresses first.
    func use(_ address: String) {
        guard var p = pairing else { return }
        p.addresses = [address] + p.addresses.filter { $0 != address }
        accounts[activeIndex] = p
        persist()
        notYourHub = nil
        hub = makeHub(p)
    }

    /// Switch account: another saved pairing becomes the one in use.
    func switchTo(_ index: Int) {
        guard accounts.indices.contains(index), index != activeIndex || hub == nil else { return }
        activeIndex = index
        persist()
        notYourHub = nil
        hub = makeHub(accounts[index])
    }

    /// Add account: Connect opens over the hub in use, which stays signed in (AddAccountSheet).
    func addAccount() {
        error = nil
        adding = true
    }

    /// The add sheet closed, paired or cancelled: clear the form, then show a login's fingerprint.
    func addClosed() {
        adding = false
        code = ""
        password = ""
        error = nil
        fingerprint = nil
        alts = []
        newSignIn = pendingSignIn
        pendingSignIn = nil
    }

    /// Sign out (the web's Log out): the hub revokes this app's token, then the app forgets the hub.
    /// A hub that is away, or a pairing from before the client id was kept, is forgotten here anyway.
    func signOut() async {
        if let id = pairing?.clientId, let client = hub?.client {
            try? await client.signOut(clientId: id)
        }
        forget()
    }

    /// Forget the account in use; the next saved one takes over, or Connect shows when none is left.
    func forget() {
        hub?.stop()
        hub = nil
        notYourHub = nil
        guard accounts.indices.contains(activeIndex) else { return }
        let next = Accounts.activeAfterRemoving(activeIndex, active: activeIndex, count: accounts.count)
        accounts.remove(at: activeIndex)
        activeIndex = next ?? 0
        persist()
        if let pairing { hub = makeHub(pairing) }
    }

    private func persist() {
        store.saveAccounts(SavedAccounts(list: accounts, active: activeIndex))
    }

    private func makeHub(_ p: SavedPairing) -> HubModel {
        hub?.stop()
        // the key pinned at pairing; every address proves it before the token goes there
        // the token names the account: a late answer from a hub switched away from must not reach another
        let token = p.token
        let guardian = HubIdentityGuard(
            pinnedKey: p.publicKey,
            onPinned: { [weak self] id in await self?.pinned(id, token: token) },
            onMismatch: { [weak self] e in Task { @MainActor in if self?.pairing?.token == token { self?.notYourHub = e.address } } }
        )
        let client = ConclaveClient(baseURL: p.addresses.first ?? "", token: p.token, identity: checksIdentity ? guardian : nil, session: session)
        AppLogs.start(client)
        return HubModel(client: client, transport: transport)
    }

    /// A pairing from before identity: keep the first key the hub proved (trust on first use).
    private func pinned(_ id: HubIdentity, token: String) {
        guard let i = accounts.firstIndex(where: { $0.token == token }), accounts[i].publicKey == nil else { return }
        accounts[i].publicKey = id.publicKey
        persist()
    }
}
