import Foundation
import Synchronization

// What the app tells the hub's log files about itself (docs/DESIGN.md 33), as
// packages/web/src/lib/clientLog.ts and the Android client's ClientLogs.kt: the start,
// socket state, failed requests with their status and folded path, decode failures and
// errors the app reports. Batches go to POST /api/logs/client. Only event names, statuses,
// paths with their ids folded and short error messages go, never text from a chat.

/// One thing the app reports about itself.
public struct ClientLogEvent: Sendable, Hashable, Codable {
    public var ts: Int64?
    /// debug, info, warn or error.
    public var level: String
    /// A short name: app.start, socket.closed, request.failed...
    public var event: String
    /// A short error message.
    public var msg: String?
    /// Small flat facts: status, path, attempt.
    public var fields: [String: JSONValue]?
}

public struct ClientLogBatch: Sendable, Encodable {
    /// "ios".
    public var app: String
    public var version: String?
    /// "iPadOS 18.6".
    public var platform: String?
    public var events: [ClientLogEvent]
}

extension ConclaveClient {
    /// POST /api/logs/client.
    public func sendClientLogs(_ batch: ClientLogBatch) async throws {
        try await sendUnit("POST", ["api", "logs", "client"], batch)
    }
}

/// Events wait here and go in batches: every 30 s, soon after 20 wait, or on `flush()` (the
/// app goes to the background). At most 200 wait and 60 are taken a minute; the same event
/// again within 10 s counts on the one before. A hub without the route (404) stops the
/// sending for this run; offline, 401, 429 and 5xx keep the events for the next try; another
/// 4xx drops the batch.
public final class LogBatcher: Sendable {
    struct State {
        var queue: [ClientLogEvent] = []
        var minute: Int64 = 0
        var inMinute = 0
        var dropped = 0
        var off = false
        var sending = false
    }

    public static let sameWithinMs: Int64 = 10_000
    let app: String
    let version: String?
    let platform: String?
    let maxQueue: Int
    let perMinute: Int
    let batchSize: Int
    let soonAt: Int
    private let clock: @Sendable () -> Int64
    private let send: @Sendable (ClientLogBatch) async throws -> Void
    private let state = Mutex(State())

    public init(
        app: String = "ios", version: String? = nil, platform: String? = nil, maxQueue: Int = 200, perMinute: Int = 60,
        batchSize: Int = 50, soonAt: Int = 20, clock: @escaping @Sendable () -> Int64 = nowMs,
        send: @escaping @Sendable (ClientLogBatch) async throws -> Void
    ) {
        self.app = app
        self.version = version
        self.platform = platform
        self.maxQueue = maxQueue
        self.perMinute = perMinute
        self.batchSize = batchSize
        self.soonAt = soonAt
        self.clock = clock
        self.send = send
    }

    public var pending: Int { state.withLock { $0.queue.count } }
    public var isOff: Bool { state.withLock { $0.off } }

    /// Report one event. Never throws. True when enough wait that a flush should go soon.
    @discardableResult
    public func log(_ level: String, _ event: String, _ fields: [String: JSONValue] = [:], msg: String? = nil) -> Bool {
        let now = clock()
        let text = msg.map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }.map { String($0.prefix(240)) }.flatMap { $0.isEmpty ? nil : $0 }
        let flat = Self.flat(fields)
        return state.withLock { s in
            if s.off { return false }
            if let last = s.queue.last, last.event == event, last.msg == text, now - (last.ts ?? 0) < Self.sameWithinMs {
                var f = last.fields ?? [:]
                let n = if case .number(let r)? = f["repeats"] { r } else { 1.0 }
                f["repeats"] = .number(n + 1)
                s.queue[s.queue.count - 1].fields = f
                return false
            }
            let m = now / 60_000
            if m != s.minute { s.minute = m; s.inMinute = 0 }
            if s.inMinute >= perMinute || s.queue.count >= maxQueue { s.dropped += 1; return false }
            s.inMinute += 1
            s.queue.append(ClientLogEvent(ts: now, level: level, event: String(event.prefix(64)), msg: text, fields: flat))
            return s.queue.count == soonAt
        }
    }

    /// Send what waits, one batch. True when it went (or there was nothing).
    @discardableResult
    public func flush() async -> Bool {
        let batch: [ClientLogEvent]? = state.withLock { s in
            if s.off || s.sending { return nil }
            if s.dropped > 0 {
                s.queue.append(ClientLogEvent(ts: clock(), level: "warn", event: "log.dropped", fields: ["dropped": .number(Double(s.dropped))]))
                s.dropped = 0
            }
            if s.queue.isEmpty { return [] }
            s.sending = true
            return Array(s.queue.prefix(batchSize))
        }
        guard let batch else { return false }
        if batch.isEmpty { return true }
        do {
            try await send(ClientLogBatch(app: app, version: version, platform: platform, events: batch))
            state.withLock { s in s.queue.removeFirst(min(batch.count, s.queue.count)); s.sending = false }
            return true
        } catch let e as ConclaveAPIError {
            state.withLock { s in
                if e.status == 404 {
                    // a hub from before logs: nothing to send to
                    s.off = true
                    s.queue = []
                } else if (400..<500).contains(e.status), e.status != 401, e.status != 429 {
                    s.queue.removeFirst(min(batch.count, s.queue.count))
                }
                s.sending = false
            }
            return false
        } catch {
            // offline: keep them for the next try
            state.withLock { $0.sending = false }
            return false
        }
    }

    /// At most 12 fields, keys 40 characters, strings 200.
    static func flat(_ fields: [String: JSONValue]) -> [String: JSONValue]? {
        if fields.isEmpty { return nil }
        var out: [String: JSONValue] = [:]
        for k in fields.keys.sorted() {
            if out.count >= 12 { break }
            switch fields[k]! {
            case .string(let s): out[String(k.prefix(40))] = .string(String(s.prefix(200)))
            case .number, .bool, .null: out[String(k.prefix(40))] = fields[k]!
            default: continue
            }
        }
        return out
    }
}

