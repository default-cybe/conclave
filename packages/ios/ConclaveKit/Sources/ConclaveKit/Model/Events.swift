import Foundation

/// Live events from the hub (EngineEvent in packages/core/src/types.ts). The transcript and the
/// lists need the ones typed here; every other type is `.other` with its name, and later phases
/// type them as their screens need them (Android model/Events.kt has them all).
public enum EngineEvent: Sendable, Hashable {
    case sessionCreated(Session)
    case sessionUpdated(Session)
    case sessionDeleted(sessionId: String)
    case messageCreated(Message)
    case messageUpdated(Message)
    case messageDeleted(sessionId: String, messageId: String)
    case messageDelta(MessageDelta)
    case toolStarted(sessionId: String, messageId: String, toolUseId: String, name: String, input: JSONObject)
    case toolProgress(sessionId: String, toolUseId: String, text: String)
    case toolCompleted(sessionId: String, toolUseId: String, result: ToolResultBlock)
    case approvalRequested(ApprovalRequest)
    case approvalResolved(id: String, sessionId: String)
    case questionAsked(QuestionRequest)
    case questionAnswered(id: String, sessionId: String)
    case todoUpdated(sessionId: String, todos: [Todo])
    case sessionQueue(sessionId: String, queue: [QueuedMessage])
    case notice(Notice)
    case taskDeleted(taskId: String)
    case other(type: String)

    /// The session an event belongs to, for routing; nil for hub-wide events.
    public var sessionKey: String? {
        switch self {
        case .sessionCreated(let s), .sessionUpdated(let s): s.id
        case .sessionDeleted(let id): id
        case .messageCreated(let m), .messageUpdated(let m): m.sessionId
        case .messageDeleted(let id, _), .toolStarted(let id, _, _, _, _), .toolProgress(let id, _, _),
             .toolCompleted(let id, _, _), .todoUpdated(let id, _), .sessionQueue(let id, _): id
        case .messageDelta(let d): d.sessionId
        case .approvalRequested(let a): a.sessionId
        case .questionAsked(let q): q.sessionId
        case .approvalResolved(_, let id), .questionAnswered(_, let id): id.isEmpty ? nil : id
        case .notice(let n): n.sessionId
        case .taskDeleted, .other: nil
        }
    }

    public var isAsk: Bool {
        switch self {
        case .approvalRequested, .approvalResolved, .questionAsked, .questionAnswered: true
        default: false
        }
    }
}

public enum DeltaKind: String, WireEnum {
    case text, thinking
    case toolInput = "tool_input"
    public static let fallback = DeltaKind.text
}

public struct MessageDelta: Sendable, Hashable, Codable {
    public var sessionId: String
    public var messageId: String
    public var index = 0
    public var kind: DeltaKind = .text
    public var text = ""

    public init(sessionId: String, messageId: String, index: Int = 0, kind: DeltaKind = .text, text: String = "") {
        self.sessionId = sessionId
        self.messageId = messageId
        self.index = index
        self.kind = kind
        self.text = text
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            sessionId: try c.decode(String.self, forKey: .sessionId), messageId: try c.decode(String.self, forKey: .messageId),
            index: try c.or(.index, 0), kind: try c.or(.kind, .text), text: try c.or(.text, "")
        )
    }
}

/// The event plus the hub's sequence number and timestamp. `type` stays for logging unknown ones.
public struct EventEnvelope: Sendable, Hashable {
    public var seq: Int64
    public var ts: Int64
    public var type: String
    public var event: EngineEvent
}

/// One text frame from /api/ws.
public enum Frame: Sendable, Hashable {
    /// First frame after connecting: the hub's current seq.
    case hello(seq: Int64)
    /// The hub could not replay from our seq: refetch everything.
    case resync(seq: Int64)
    case pong
    case event(EventEnvelope)
    case malformed

    public static func parse(_ text: String) -> Frame {
        guard let data = text.data(using: .utf8),
              let obj = try? Wire.decoder().decode(JSONValue.self, from: data).object,
              let type = obj["type"]?.string else { return .malformed }
        let seq = obj["seq"]?.number.map { Int64($0) } ?? 0
        switch type {
        case "hello": return .hello(seq: seq)
        case "resync": return .resync(seq: seq)
        case "pong": return .pong
        default:
            let ts = obj["ts"]?.number.map { Int64($0) } ?? 0
            // a known event with a bad body is still an event, as on Android: it decodes to other
            let event: EngineEvent
            do {
                event = try decodeEvent(type, data)
            } catch {
                // a body the app cannot read for an event it knows: the hub's log hears of it
                ClientLogs.decodeFailed(["event", type], error)
                event = .other(type: type)
            }
            return .event(EventEnvelope(seq: seq, ts: ts, type: type, event: event))
        }
    }

    private struct Fields: Decodable {
        var session: Session?
        var message: Message?
        var approval: ApprovalRequest?
        var question: QuestionRequest?
        var notice: Notice?
        var result: ToolResultBlock?
        var sessionId: String?
        var messageId: String?
        var toolUseId: String?
        var taskId: String?
        var id: String?
        var name: String?
        var text: String?
        var input: JSONObject?
        var todos: [Todo]?
        var queue: [QueuedMessage]?
    }

    private struct Missing: Error {}

    private static func decodeEvent(_ type: String, _ data: Data) throws -> EngineEvent {
        let d = Wire.decoder()
        let f = try d.decode(Fields.self, from: data)
        func need<T>(_ v: T?) throws -> T {
            guard let v else { throw Missing() }
            return v
        }
        switch type {
        case "session.created": return .sessionCreated(try need(f.session))
        case "session.updated": return .sessionUpdated(try need(f.session))
        case "session.deleted": return .sessionDeleted(sessionId: try need(f.sessionId))
        case "message.created": return .messageCreated(try need(f.message))
        case "message.updated": return .messageUpdated(try need(f.message))
        case "message.deleted": return .messageDeleted(sessionId: try need(f.sessionId), messageId: try need(f.messageId))
        case "message.delta": return .messageDelta(try d.decode(MessageDelta.self, from: data))
        case "tool.started":
            return .toolStarted(sessionId: try need(f.sessionId), messageId: f.messageId ?? "", toolUseId: try need(f.toolUseId), name: f.name ?? "", input: f.input ?? [:])
        case "tool.progress": return .toolProgress(sessionId: try need(f.sessionId), toolUseId: try need(f.toolUseId), text: f.text ?? "")
        case "tool.completed": return .toolCompleted(sessionId: try need(f.sessionId), toolUseId: try need(f.toolUseId), result: try need(f.result))
        case "approval.requested": return .approvalRequested(try need(f.approval))
        case "approval.resolved": return .approvalResolved(id: try need(f.id), sessionId: f.sessionId ?? "")
        case "question.asked": return .questionAsked(try need(f.question))
        case "question.answered": return .questionAnswered(id: try need(f.id), sessionId: f.sessionId ?? "")
        case "todo.updated": return .todoUpdated(sessionId: try need(f.sessionId), todos: f.todos ?? [])
        case "session.queue": return .sessionQueue(sessionId: try need(f.sessionId), queue: f.queue ?? [])
        case "notice": return .notice(try need(f.notice))
        case "task.deleted": return .taskDeleted(taskId: try need(f.taskId))
        default: return .other(type: type)
        }
    }
}
