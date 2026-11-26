import Foundation

// Mirrors packages/core/src/types.ts, as packages/android/client model/Models.kt does.
// Missing fields take the Kotlin defaults; enum values a newer hub adds fall back.

public enum Role: String, WireEnum {
    case user, assistant
    public static let fallback = Role.assistant
}

public enum MessageKind: String, WireEnum {
    case normal, aside, summary, notice
    public static let fallback = MessageKind.normal
}

public struct Usage: Sendable, Hashable, Codable {
    public var inputTokens: Int64 = 0
    public var outputTokens: Int64 = 0
    public var cacheReadTokens: Int64?
    public var cacheWriteTokens: Int64?
    public var reasoningTokens: Int64?
    public var costUsd: Double?
    /// What the call is worth at API prices; more than costUsd when a plan served it.
    public var apiValueUsd: Double?
}

public struct Message: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var sessionId: String = ""
    public var seq: Int64 = 0
    public var role: Role = .assistant
    public var kind: MessageKind = .normal
    public var content: [ContentBlock] = []
    /// "provider/model" that produced an assistant message.
    public var model: String?
    public var agent: String?
    /// Display label for asides, e.g. "Juror 2".
    public var author: String?
    /// Groups messages of one jury, debate or review run.
    public var group: String?
    public var usage: Usage?
    public var stopReason: String?
    public var createdAt: Int64 = 0
    public var meta: JSONObject?

    public init(
        id: String, sessionId: String = "", seq: Int64 = 0, role: Role = .assistant, kind: MessageKind = .normal,
        content: [ContentBlock] = [], model: String? = nil, agent: String? = nil, author: String? = nil,
        group: String? = nil, usage: Usage? = nil, stopReason: String? = nil, createdAt: Int64 = 0, meta: JSONObject? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.seq = seq
        self.role = role
        self.kind = kind
        self.content = content
        self.model = model
        self.agent = agent
        self.author = author
        self.group = group
        self.usage = usage
        self.stopReason = stopReason
        self.createdAt = createdAt
        self.meta = meta
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id), sessionId: try c.or(.sessionId, ""), seq: try c.or(.seq, 0),
            role: try c.or(.role, .assistant), kind: try c.or(.kind, .normal), content: try c.or(.content, []),
            model: try c.opt(.model), agent: try c.opt(.agent), author: try c.opt(.author), group: try c.opt(.group),
            usage: try c.opt(.usage), stopReason: try c.opt(.stopReason), createdAt: try c.or(.createdAt, 0), meta: try c.opt(.meta)
        )
    }
}

extension Usage {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = try c.or(.inputTokens, 0)
        outputTokens = try c.or(.outputTokens, 0)
        cacheReadTokens = try c.opt(.cacheReadTokens)
        cacheWriteTokens = try c.opt(.cacheWriteTokens)
        reasoningTokens = try c.opt(.reasoningTokens)
        costUsd = try c.opt(.costUsd)
        apiValueUsd = try c.opt(.apiValueUsd)
    }
}

public enum SessionStatus: String, WireEnum {
    case idle, running, paused, error
    case waitingApproval = "waiting_approval"
    case waitingInput = "waiting_input"
    case waitingReset = "waiting_reset"
    public static let fallback = SessionStatus.idle
}

public enum SessionMode: String, WireEnum {
    case agent, chat, plan, jury, debate, loop
    public static let fallback = SessionMode.agent
}

public enum PermissionMode: String, WireEnum {
    case `default`, acceptEdits, plan, bypass
    public static let fallback = PermissionMode.default
}

public enum SessionKind: String, WireEnum {
    case agent, chat
    public static let fallback = SessionKind.agent
}

/// Effort for a chat or session: off or a level.
public enum ThinkingLevel: String, WireEnum {
    case off, low, medium, high, xhigh, max, ultra
    public static let fallback = ThinkingLevel.medium

    public var label: String {
        switch self {
        case .xhigh: "Extra high"
        default: rawValue.prefix(1).uppercased() + rawValue.dropFirst()
        }
    }
}

public struct SessionStats: Sendable, Hashable, Codable {
    public var messages: Int64 = 0
    public var inputTokens: Int64 = 0
    public var outputTokens: Int64 = 0
    public var cacheReadTokens: Int64 = 0
    public var cacheWriteTokens: Int64 = 0
    public var costUsd: Double = 0
    public var apiValueUsd: Double?

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = try c.or(.messages, 0)
        inputTokens = try c.or(.inputTokens, 0)
        outputTokens = try c.or(.outputTokens, 0)
        cacheReadTokens = try c.or(.cacheReadTokens, 0)
        cacheWriteTokens = try c.or(.cacheWriteTokens, 0)
        costUsd = try c.or(.costUsd, 0)
        apiValueUsd = try c.opt(.apiValueUsd)
    }
}

