import Foundation
import Testing
@testable import ConclaveKit

/// A scripted hub behind URLProtocol, the stand-in for OkHttp's MockWebServer in the Android
/// tests. Each hub has its own host, so tests that run in parallel never see each other's requests.
final class MockHub: @unchecked Sendable {
    struct Reply {
        var status = 200
        var body = ""
        var headers: [String: String] = [:]
    }

    struct Recorded {
        var method: String
        var url: URL
        var headers: [String: String]
        var body: Data

        var path: String { URLComponents(url: url, resolvingAgainstBaseURL: false)!.percentEncodedPath }
        func query(_ name: String) -> String? {
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
        }
        var json: JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: body) }
    }

    let base: String
    private let lock = NSLock()
    private var queue: [Reply] = []
    private var handler: ((Recorded) -> Reply)?
    private var log: [Recorded] = []

    /// `host` lets a test pick the kind of address (a public one, a private one, localhost); a
    /// random port keeps two hubs on one host apart.
    init(host: String? = nil, scheme: String = "http", path: String = "") {
        let h = host ?? "hub-\(UUID().uuidString.prefix(8).lowercased()).test"
        base = "\(scheme)://\(h):\(Int.random(in: 20000...60000))\(path)"
        MockHub.register(MockHub.key(URL(string: base)), self)
    }

    var session: URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [MockProtocol.self]
        return URLSession(configuration: c)
    }

    func client(_ token: String? = "secret-token", identity: HubIdentityGuard? = nil) -> ConclaveClient {
        ConclaveClient(baseURL: base, token: token, identity: identity, session: session)
    }

    func enqueue(_ body: String, status: Int = 200, headers: [String: String] = [:]) {
        lock.withLock { queue.append(Reply(status: status, body: body, headers: headers)) }
    }

    /// Answers every request not served by the queue.
    func dispatch(_ f: @escaping (Recorded) -> Reply) { lock.withLock { handler = f } }

    var requests: [Recorded] { lock.withLock { log } }

    func take() -> Recorded? {
        lock.withLock { log.isEmpty ? nil : log.removeFirst() }
    }

    fileprivate func answer(_ r: Recorded) -> Reply {
        lock.withLock {
            log.append(r)
            if !queue.isEmpty { return queue.removeFirst() }
            return handler?(r) ?? Reply(status: 599, body: "no reply scripted")
        }
    }

    // MARK: registry

    nonisolated(unsafe) private static var hubs: [String: MockHub] = [:]
    private static let registry = NSLock()

    private static func key(_ url: URL?) -> String { "\(url?.host?.lowercased() ?? ""):\(url?.port ?? 0)" }

    private static func register(_ key: String, _ hub: MockHub) { registry.withLock { hubs[key] = hub } }

    fileprivate static func hub(for url: URL?) -> MockHub? { registry.withLock { hubs[key(url)] } }
}

final class MockProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let hub = MockHub.hub(for: request.url) else {
            // nobody at this address: what a dead port looks like
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read) ?? Data()
        let rec = MockHub.Recorded(method: request.httpMethod ?? "GET", url: request.url!, headers: request.allHTTPHeaderFields ?? [:], body: body)
        let reply = hub.answer(rec)
        if reply.status == 599 {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let res = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ s: InputStream) -> Data {
        s.open()
        defer { s.close() }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while s.hasBytesAvailable {
            let n = s.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            out.append(buf, count: n)
        }
        return out
    }
}

func decode<T: Decodable>(_ json: String, as: T.Type = T.self) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

func encode(_ v: some Encodable) throws -> String {
    String(decoding: try Wire.encoder().encode(v), as: UTF8.self)
}

/// The same numbers for the same seed (SplitMix64), as Kotlin's Random(seed) in the ported tests.
struct SeededRandom: RandomNumberGenerator {
    private var state: UInt64
    init(_ seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// A JSON file under Tests/ConclaveKitTests/Fixtures.
func fixture(_ name: String) throws -> String {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try String(contentsOf: url, encoding: .utf8)
}
