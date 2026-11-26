import CryptoKit
import Foundation

// Hub identity (docs/design/HUB-LOGIN-AND-IDENTITY.md section 2): the app never sends its token
// to a stranger. The hub signs `conclave-hub-identity-v1\n<nonce>` with its Ed25519 key; the app
// keeps the public key next to the token and checks an address before the token goes there.

/// The address answered with another key, or a bad signature: nothing with a secret in it was sent.
public struct HubIdentityError: Error, LocalizedError, Sendable, Equatable {
    public static let notYourHub = "This address is not your hub. Conclave did not send your sign-in."
    public static let notTheCodesHub = "This address is not the hub that made the code."
    /// The hub's network refusal during the check: the app's own words, not the answering machine's.
    public static let networkRefused = "Your hub does not take connections from this network. Settings, Remote access on the hub shows the address to use."

    public var address: String
    public var message: String

    public init(address: String, message: String = notYourHub) {
        self.address = address
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// Keys, fingerprints and the signed text, the same as the hub (packages/server).
public enum HubKeys {
    public static let context = "conclave-hub-identity-v1\n"

    /// 24 random bytes as 32 base64url characters (the hub takes 16 to 128).
    public static func nonce() -> String {
        var rng = SystemRandomNumberGenerator()
        return encode(Data((0..<24).map { _ in UInt8.random(in: .min ... .max, using: &rng) }))
    }

    /// The UTF-8 text the hub signs for `nonce`.
    public static func signedText(_ nonce: String) -> Data { Data((context + nonce).utf8) }

    /// Base64url without padding.
    public static func encode(_ bytes: Data) -> String {
        bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Base64url, padding optional. Nil when it is not base64url.
    public static func decode(_ s: String) -> Data? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.contains("+"), !t.contains("/") else { return nil }
        var b = t.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let unpadded = b.replacingOccurrences(of: "=", with: "")
        guard unpadded.count % 4 != 1 else { return nil }
        b = unpadded + String(repeating: "=", count: (4 - unpadded.count % 4) % 4)
        return Data(base64Encoded: b)
    }

    /// The 32 raw key bytes, or nil when `publicKey` is not an Ed25519 key in base64url.
    public static func rawKey(_ publicKey: String?) -> Data? {
        guard let publicKey, let d = decode(publicKey), d.count == 32 else { return nil }
        return d
    }

    /// The first 16 bytes of SHA-256 of the raw key, as 32 lowercase hex characters.
    public static func fingerprint(raw: Data) -> String {
        SHA256.hash(data: raw).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    public static func fingerprint(_ publicKey: String?) -> String? { rawKey(publicKey).map { fingerprint(raw: $0) } }

    /// "21fe 31df a154 ...": groups of four, to compare with the hub's Settings.
    public static func groups(_ fingerprint: String) -> String {
        let c = Array(clean(fingerprint))
        return stride(from: 0, to: c.count, by: 4).map { String(c[$0..<min($0 + 4, c.count)]) }.joined(separator: " ")
    }

    /// The same fingerprint, whatever the case or spacing.
    public static func sameFingerprint(_ a: String?, _ b: String?) -> Bool {
        let x = a.map(clean) ?? ""
        return x.count == 32 && x == b.map(clean)
    }

    /// The same key, however it was encoded.
    public static func sameKey(_ a: String?, _ b: String?) -> Bool {
        guard let x = rawKey(a), let y = rawKey(b) else { return false }
        return x == y
    }

    /// True when `signature` (base64url) is `publicKey`'s signature of the text for `nonce`.
    public static func verify(raw publicKey: Data, nonce: String, signature: String) -> Bool {
        guard let sig = decode(signature), sig.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(sig, for: signedText(nonce))
    }

    private static func clean(_ fp: String) -> String {
        String(fp.filter { !$0.isWhitespace && $0 != ":" && $0 != "-" }).lowercased()
    }
}
