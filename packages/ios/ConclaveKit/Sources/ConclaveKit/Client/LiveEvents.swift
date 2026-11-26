import Foundation

public enum ConnectionState: Sendable, Hashable {
    case connecting, open, closed
}

/// What `ConclaveClient.live` yields.
public enum LiveEvent: Sendable, Hashable {
    case status(ConnectionState)
    case event(EventEnvelope)
    /// Connected: the hub's seq now.
    case hello(seq: Int64)
    /// The hub could not replay missed events, or it restarted: refetch everything.
    case resync(seq: Int64)
    /// The hub refused the socket: 401 (token not valid there), 403 (not from this network) or 429
    /// (too many failed tries; wait `retryAfterSeconds`). The next try waits longer.
    case rejected(status: Int, message: String?, retryAfterSeconds: Int64?)
    /// The machine at `address` did not prove the hub's key: no socket, no token sent.
    case notYourHub(address: String, message: String)
}

/// The socket under `live`: URLSession in the app, a script in tests.
public protocol LiveTransport: Sendable {
    func connect(_ request: URLRequest) async throws -> any LiveConnection
}

public protocol LiveConnection: Sendable {
    func send(_ text: String) async throws
    /// The next text frame; throws once the socket is closed. A refused upgrade throws `LiveRefused`.
    func receive() async throws -> String
    func close()
}

/// The hub answered the upgrade with 401, 403 or 429.
public struct LiveRefused: Error, Sendable {
    public var status: Int
    public var message: String?
    public var retryAfterSeconds: Int64?

    public init(status: Int, message: String? = nil, retryAfterSeconds: Int64? = nil) {
        self.status = status
        self.message = message
        self.retryAfterSeconds = retryAfterSeconds
    }
}

public struct URLSessionLiveTransport: LiveTransport {
    let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func connect(_ request: URLRequest) async throws -> any LiveConnection {
        let task = session.webSocketTask(with: request)
        task.resume()
        return Connection(task: task)
    }

    // URLSessionWebSocketTask is thread safe; it predates the Sendable annotations.
    private final class Connection: LiveConnection, @unchecked Sendable {
        let task: URLSessionWebSocketTask

        init(task: URLSessionWebSocketTask) { self.task = task }

        func send(_ text: String) async throws { try await task.send(.string(text)) }

        func receive() async throws -> String {
            do {
                switch try await task.receive() {
                case .string(let s): return s
                case .data(let d): return String(decoding: d, as: UTF8.self)
                @unknown default: return ""
                }
            } catch {
                if let http = task.response as? HTTPURLResponse, [401, 403, 429].contains(http.statusCode) {
                    throw LiveRefused(status: http.statusCode, retryAfterSeconds: ConclaveClient.retryAfter(http.value(forHTTPHeaderField: "retry-after")))
                }
                throw error
            }
        }

        func close() { task.cancel(with: .normalClosure, reason: nil) }
    }
}

extension ConclaveClient {
    /// min(15 s, 500 ms * 2^attempt), as in the TypeScript client.
    public static func defaultBackoff(_ attempt: Int) -> Int64 { min(15_000, 500 << Int64(min(attempt, 10))) }

    /// Background sockets wait longer: min(60 s, 1 s * 2^attempt).
    public static func backgroundBackoff(_ attempt: Int) -> Int64 { min(60_000, 1_000 << Int64(min(attempt, 10))) }

    /// After a refusal. 429: what retry-after says. 401 and 403 do not fix themselves on a retry:
    /// one minute, doubling up to eight, never sooner than `backoff`, so an old token is not resent in a loop.
    public static func refusedWait(status: Int, retryAfterSeconds: Int64?, refusals: Int, backoff: Int64) -> Int64 {
        if status == 429, let s = retryAfterSeconds { return max(1_000, s * 1_000) }
        if status == 429 { return max(backoff, 30_000) }
        return max(backoff, 60_000 << Int64(min(refusals, 3)))
    }

    /// The socket URL. The token goes in the Authorization header only: proxies and tunnels log URLs.
    public func webSocketURL() throws -> URL {
        var c = URLComponents(url: try url(["api", "ws"]), resolvingAgainstBaseURL: false)!
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        return c.url!
    }

