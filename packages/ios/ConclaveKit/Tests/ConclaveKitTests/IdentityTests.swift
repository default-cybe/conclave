import CryptoKit
import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client IdentityTest.kt (keys, the guard, pairing and password login).

/// RFC 8032 section 7.1, test 1.
private let rfcSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
private let rfcPublic = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
private let rfcEmptySig = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
/// The RFC key in base64url, its fingerprint, and its signature of the identity text for one nonce.
private let hubKey = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
private let hubFP = "21fe31dfa154a261626bf854046fd227"
private let vectorNonce = "q3vA9xYz-_0123456789ab"
private let vectorSig = "M-pkYZOtZnVRFCEhCYD_Bwoq2JM-cW3YaxqzCGewOXFfn5zb6xRtDQsH-hwnfsuChKKfyvuY9GNcxwr0Zae4Ag"

private func hex(_ s: String) -> Data {
    Data(stride(from: 0, to: s.count, by: 2).map { UInt8(s.dropFirst($0).prefix(2), radix: 16)! })
}

private let rfcKey = try! Curve25519.Signing.PrivateKey(rawRepresentation: hex(rfcSeed))

struct IdentityKeysTests {
    @Test func verifiesTheRfcVector() throws {
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: hex(rfcPublic))
        #expect(key.isValidSignature(hex(rfcEmptySig), for: Data()))
        var bad = hex(rfcEmptySig)
        bad[0] ^= 1
        #expect(!key.isValidSignature(bad, for: Data()))
        #expect(rfcKey.publicKey.rawRepresentation == hex(rfcPublic))
    }

    @Test func verifiesTheIdentityTextVector() throws {
        let raw = try #require(HubKeys.rawKey(hubKey))
        #expect(raw == hex(rfcPublic))
        #expect(String(decoding: HubKeys.signedText(vectorNonce), as: UTF8.self) == "conclave-hub-identity-v1\n\(vectorNonce)")
        #expect(HubKeys.verify(raw: raw, nonce: vectorNonce, signature: vectorSig))
        // the same signature does not cover another nonce
        #expect(!HubKeys.verify(raw: raw, nonce: vectorNonce + "x", signature: vectorSig))
        #expect(!HubKeys.verify(raw: raw, nonce: vectorNonce, signature: "not base64!"))
    }

    @Test func fingerprintIsTheFirst16BytesOfSha256InHex() {
        #expect(HubKeys.fingerprint(hubKey) == hubFP)
        #expect(HubKeys.groups(hubFP) == "21fe 31df a154 a261 626b f854 046f d227")
        #expect(HubKeys.sameFingerprint("21FE 31DF A154 A261 626B F854 046F D227", hubFP))
        #expect(!HubKeys.sameFingerprint(String(hubFP.dropLast()), String(hubFP.dropLast())))
        #expect(HubKeys.fingerprint("dG9vIHNob3J0") == nil)
        // padding or not, the same key
        #expect(HubKeys.sameKey(hubKey, hubKey + "="))
        #expect(!HubKeys.sameKey(hubKey, HubKeys.encode(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)))
    }

    @Test func noncesAreFreshBase64url() {
        let a = HubKeys.nonce(), b = HubKeys.nonce()
        #expect(a != b)
        #expect(a.count == 32)
        #expect(a.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }

    @Test func passwordGoesOnlyOverHttpsOrToAPrivateAddress() {
        let yes = [
            "https://hub.example.com", "https://8.8.8.8", "http://localhost:7777", "http://127.0.0.1:7777", "http://[::1]:7777",
            "http://10.1.2.3:7777", "http://172.16.0.5", "http://172.31.255.1", "http://192.168.1.20:7777", "http://100.64.0.1",
            "http://100.127.1.1", "http://[fd7a:115c:a1e0::1]:7777", "http://[fd00::1]", "http://studio.local:7777", "http://box.tail1234.ts.net",
        ]
        let no = [
            "http://hub.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://100.128.0.1", "http://192.169.1.1", "http://[fe80::1]",
            "http://[fd::1]", "http://[2001:db8::1]", "http://nas", "ftp://192.168.1.2", "",
        ]
        for u in yes { #expect(PasswordRule.allowed(u), "\(u)") }
        for u in no { #expect(!PasswordRule.allowed(u), "\(u)") }
        // the same cases as isPrivateAddress in packages/core/test/client/identity.test.ts
        let priv = [
            "http://localhost:7717", "http://127.0.0.1", "http://127.8.9.10:1", "http://[::1]:7717", "http://10.0.0.5",
            "http://172.16.0.1", "http://172.31.255.255", "http://192.168.1.20:7717", "http://100.64.0.1", "http://100.127.255.254",
            "http://[fd7a:115c:a1e0::1]:7717", "http://hub.local", "http://hub.local.:7717", "https://box.tail1234.ts.net", "192.168.0.2:7717",
        ]
        let pub = [
            "http://8.8.8.8", "http://172.15.0.1", "http://172.32.0.1", "http://100.63.0.1", "http://100.128.0.1", "http://192.169.0.1",
            "http://[2001:db8::1]", "http://[fc00::1]", "https://hub.example.com", "http://local", "http://evil.ts.net.example.com", "not a url at all",
        ]
        for u in priv { #expect(PasswordRule.isPrivateAddress(u), "\(u)") }
        for u in pub { #expect(!PasswordRule.isPrivateAddress(u), "\(u)") }
    }

    @Test func pairLinksCarryTheFingerprint() {
        let url = "https%3A%2F%2Fa.trycloudflare.com", lan = "http%3A%2F%2F192.168.1.2%3A7777"
        let link = DeepLink.parse("conclave://pair?url=\(url)&code=482913&fp=21FE31DFA154A261626BF854046FD227&alt=\(lan)")
        #expect(link == .pair(url: "https://a.trycloudflare.com", code: "482913", alts: ["http://192.168.1.2:7777"], fp: hubFP))
        // from a hub older than identity: no fp
        #expect(DeepLink.parse("conclave://pair?url=\(url)&code=1") == .pair(url: "https://a.trycloudflare.com", code: "1"))
        #expect(DeepLink.parse("conclave://pair?url=\(url)&code=1&fp=") == .pair(url: "https://a.trycloudflare.com", code: "1"))
    }

    @Test func pairingMovesOnOnlyWhenAnAddressDoesNotAnswer() async throws {
        var tried: [String] = []
        let (url, result) = try await HubAddresses.firstAnswer(["https://a", "http://b", "http://c"]) { u in
            tried.append(u)
            if u == "https://a" { throw URLError(.timedOut) }
            return "paired at \(u)"
        }
        #expect(url == "http://b")
        #expect(result == "paired at http://b")
        #expect(tried == ["https://a", "http://b"])

        // another machine at the first address: stop, the code never goes to the next one
        tried = []
        await #expect(throws: HubIdentityError.self) {
            _ = try await HubAddresses.firstAnswer(["https://a", "http://b"]) { (u: String) -> Int in
                tried.append(u)
                throw HubIdentityError(address: u, message: HubIdentityError.notTheCodesHub)
            }
        }
        #expect(tried == ["https://a"])

        // the hub's own answer (a used code) stops too
        tried = []
        await #expect(throws: ConclaveAPIError.self) {
            _ = try await HubAddresses.firstAnswer(["https://a", "http://b"]) { (u: String) -> Int in
                tried.append(u)
                throw ConclaveAPIError(status: 400, message: "Invalid or expired pairing code")
            }
        }
        #expect(tried == ["https://a"])
    }
}

/// A hub that signs nonces with `key`; each knob breaks the proof one way.
final class SigningHub: @unchecked Sendable {
    let hub: MockHub
    var key = rfcKey
    var identityStatus: Int?
    var identityBody: String?
    var networkRefused = false
    var fingerprintInstead: String?
    var signInstead: String?
    var routes: [String: String] = [:]

    init(host: String? = nil, scheme: String = "http") {
        hub = MockHub(host: host, scheme: scheme)
        hub.dispatch { [unowned self] r in
            switch r.path {
            case "/api/identity":
                if self.networkRefused { return .init(status: 403, body: #"{"error":"no","code":"network"}"#) }
                if let s = self.identityStatus { return .init(status: s, body: #"{"error":"x"}"#) }
                if let b = self.identityBody { return .init(body: b) }
                let raw = self.key.publicKey.rawRepresentation
                let text = self.signInstead.map { Data($0.utf8) } ?? HubKeys.signedText(r.query("nonce") ?? "")
                let sig = HubKeys.encode(try! self.key.signature(for: text))
                let fp = self.fingerprintInstead ?? HubKeys.fingerprint(raw: raw)
                return .init(body: #"{"publicKey":"\#(HubKeys.encode(raw))","fingerprint":"\#(fp)","signature":"\#(sig)"}"#)
            case "/api/info": return .init(body: #"{"name":"home","version":"1"}"#)
            default: return self.routes[r.path].map { .init(body: $0) } ?? .init(status: 404, body: #"{"error":"not found"}"#)
            }
        }
    }

    var paths: [String] { hub.requests.map(\.path) }
}

private final class Box<T>: @unchecked Sendable {
    var items: [T] = []
    let lock = NSLock()
    func add(_ x: T) { lock.withLock { items.append(x) } }
    var all: [T] { lock.withLock { items } }
}

struct IdentityGuardTests {
    @Test func theHubProvesItsKeyBeforeTheTokenGoes() async throws {
        let s = SigningHub()
        let guardian = HubIdentityGuard(pinnedKey: hubKey)
        #expect(try await s.hub.client(identity: guardian).info().name == "home")
        #expect(try await s.hub.client(identity: guardian).info().name == "home")
        let sent = s.hub.requests
        #expect(sent.map(\.path) == ["/api/identity", "/api/info", "/api/info"])
        // the identity call carries no token, and a nonce of its own
        #expect(sent[0].headers["Authorization"] == nil)
        #expect(sent[0].query("nonce")?.count == 32)
        #expect(sent[1].headers["Authorization"] == "Bearer secret-token")
    }

    @Test func anotherKeySendsNothing() async throws {
        let s = SigningHub()
        s.key = Curve25519.Signing.PrivateKey()
        let mismatches = Box<HubIdentityError>()
        let guardian = HubIdentityGuard(pinnedKey: hubKey, onMismatch: { mismatches.add($0) })
        await #expect(throws: HubIdentityError(address: s.hub.base)) { try await s.hub.client(identity: guardian).info() }
        #expect(mismatches.all.count == 1)
        #expect(s.paths == ["/api/identity"])
        #expect(s.hub.requests.allSatisfy { $0.headers["Authorization"] == nil })
    }

    @Test func aBadSignatureSendsNothing() async throws {
        // the right key, but the signature covers other words (a replayed answer)
        let s = SigningHub()
        s.signInstead = "conclave-hub-identity-v1\nsomeone-elses-nonce"
        await #expect(throws: HubIdentityError.self) { try await s.hub.client(identity: HubIdentityGuard(pinnedKey: hubKey)).info() }
        #expect(s.paths == ["/api/identity"])
    }

    @Test func noAnswerIsOfflineNotAStranger() async throws {
        let mismatches = Box<HubIdentityError>()
        let guardian = HubIdentityGuard(pinnedKey: hubKey, onMismatch: { mismatches.add($0) })
        let dead = ConclaveClient(baseURL: "http://nobody.test:1", token: "t", identity: guardian, session: MockHub().session)
        await #expect(throws: URLError.self) { try await dead.info() }
        #expect(mismatches.all.isEmpty)
    }

    @Test func aCheckHoldsTenMinutesAtThatAddress() async throws {
        let s = SigningHub()
        let clock = Box<Int64>()
        clock.add(1_000)
        let guardian = HubIdentityGuard(pinnedKey: hubKey, now: { clock.all.last! })
        let c = s.hub.client(identity: guardian)
        _ = try await c.info()
        clock.add(1_000 + HubIdentityGuard.defaultTTLMs - 1)
        _ = try await c.info()
        clock.add(1_000 + HubIdentityGuard.defaultTTLMs)
        _ = try await c.info()
        #expect(s.paths == ["/api/identity", "/api/info", "/api/info", "/api/identity", "/api/info"])
        await guardian.forget(s.hub.base)
        _ = try await c.info()
        #expect(s.paths.filter { $0 == "/api/identity" }.count == 3)
    }

    @Test func thisDeviceIsNotChecked() async throws {
        let s = SigningHub(host: "localhost")
        _ = try await s.hub.client(identity: HubIdentityGuard(pinnedKey: hubKey)).info()
        #expect(s.paths == ["/api/info"])
    }

    @Test func aHubPairedBeforeIdentityKeepsItsFirstKey() async throws {
        let s = SigningHub()
        let pinned = Box<HubIdentity>()
        let guardian = HubIdentityGuard(pinnedKey: nil, onPinned: { pinned.add($0) })
        _ = try await s.hub.client(identity: guardian).info()
        #expect(pinned.all == [HubIdentity(publicKey: hubKey, fingerprint: hubFP)])
        #expect(await guardian.pinnedKey == hubKey)
        // later another key at the address is a stranger
        s.key = Curve25519.Signing.PrivateKey()
        await guardian.forget(s.hub.base)
        await #expect(throws: HubIdentityError.self) { try await s.hub.client(identity: guardian).info() }
        #expect(pinned.all.count == 1)
    }

    @Test func aHubOlderThanIdentity() async throws {
        let s = SigningHub()
        s.identityStatus = 404
        // nothing pinned: nothing to check against, the token goes as before
        let pinned = Box<HubIdentity>()
        #expect(try await s.hub.client(identity: HubIdentityGuard(onPinned: { pinned.add($0) })).info().name == "home")
        #expect(pinned.all.isEmpty)
        // a key is pinned, so the hub has /api/identity: a 404 here is another machine
        await #expect(throws: HubIdentityError.self) { try await s.hub.client(identity: HubIdentityGuard(pinnedKey: hubKey)).info() }
    }

    @Test func whatCountsAsAStranger() async throws {
        let s = SigningHub()
        func info() async throws { _ = try await s.hub.client(identity: HubIdentityGuard(pinnedKey: hubKey)).info() }
        // a 4xx other than 429 is not the hub answering
        for code in [400, 401, 403, 404, 410] {
            s.identityStatus = code
            await #expect(throws: HubIdentityError.self, "\(code)") { try await info() }
        }
        // the hub's own trouble or a pause: an API error, not a stranger
        for code in [429, 500, 502, 503] {
            s.identityStatus = code
            do { try await info(); Issue.record("\(code) passed") } catch let e as ConclaveAPIError { #expect(e.status == code) }
        }
        s.identityStatus = nil
        // the hub's own network refusal: an API error in the app's words
        s.networkRefused = true
        do { try await info(); Issue.record("refusal passed") } catch let e as ConclaveAPIError {
            #expect(e.status == 403)
            #expect(e.message == HubIdentityError.networkRefused)
        }
        s.networkRefused = false
        // a page that is not a proof (a captive portal)
        for body in ["<html>Sign in to the Wi-Fi</html>", #"{"ok":true}"#] {
            s.identityBody = body
            await #expect(throws: HubIdentityError.self) { try await info() }
        }
        s.identityBody = nil
        // the right key and signature, but the proof names another fingerprint
        s.fingerprintInstead = String(repeating: "00", count: 16)
        await #expect(throws: HubIdentityError.self) { try await info() }
    }

    @Test func aQrCodeChecksItsHubBeforeTheCodeGoes() async throws {
        let s = SigningHub()
        s.routes["/api/pair"] = #"{"token":"tok","clientId":"c1","hub":{"name":"home"},"identity":{"publicKey":"\#(hubKey)","fingerprint":"\#(hubFP)"}}"#
        await #expect(throws: HubIdentityError(address: s.hub.base, message: HubIdentityError.notTheCodesHub)) {
            _ = try await s.hub.client(nil).pair(code: "482913", name: "iPad", fingerprint: String(repeating: "00", count: 16))
        }
        #expect(s.paths == ["/api/identity"])

        let r = try await s.hub.client(nil).pair(code: "482913", name: "iPad", fingerprint: hubFP.uppercased())
        #expect(r.token == "tok")
        #expect(r.identity == HubIdentity(publicKey: hubKey, fingerprint: hubFP))
        #expect(s.paths == ["/api/identity", "/api/identity", "/api/pair"])
        #expect(String(decoding: s.hub.requests[2].body, as: UTF8.self) == #"{"code":"482913","name":"iPad","platform":"ios"}"#)
    }

    @Test func aTypedCodeHasNoFingerprintToCheck() async throws {
        let s = SigningHub()
        s.routes["/api/pair"] = #"{"token":"tok","hub":{"name":"home"},"identity":{"publicKey":"\#(hubKey)","fingerprint":"\#(hubFP)"}}"#
        let r = try await s.hub.client(nil).pair(code: "482913", name: "iPad")
        #expect(r.identity?.publicKey == hubKey)
        #expect(s.paths == ["/api/pair"])
    }

    @Test func passwordLoginRefusesPlainHttpToAPublicAddress() async throws {
        let s = SigningHub(host: "hub.example.com")
        await #expect(throws: PasswordOverHTTPError.self) { _ = try await s.hub.client(nil).login(password: "correct horse battery", name: "iPad") }
        #expect(s.paths.isEmpty)
    }

    @Test func passwordLoginOverAPrivateAddress() async throws {
        let s = SigningHub(host: "192.168.1.20")
        s.routes["/api/login"] = #"{"token":"tok","hub":{"name":"home"}}"#
        let r = try await s.hub.client(nil).login(password: "correct horse battery", name: "iPad", account: "  ")
        #expect(r.token == "tok")
        #expect(s.hub.requests[0].json == ["name": "iPad", "password": "correct horse battery", "platform": "ios"])
    }

    @Test func aWrongPasswordIsTheHubsOneMessage() async throws {
        let s = SigningHub(scheme: "https")
        s.hub.enqueue(#"{"error":"Wrong password."}"#, status: 401)
        do {
            _ = try await s.hub.client(nil).login(password: "nope nope nope", name: "iPad")
            Issue.record("logged in")
        } catch let e as ConclaveAPIError {
            #expect(e.status == 401)
            #expect(e.message == "Wrong password.")
        }
    }
}