/// The switches under the chat composer. A missing switch is on; a nil thinking uses the agent's setting.
public struct ChatSettings: Sendable, Hashable, Codable {
    public var webSearch = true
    public var memory = true
    /// False is "Use only": memory is read, nothing is saved.
    public var memorySave: Bool?
    public var thinking: ThinkingLevel?
    public var cyber: String?
    public var sameModel = false
    public var security = false

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        webSearch = try c.or(.webSearch, true)
        memory = try c.or(.memory, true)
        memorySave = try c.opt(.memorySave)
        thinking = try c.opt(.thinking)
        cyber = try c.opt(.cyber)
        sameModel = try c.or(.sameModel, false)
        security = try c.or(.security, false)
    }
}

public struct Session: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var title = ""
    public var agent = ""
    /// Current "provider/model" for normal turns.
    public var model = ""
    public var mode: SessionMode = .agent
    public var permissionMode: PermissionMode = .default
    public var cwd = ""
    /// Device that runs tools for this session. "local" is the hub itself.
    public var device = "local"
    public var status: SessionStatus = .idle
    public var parentId: String?
    public var taskId: String?
    public var routineId: String?
    public var tags: [String] = []
    public var pinned = false
    public var archived = false
    public var createdAt: Int64 = 0
    public var updatedAt: Int64 = 0
    /// Jury, debate and loop settings; typed when the mode screens are ported.
    public var modeConfig: JSONObject?
    public var stats = SessionStats()
    /// When status is waiting_reset: epoch ms when the limit resets.
    public var resumeAt: Int64?
    public var error: String?
    public var meta: JSONObject?
    /// "chat" for a plain chat. Nil is an agent session, as all were before chats.
    public var kind: SessionKind?
    public var chat: ChatSettings?
    public var projectId: String?
    public var ultra: Bool?
    public var incognito: Bool?

    public init(id: String, title: String = "", status: SessionStatus = .idle, kind: SessionKind? = nil, parentId: String? = nil, pinned: Bool = false, updatedAt: Int64 = 0) {
        self.id = id
        self.title = title
        self.status = status
        self.kind = kind
        self.parentId = parentId
        self.pinned = pinned
        self.updatedAt = updatedAt
    }

    public var isChat: Bool { kind == .chat }
    public var isIncognito: Bool { incognito == true }

    /// The switches in force: one the owner never touched is on. Nil when this is not a chat.
    public var chatSettings: ChatSettings? { isChat ? chat ?? ChatSettings() : nil }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.or(.title, "")
        agent = try c.or(.agent, "")
        model = try c.or(.model, "")
        mode = try c.or(.mode, .agent)
        permissionMode = try c.or(.permissionMode, .default)
        cwd = try c.or(.cwd, "")
        device = try c.or(.device, "local")
        status = try c.or(.status, .idle)
        parentId = try c.opt(.parentId)
        taskId = try c.opt(.taskId)
        routineId = try c.opt(.routineId)
        tags = try c.or(.tags, [])
        pinned = try c.or(.pinned, false)
        archived = try c.or(.archived, false)
        createdAt = try c.or(.createdAt, 0)
        updatedAt = try c.or(.updatedAt, 0)
        modeConfig = try c.opt(.modeConfig)
        stats = try c.or(.stats, SessionStats())
        resumeAt = try c.opt(.resumeAt)
        error = try c.opt(.error)
        meta = try c.opt(.meta)
        kind = try c.opt(.kind)
        chat = try c.opt(.chat)
        projectId = try c.opt(.projectId)
        ultra = try c.opt(.ultra)
        incognito = try c.opt(.incognito)
    }
}

// MARK: - Approvals and questions

/// Who asks, when a subagent or a workflow agent asks.
public struct AskFrom: Sendable, Hashable, Codable {
    public var sessionId = ""
    public var agent = ""
    /// The subagent's description, or the workflow agent's label.
    public var label = ""
    public var workflow: AskWorkflow?
    /// The sessions under the top one, down to the one that asks (the asker last).
    public var chain: [String] = []

    public init(sessionId: String = "", agent: String = "", label: String = "", workflow: AskWorkflow? = nil, chain: [String] = []) {
        self.sessionId = sessionId
        self.agent = agent
        self.label = label
        self.workflow = workflow
        self.chain = chain
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(sessionId: try c.or(.sessionId, ""), agent: try c.or(.agent, ""), label: try c.or(.label, ""), workflow: try c.opt(.workflow), chain: try c.or(.chain, []))
    }
}

public struct AskWorkflow: Sendable, Hashable, Codable {
    public var runId = ""
    public var name = ""

    public init(runId: String = "", name: String = "") {
        self.runId = runId
        self.name = name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(runId: try c.or(.runId, ""), name: try c.or(.name, ""))
    }
}

