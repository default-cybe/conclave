import Foundation

// The hub, pairing, password login and the identity check.
extension ConclaveClient {
    public func info() async throws -> HubInfo { try await get(["api", "info"]) }

    /// GET /api/health. Sends no token: a Conclave hub answers at this address.
    public func health() async throws -> HealthInfo { try await call("GET", ["api", "health"], auth: false) }

    /// Trade a pairing code for a token. With `fingerprint` (the QR code's fp) the address first proves
    /// it is the hub that made the code; a mismatch throws before the code is sent. The reply's
    /// identity is then the key that address proved.
    public func pair(code: String, name: String, platform: String = "ios", fingerprint: String? = nil) async throws -> PairResponse {
        let proven = try await fingerprint.asyncMap { try await proveIdentity(expectedFingerprint: $0, mismatch: HubIdentityError.notTheCodesHub) }
        var res: PairResponse = try await call("POST", ["api", "pair"], body: try Wire.encoder().encode(PairRequest(code: code, name: name, platform: platform)), auth: false)
        guard let proven else { return res }
        if let claimed = res.identity, !HubKeys.sameKey(claimed.publicKey, proven.publicKey) {
            throw HubIdentityError(address: baseURL, message: HubIdentityError.notTheCodesHub)
        }
        res.identity = proven
        return res
    }

    /// Log in with the hub's password, the backup to a pairing code. Over plain http to a public
    /// address it refuses before sending anything.
    public func login(password: String, name: String, platform: String = "ios", account: String? = nil) async throws -> PairResponse {
        guard PasswordRule.allowed(baseURL) else { throw PasswordOverHTTPError() }
        let acct = account?.trimmingCharacters(in: .whitespaces)
        let body = LoginRequest(password: password, name: name, platform: platform, account: acct?.isEmpty == false ? acct : nil)
        return try await call("POST", ["api", "login"], body: try Wire.encoder().encode(body), auth: false)
    }

    /// GET /api/identity: the hub's key and its signature of the nonce.
    public func identity(nonce: String) async throws -> IdentityProof {
        try await call("GET", ["api", "identity"], query: [("nonce", nonce)], auth: false)
    }

    /// Has the hub at this address prove its key with a fresh nonce: `expectedKey`, a key with
    /// `expectedFingerprint`, or with neither any key that signs. A stranger (wrong key, bad
    /// signature, a 4xx other than 429, an answer that is not a proof such as a captive portal)
    /// throws `HubIdentityError`. No answer throws the URLError; a 5xx or 429 stays a ConclaveAPIError.
    public func proveIdentity(expectedKey: String? = nil, expectedFingerprint: String? = nil, mismatch: String = HubIdentityError.notYourHub) async throws -> HubIdentity {
        let nonce = HubKeys.nonce()
        let stranger = HubIdentityError(address: baseURL, message: mismatch)
        let proof: IdentityProof
        do {
            proof = try await identity(nonce: nonce)
        } catch let e as ConclaveAPIError {
            // the hub's own network refusal; anything could send it, so the words are ours
            if e.status == 403, let b = e.body, b.range(of: #""code"\s*:\s*"network""#, options: .regularExpression) != nil {
                throw ConclaveAPIError(status: 403, message: HubIdentityError.networkRefused, body: b)
            }
            // a 2xx here is an empty answer: not a proof either
            if (200...499).contains(e.status) && e.status != 429 { throw stranger }
            throw e
        } catch is DecodingError {
            throw stranger
        }
        guard let raw = HubKeys.rawKey(proof.publicKey) else { throw stranger }
        let fp = HubKeys.fingerprint(raw: raw)
        guard proof.fingerprint == fp,
              expectedKey.map({ HubKeys.sameKey($0, proof.publicKey) }) ?? true,
              expectedFingerprint.map({ HubKeys.sameFingerprint($0, fp) }) ?? true,
              HubKeys.verify(raw: raw, nonce: nonce, signature: proof.signature) else { throw stranger }
        return HubIdentity(publicKey: HubKeys.encode(raw), fingerprint: fp)
    }
}

extension Optional {
    func asyncMap<U>(_ f: (Wrapped) async throws -> U) async rethrows -> U? {
        guard let self else { return nil }
        return try await f(self)
    }
}