/// The app's one batcher. The client reports failed calls to it; the app starts it once
/// (HubModel) and sets the sender to whichever hub is paired.
public enum ClientLogs {
    private static let current = Mutex<LogBatcher?>(nil)

    public static var batcher: LogBatcher? {
        get { current.withLock { $0 } }
        set { current.withLock { $0 = newValue } }
    }

    /// Report one event; a no-op before `batcher` is set. A full queue asks for a flush soon.
    public static func log(_ level: String, _ event: String, _ fields: [String: JSONValue] = [:], msg: String? = nil) {
        guard let b = batcher else { return }
        if b.log(level, event, fields, msg: msg) {
            Task { try? await Task.sleep(for: .seconds(1)); await b.flush() }
        }
    }

    /// A failed call: method, folded path and status (0: no answer). The logs route itself is left out.
    public static func requestFailed(_ method: String, _ segments: [String], status: Int, msg: String?) {
        if Array(segments.prefix(3)) == ["api", "logs", "client"] { return }
        let level = status == 0 || status >= 500 || status == 401 || status == 403 ? "warn" : "info"
        log(level, "request.failed", ["method": .string(method), "path": .string(foldPath(segments)), "status": .number(Double(status))], msg: msg)
    }

    /// A reply that came but did not read as the type the app expects: the hub and the app disagree.
    public static func decodeFailed(_ segments: [String], _ error: Error) {
        log("error", "decode.failed", ["path": .string(foldPath(segments)), "type": .string(String(describing: type(of: error)))], msg: describe(error))
    }

    /// /api/sessions/ses_0abc12/messages -> /api/sessions/:id/messages
    public static func foldPath(_ segments: [String]) -> String {
        let folded = segments.map { seg -> String in
            let id = seg.range(of: #"^[a-z]{1,8}_[A-Za-z0-9]{6,}$"#, options: .regularExpression) != nil
            let uuid = seg.range(of: #"^[0-9a-fA-F-]{16,}$"#, options: .regularExpression) != nil
            return id || uuid || (seg.count > 24 && seg.contains(where: \.isNumber)) ? ":id" : seg
        }
        return String(("/" + folded.joined(separator: "/")).prefix(160))
    }

    /// A short message for an error: a DecodingError names the key path, not the value.
    public static func describe(_ error: Error) -> String {
        switch error {
        case DecodingError.keyNotFound(let k, let c): "missing \(path(c.codingPath + [k]))"
        case DecodingError.typeMismatch(let t, let c): "type mismatch at \(path(c.codingPath)), wanted \(t)"
        case DecodingError.valueNotFound(let t, let c): "null at \(path(c.codingPath)), wanted \(t)"
        case DecodingError.dataCorrupted(let c): "bad data at \(path(c.codingPath))"
        case let e as ConclaveAPIError: e.message
        case let e as URLError: "URLError \(e.code.rawValue)"
        default: error.localizedDescription
        }
    }

    private static func path(_ keys: [any CodingKey]) -> String {
        keys.isEmpty ? "the top" : keys.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
    }
}
