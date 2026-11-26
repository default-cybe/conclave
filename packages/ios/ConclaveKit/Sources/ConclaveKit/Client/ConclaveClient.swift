import Foundation

/// A non-2xx reply from the hub. `message` is the hub's "error" field when there is one;
/// `retryAfterSeconds` comes from the retry-after header (a 429 after too many failed tries).
public struct ConclaveAPIError: Error, LocalizedError, Sendable, Equatable {
    public var status: Int
    public var message: String
    public var body: String?
    public var retryAfterSeconds: Int64?

    public init(status: Int, message: String, body: String? = nil, retryAfterSeconds: Int64? = nil) {
        self.status = status
        self.message = message
        self.body = body
        self.retryAfterSeconds = retryAfterSeconds
    }

    public var errorDescription: String? { message }
}

/// Typed REST client for the hub (packages/core/src/client/index.ts, Android ConclaveClient.kt).
/// The token only ever goes in the Authorization header and is never logged. With `identity`,
/// the hub at `baseURL` proves its key before anything carrying the token goes there.
public final class ConclaveClient: Sendable {
    public let baseURL: String
    public let token: String?
    public let identity: HubIdentityGuard?
    let session: URLSession

    public init(baseURL: String, token: String? = nil, identity: HubIdentityGuard? = nil, session: URLSession = .shared) {
        var s = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        self.baseURL = s
        self.token = token
        self.identity = identity
        self.session = session
    }

    // MARK: - Plumbing

    private static let pathAllowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/;"))
    // a "+" left as is reads as a space on the hub (URLSearchParams)
    private static let queryAllowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&=#"))

    /// The hub URL for `segments`, each path-encoded; nil and empty query values are left out.
    func url(_ segments: [String], _ query: [(String, String?)] = []) throws -> URL {
        guard var c = URLComponents(string: baseURL), c.host != nil else { throw URLError(.badURL) }
        let prefix = c.percentEncodedPath.hasSuffix("/") ? String(c.percentEncodedPath.dropLast()) : c.percentEncodedPath
        c.percentEncodedPath = prefix + "/" + segments.map { $0.addingPercentEncoding(withAllowedCharacters: Self.pathAllowed) ?? $0 }.joined(separator: "/")
        let items = query.compactMap { k, v -> String? in
            guard let v, !v.isEmpty else { return nil }
            let enc = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: Self.queryAllowed) ?? s }
            return enc(k) + "=" + enc(v)
        }
        c.percentEncodedQuery = items.isEmpty ? nil : items.joined(separator: "&")
        guard let u = c.url else { throw URLError(.badURL) }
        return u
    }

    /// Sends one request and returns the body of a 2xx reply. With `auth` false the call carries
    /// no token and needs no identity check (pairing, health, identity).
    func request(_ method: String, _ segments: [String], query: [(String, String?)] = [], body: Data? = nil, auth: Bool = true) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: try url(segments, query))
        req.httpMethod = method
        if auth, let token {
            // the token goes only to an address that proved the hub's key
            try await identity?.ensure(self)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if ["POST", "PUT", "PATCH"].contains(method) {
            req.httpBody = Data()
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let text = String(decoding: data, as: UTF8.self)
            throw ConclaveAPIError(
                status: http.statusCode, message: Self.errorMessage(text) ?? "HTTP \(http.statusCode)", body: text,
                retryAfterSeconds: Self.retryAfter(http.value(forHTTPHeaderField: "retry-after"))
            )
        }
        return (data, http)
    }

    func call<T: Decodable>(_ method: String, _ segments: [String], query: [(String, String?)] = [], body: Data? = nil, auth: Bool = true) async throws -> T {
        let (data, http) = try await request(method, segments, query: query, body: body, auth: auth)
        if data.allSatisfy({ $0 == 0x20 || $0 == 0x0A || $0 == 0x0D || $0 == 0x09 }) {
            throw ConclaveAPIError(status: http.statusCode, message: "Empty response", body: "")
        }
        return try Wire.decoder().decode(T.self, from: data)
    }

    func get<T: Decodable>(_ segments: [String], query: [(String, String?)] = []) async throws -> T {
        try await call("GET", segments, query: query)
    }

    func send<T: Decodable>(_ method: String, _ segments: [String], _ body: some Encodable) async throws -> T {
        try await call(method, segments, body: try Wire.encoder().encode(body))
    }

    /// For routes that answer { ok: true }: the body is not read.
    func sendUnit(_ method: String, _ segments: [String], _ body: (any Encodable)? = nil) async throws {
        _ = try await request(method, segments, body: try body.map { try Wire.encoder().encode($0) })
    }

    static func errorMessage(_ text: String) -> String? {
        if let v = try? Wire.decoder().decode(JSONValue.self, from: Data(text.utf8)) {
            return v["error"]?.string
        }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && text.count < 300 ? text : nil
    }

    /// The retry-after header in seconds (the hub sends seconds, never a date).
    static func retryAfter(_ header: String?) -> Int64? {
        guard let n = header.flatMap({ Int64($0.trimmingCharacters(in: .whitespaces)) }), n >= 0 else { return nil }
        return n
    }
}
