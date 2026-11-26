import Foundation
import Testing
@testable import ConclaveKit

// Port of the socket half of ClientTest.kt and IdentityTest.kt: reconnect, replay, resync, refusal.

/// Each connect plays the next script: frames to deliver, then the socket drops (or the upgrade is refused).
final class ScriptedTransport: LiveTransport, @unchecked Sendable {
    enum Round {
        case frames([String])
        case refused(Int, retryAfter: Int64?)
    }

    private let lock = NSLock()
    private var rounds: [Round]
    private(set) var sent: [[String]] = []
    private(set) var requests: [URLRequest] = []

    init(_ rounds: [Round]) { self.rounds = rounds }

    var sentFrames: [[String]] { lock.withLock { sent } }
    var connects: [URLRequest] { lock.withLock { requests } }

    func connect(_ request: URLRequest) async throws -> any LiveConnection {
        let (round, index): (Round?, Int) = lock.withLock {
            requests.append(request)
            sent.append([])
            return (rounds.isEmpty ? nil : rounds.removeFirst(), sent.count - 1)
        }
        guard let round else {
            // the script is over: hold the socket open until the test stops
            return Conn(frames: [], hold: true, record: { _ in })
        }
        switch round {
        case .refused(let status, let retry): throw LiveRefused(status: status, retryAfterSeconds: retry)
        case .frames(let f): return Conn(frames: f, hold: false) { [self] t in lock.withLock { sent[index].append(t) } }
        }
    }

    final class Conn: LiveConnection, @unchecked Sendable {
        private var frames: [String]
        private let hold: Bool
        private let record: @Sendable (String) -> Void
        private let lock = NSLock()

        init(frames: [String], hold: Bool, record: @escaping @Sendable (String) -> Void) {
            self.frames = frames
            self.hold = hold
            self.record = record
        }

        func send(_ text: String) async throws { record(text) }

        func receive() async throws -> String {
            // let the client's sends land before the next frame, as on a real socket
            try await Task.sleep(for: .milliseconds(5))
            if let f = lock.withLock({ frames.isEmpty ? nil : frames.removeFirst() }) { return f }
            if hold { try await Task.sleep(for: .seconds(3600)) }
            throw URLError(.networkConnectionLost)
        }

        func close() {}
    }
}

struct LiveTests {
    private func collect(_ stream: AsyncStream<LiveEvent>, until done: (LiveEvent) -> Bool) async -> [LiveEvent] {
        var out: [LiveEvent] = []
        for await e in stream {
            out.append(e)
            if done(e) { break }
        }
        return out
    }

    private func seqs(_ events: [LiveEvent]) -> [Int64] {
        events.compactMap { if case .event(let e) = $0 { e.seq } else { nil } }
    }