/// What an approval and a question share about where they show (Asks).
public protocol Ask: Sendable {
    /// The session that asks: answering resolves it there.
    var sessionId: String { get }
    /// Its top session, the chat the owner is in. Nil from an older hub.
    var rootSessionId: String? { get }
    var from: AskFrom? { get }
}

public struct ApprovalRequest: Ask, Hashable, Codable, Identifiable {
    public var id: String
    public var sessionId = ""
    public var toolUseId = ""
    public var tool = ""
    public var input: JSONObject = [:]
    /// Human readable one-liner, e.g. "Run: rm -rf build".
    public var summary = ""
    /// Suggested rule for "always allow", e.g. "Bash(npm test:*)".
    public var suggestedRule: String?
    public var createdAt: Int64 = 0
    public var harness: String?
    /// Do not offer "always" or "for this chat".
    public var noAlways = false
    public var rootSessionId: String?
    public var from: AskFrom?

    public init(id: String, sessionId: String = "", rootSessionId: String? = nil, from: AskFrom? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.rootSessionId = rootSessionId
        self.from = from
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.or(.sessionId, "")
        toolUseId = try c.or(.toolUseId, "")
        tool = try c.or(.tool, "")
        input = try c.or(.input, [:])
        summary = try c.or(.summary, "")
        suggestedRule = try c.opt(.suggestedRule)
        createdAt = try c.or(.createdAt, 0)
        harness = try c.opt(.harness)
        noAlways = try c.or(.noAlways, false)
        rootSessionId = try c.opt(.rootSessionId)
        from = try c.opt(.from)
    }
}

/// { decision: "allow", scope?, rule? } or { decision: "deny", message? }. Nil fields are not sent.
public struct ApprovalResponse: Sendable, Hashable, Codable {
    public var decision: String
    public var scope: String?
    public var rule: String?
    public var message: String?

    public static let allowOnce = ApprovalResponse(decision: "allow", scope: "once")
    public static let allowSession = ApprovalResponse(decision: "allow", scope: "session")
    public static func allowAlways(rule: String?) -> ApprovalResponse { ApprovalResponse(decision: "allow", scope: "always", rule: rule) }
    public static func deny(_ message: String? = nil) -> ApprovalResponse { ApprovalResponse(decision: "deny", message: message) }
}

public struct QuestionOption: Sendable, Hashable, Codable {
    public var label: String
    public var description: String?
}

public struct Question: Sendable, Hashable, Codable {
    public var question: String
    public var header: String?
    public var multiSelect = false
    public var options: [QuestionOption] = []

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        header = try c.opt(.header)
        multiSelect = try c.or(.multiSelect, false)
        options = try c.or(.options, [])
    }
}

public struct QuestionRequest: Ask, Hashable, Codable, Identifiable {
    public var id: String
    public var sessionId = ""
    public var questions: [Question] = []
    public var createdAt: Int64 = 0
    public var rootSessionId: String?
    public var from: AskFrom?

    public init(id: String, sessionId: String = "", rootSessionId: String? = nil, from: AskFrom? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.rootSessionId = rootSessionId
        self.from = from
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.or(.sessionId, "")
        questions = try c.or(.questions, [])
        createdAt = try c.or(.createdAt, 0)
        rootSessionId = try c.opt(.rootSessionId)
        from = try c.opt(.from)
    }
}

public enum TodoStatus: String, WireEnum {
    case pending, completed
    case inProgress = "in_progress"
    public static let fallback = TodoStatus.pending
}

public struct Todo: Sendable, Hashable, Codable {
    public var content: String
    public var activeForm: String?
    public var status: TodoStatus = .pending

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        content = try c.decode(String.self, forKey: .content)
        activeForm = try c.opt(.activeForm)
        status = try c.or(.status, .pending)
    }
}

public struct Notice: Sendable, Hashable, Codable {
    public var id = ""
    public var title = ""
    public var body = ""
    /// info, success, warning or error
    public var level = "info"
    public var sessionId: String?
    /// Deep link path inside the app, e.g. "/s/<id>".
    public var link: String?
    public var approvalId: String?
    /// Notices of one job replace each other instead of stacking.
    public var thread: String?
    public var createdAt: Int64 = 0
    /// It passed the owner's rules: only these become system notifications.
    public var alert = false

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.or(.id, "")
        title = try c.or(.title, "")
        body = try c.or(.body, "")
        level = try c.or(.level, "info")
        sessionId = try c.opt(.sessionId)
        link = try c.opt(.link)
        approvalId = try c.opt(.approvalId)
        thread = try c.opt(.thread)
        createdAt = try c.or(.createdAt, 0)
        alert = try c.or(.alert, false)
    }
}