    /// Live events over the socket. Reconnects with backoff and replays what it missed with
    /// {"type":"since","seq":lastSeq}, as ConclaveClient.connect in TypeScript. A hub that counts
    /// from a lower seq restarted: that is a resync. Pings every `pingInterval`. Stop by ending the iteration.
    /// With `presence` (the app is on screen) it sends {"type":"presence","active":true} after each
    /// connect and in place of each ping: the hub keeps notifications quiet while the app is in use.
    public func live(
        startSeq: Int64 = 0, pingInterval: Duration = .seconds(25), presence: Bool = false,
        backoff: @escaping @Sendable (Int) -> Int64 = ConclaveClient.defaultBackoff,
        transport: any LiveTransport = URLSessionLiveTransport()
    ) -> AsyncStream<LiveEvent> {
        AsyncStream(bufferingPolicy: .unbounded) { out in
            let task = Task { await self.runLive(startSeq, pingInterval, presence, backoff, transport, out) }
            out.onTermination = { _ in task.cancel() }
        }
    }

    private func runLive(
        _ startSeq: Int64, _ pingInterval: Duration, _ presence: Bool, _ backoff: @Sendable (Int) -> Int64,
        _ transport: any LiveTransport, _ out: AsyncStream<LiveEvent>.Continuation
    ) async {
        var lastSeq = startSeq
        var attempt = 0
        var refusals = 0
        var round = 0
        func wait(_ ms: Int64) async -> Bool {
            (try? await Task.sleep(for: .milliseconds(ms))) != nil
        }
        func nextBackoff() -> Int64 {
            defer { attempt += 1 }
            return backoff(attempt)
        }
        func refused(_ status: Int, _ message: String?, _ retry: Int64?) -> Int64 {
            out.yield(.rejected(status: status, message: message, retryAfterSeconds: retry))
            defer { refusals += 1 }
            return Self.refusedWait(status: status, retryAfterSeconds: retry, refusals: refusals, backoff: nextBackoff())
        }

        while !Task.isCancelled {
            out.yield(.status(.connecting))
            if let identity, token != nil {
                // a reconnect checks the address again: another machine may answer there now
                if round > 0 { await identity.forget(baseURL) }
                round += 1
                do {
                    try await identity.ensure(self)
                } catch {
                    if Task.isCancelled { break }
                    out.yield(.status(.closed))
                    let ms: Int64
                    switch error {
                    case let e as HubIdentityError:
                        out.yield(.notYourHub(address: e.address, message: e.message))
                        ms = nextBackoff()
                    case let e as ConclaveAPIError where e.status == 429:
                        ms = refused(429, e.message.isEmpty ? nil : e.message, e.retryAfterSeconds)
                    default:
                        // no answer, or the hub's own trouble: offline, not a stranger
                        ms = nextBackoff()
                    }
                    guard await wait(ms) else { break }
                    continue
                }
            }

            var req: URLRequest
            do { req = URLRequest(url: try webSocketURL()) } catch { break }
            if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

            var refusal: LiveRefused?
            do {
                let conn = try await transport.connect(req)
                try await withTaskCancellationHandler {
                    // the hub's hello is the first frame: the socket is open once it came
                    let first = try await conn.receive()
                    attempt = 0
                    refusals = 0
                    out.yield(.status(.open))
                    if lastSeq > 0 { try await conn.send(#"{"type":"since","seq":\#(lastSeq)}"#) }
                    let ping = presence ? Self.presenceFrame : #"{"type":"ping"}"#
                    if presence { try await conn.send(ping) }
                    let pinger = Task {
                        while true {
                            guard (try? await Task.sleep(for: pingInterval)) != nil else { return }
                            try? await conn.send(ping)
                        }
                    }
                    defer { pinger.cancel() }
                    var text = first
                    while true {
                        Self.handle(Frame.parse(text), &lastSeq, out)
                        text = try await conn.receive()
                    }
                } onCancel: {
                    conn.close()
                }
            } catch let e as LiveRefused {
                refusal = e
            } catch {}
            if Task.isCancelled { break }
            out.yield(.status(.closed))
            let ms = refusal.map { refused($0.status, $0.message, $0.retryAfterSeconds) } ?? nextBackoff()
            guard await wait(ms) else { break }
        }
        out.finish()
    }

    static let presenceFrame = #"{"type":"presence","active":true}"#

    static func handle(_ frame: Frame, _ lastSeq: inout Int64, _ out: AsyncStream<LiveEvent>.Continuation) {
        switch frame {
        case .hello(let seq):
            // the hub restarted and counts from 0 again: replay cannot cover the gap
            if seq < lastSeq {
                lastSeq = seq
                out.yield(.resync(seq: seq))
            } else if lastSeq == 0 {
                lastSeq = seq
            }
            out.yield(.hello(seq: seq))
        case .resync(let seq):
            lastSeq = seq
            out.yield(.resync(seq: seq))
        case .event(let env):
            lastSeq = max(lastSeq, env.seq)
            out.yield(.event(env))
        case .pong, .malformed:
            break
        }
    }
}