    private func ev(_ seq: Int64) -> String { #"{"type":"session.deleted","sessionId":"s\#(seq)","seq":\#(seq),"ts":1}"# }

    @Test func reconnectsAndReplaysSinceLastSeq() async throws {
        let t = ScriptedTransport([
            .frames([#"{"type":"hello","seq":10}"#, ev(11), ev(12)]),
            .frames([#"{"type":"hello","seq":15}"#, ev(13), ev(14), ev(15)]),
        ])
        let c = ConclaveClient(baseURL: "http://192.168.1.5:7777", token: "secret-token")
        let events = await collect(c.live(backoff: { _ in 1 }, transport: t)) { if case .event(let e) = $0 { e.seq == 15 } else { false } }
        #expect(seqs(events) == [11, 12, 13, 14, 15])
        // the first socket starts from the hub's seq; the second asks for what came after 12
        #expect(t.sentFrames[0].isEmpty)
        #expect(t.sentFrames[1] == [#"{"type":"since","seq":12}"#])
        #expect(events.contains(.status(.closed)))
        // the token rides in the header, never the URL
        #expect(t.connects[0].value(forHTTPHeaderField: "Authorization") == "Bearer secret-token")
        #expect(t.connects[0].url?.absoluteString == "ws://192.168.1.5:7777/api/ws")
    }

    @Test func startsWithKnownSeq() async throws {
        let t = ScriptedTransport([.frames([#"{"type":"hello","seq":50}"#, ev(41)])])
        let c = ConclaveClient(baseURL: "http://localhost:7777", token: "t")
        let events = await collect(c.live(startSeq: 40, backoff: { _ in 1 }, transport: t)) { if case .event = $0 { true } else { false } }
        #expect(seqs(events) == [41])
        #expect(t.sentFrames[0] == [#"{"type":"since","seq":40}"#])
    }

    @Test func presenceAfterEachConnectAndInPlaceOfPings() async throws {
        let t = ScriptedTransport([.frames([#"{"type":"hello","seq":5}"#]), .frames([#"{"type":"hello","seq":5}"#, ev(6)])])
        let c = ConclaveClient(baseURL: "http://localhost:7777", token: "t")
        _ = await collect(c.live(presence: true, backoff: { _ in 1 }, transport: t)) { if case .event = $0 { true } else { false } }
        #expect(t.sentFrames[0] == [#"{"type":"presence","active":true}"#])
        #expect(t.sentFrames[1] == [#"{"type":"since","seq":5}"#, #"{"type":"presence","active":true}"#])
    }

    @Test func aRestartedHubMeansResync() async throws {
        let t = ScriptedTransport([
            .frames([#"{"type":"hello","seq":30}"#, ev(31)]),
            // the hub restarted and counts from 2: the gap cannot be replayed
            .frames([#"{"type":"hello","seq":2}"#, ev(3)]),
        ])
        let c = ConclaveClient(baseURL: "http://localhost:7777", token: "t")
        let events = await collect(c.live(backoff: { _ in 1 }, transport: t)) { if case .event(let e) = $0 { e.seq == 3 } else { false } }
        #expect(events.contains(.resync(seq: 2)))
        #expect(seqs(events) == [31, 3])
    }

    @Test func aRefusedSocketSaysSoAndWaits() async throws {
        let t = ScriptedTransport([.refused(429, retryAfter: 0), .frames([#"{"type":"hello","seq":1}"#])])
        let c = ConclaveClient(baseURL: "http://localhost:7777", token: "t")
        let events = await collect(c.live(backoff: { _ in 1 }, transport: t)) { $0 == .hello(seq: 1) }
        #expect(events.contains(.rejected(status: 429, message: nil, retryAfterSeconds: 0)))
        #expect(t.connects.count == 2)
    }

    @Test func theSocketNeverOpensToAnotherKey() async throws {
        let s = SigningHub()
        s.key = .init()
        let t = ScriptedTransport([])
        let c = ConclaveClient(baseURL: s.hub.base, token: "t", identity: HubIdentityGuard(pinnedKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"), session: s.hub.session)
        let events = await collect(c.live(backoff: { _ in 1 }, transport: t)) { if case .notYourHub = $0 { true } else { false } }
        #expect(events.last == .notYourHub(address: s.hub.base, message: HubIdentityError.notYourHub))
        #expect(t.connects.isEmpty)
    }

    @Test func theSocketChecksAgainAfterEachReconnect() async throws {
        let s = SigningHub()
        let t = ScriptedTransport([.frames([#"{"type":"hello","seq":1}"#]), .frames([#"{"type":"hello","seq":1}"#])])
        let c = ConclaveClient(baseURL: s.hub.base, token: "t", identity: HubIdentityGuard(pinnedKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"), session: s.hub.session)
        var hellos = 0
        _ = await collect(c.live(backoff: { _ in 1 }, transport: t)) { if case .hello = $0 { hellos += 1 }; return hellos == 2 }
        #expect(s.paths == ["/api/identity", "/api/identity"])
    }
}
