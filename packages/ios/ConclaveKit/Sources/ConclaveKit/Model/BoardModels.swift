import Foundation

// Wire shapes of the board and workflow runs (core/src/types.ts Task, core/src/client/workflows.ts,
// Android model/Models.kt Task and model/Workflows.kt). Missing fields fall back, as the Kotlin client's;
// a status a newer hub adds decodes to the enum's fallback.

/// A board column. The hub's order: inbox, to do, doing, review, done.
public enum TaskStatus: String, WireEnum, Identifiable {
    case inbox, todo, doing, review, done
    public static let fallback = TaskStatus.inbox

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .inbox: "Inbox"
        case .todo: "To do"
        case .doing: "Doing"
        case .review: "Review"
        case .done: "Done"
        }
    }
}

/// One task of the board (GET /api/tasks). Named BoardTask so it never shadows Swift's Task.
public struct BoardTask: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var title = ""
    public var description = ""
    public var status: TaskStatus = .inbox
    /// 0 none, 1 low, 2 high, 3 urgent.
    public var priority = 0
    public var agent: String?
    public var project: String?
    public var due: Int64?
    public var labels: [String] = []
    public var createdAt: Int64 = 0
    public var updatedAt: Int64 = 0
    public var meta: JSONObject?

    public init(id: String, title: String = "", description: String = "", status: TaskStatus = .inbox, priority: Int = 0,
                agent: String? = nil, project: String? = nil, due: Int64? = nil, labels: [String] = [], updatedAt: Int64 = 0) {
        self.id = id
        self.title = title
        self.description = description
        self.status = status
        self.priority = priority
        self.agent = agent
        self.project = project
        self.due = due
        self.labels = labels
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.or(.title, "")
        description = try c.or(.description, "")
        status = try c.or(.status, .inbox)
        priority = (try? c.or(.priority, 0)) ?? 0
        agent = try c.opt(.agent)
        project = try c.opt(.project)
        due = try? c.opt(.due)
        labels = (try? c.or(.labels, [String]())) ?? []
        createdAt = try c.or(.createdAt, 0)
        updatedAt = try c.or(.updatedAt, 0)
        meta = try? c.opt(.meta)
    }
}

/// POST /api/tasks and PATCH /api/tasks/:id. Nil fields are left out.
public struct TaskInput: Sendable, Hashable, Encodable {
    public var title: String?
    public var description: String?
    public var status: TaskStatus?
    public var priority: Int?
    public var agent: String?
    public var project: String?

    public init(title: String? = nil, description: String? = nil, status: TaskStatus? = nil, priority: Int? = nil, agent: String? = nil, project: String? = nil) {
        self.title = title
        self.description = description
        self.status = status
        self.priority = priority
        self.agent = agent
        self.project = project
    }
}

/// POST /api/tasks/:id/start: all optional, the hub fills in the rest.
public struct StartTaskInput: Sendable, Hashable, Encodable {
    public var agent: String?
    public var model: String?
    public var device: String?
    public var cwd: String?

    public init(agent: String? = nil, model: String? = nil, device: String? = nil, cwd: String? = nil) {
        self.agent = agent
        self.model = model
        self.device = device
        self.cwd = cwd
    }
}

public enum WorkflowRunStatus: String, WireEnum {
    case queued, running, paused
    /// A usage limit: the parked calls run again at `resumeAt`.
    case waitingReset = "waiting_reset"
    /// The hub went down while it ran; Resume picks it up from the journal.
    case interrupted
    case done, failed, stopped
    /// Stopped at its budget.
    case budget
    public static let fallback = WorkflowRunStatus.queued
}

public enum WorkflowCallState: String, WireEnum {
    case queued, running, done, failed, skipped
    /// Replayed from the journal on a resume.
    case cached
    /// Waiting for a usage limit to reset.
    case parked
    public static let fallback = WorkflowCallState.queued
}

public enum WorkflowCallKind: String, WireEnum {
    case agent, check, citation, workflow, ask
    public static let fallback = WorkflowCallKind.agent
}

public struct WorkflowPhase: Sendable, Hashable, Codable {
    public var title = ""
    public var detail: String?

    public init(title: String = "", detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.or(.title, "")
        detail = try c.opt(.detail)
    }
}

public struct WorkflowCounts: Sendable, Hashable, Codable {
    public var agents = 0
    public var queued = 0
    public var running = 0
    public var done = 0
    public var cached = 0
    public var failed = 0
    public var skipped = 0
    public var parked = 0

    public init(agents: Int = 0, queued: Int = 0, running: Int = 0, done: Int = 0, cached: Int = 0, failed: Int = 0, skipped: Int = 0, parked: Int = 0) {
        self.agents = agents
        self.queued = queued
        self.running = running
        self.done = done
        self.cached = cached
        self.failed = failed
        self.skipped = skipped
        self.parked = parked
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = try c.or(.agents, 0)
        queued = try c.or(.queued, 0)
        running = try c.or(.running, 0)
        done = try c.or(.done, 0)
        cached = try c.or(.cached, 0)
        failed = try c.or(.failed, 0)
        skipped = try c.or(.skipped, 0)
        parked = try c.or(.parked, 0)
    }
}

/// One run of a workflow (GET /api/workflows/runs, newest first).
public struct WorkflowRun: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var name = ""
    public var description: String?
    public var status: WorkflowRunStatus = .queued
    /// The session that started it, if any.
    public var sessionId: String?
    public var device = "local"
    public var cwd = ""
    public var phases: [WorkflowPhase] = []
    /// Index into `phases` of the current phase, -1 before the first phase() call.
    public var phaseIndex = -1
    public var phaseTitle: String?
    public var inputTokens: Int64 = 0
    public var outputTokens: Int64 = 0
    public var costUsd: Double = 0
    public var counts = WorkflowCounts()
    public var portable = true
    public var resumeAt: Int64?
    public var error: String?
    public var createdAt: Int64 = 0
    public var startedAt: Int64?
    public var finishedAt: Int64?

    public init(id: String, name: String = "", status: WorkflowRunStatus = .queued, sessionId: String? = nil, phases: [WorkflowPhase] = [],
                phaseIndex: Int = -1, inputTokens: Int64 = 0, outputTokens: Int64 = 0, costUsd: Double = 0, counts: WorkflowCounts = WorkflowCounts(),
                createdAt: Int64 = 0, startedAt: Int64? = nil, finishedAt: Int64? = nil) {
        self.id = id
        self.name = name
        self.status = status
        self.sessionId = sessionId
        self.phases = phases
        self.phaseIndex = phaseIndex
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.costUsd = costUsd
        self.counts = counts
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, "")
        description = try c.opt(.description)
        status = try c.or(.status, .queued)
        sessionId = try c.opt(.sessionId)
        device = try c.or(.device, "local")
        cwd = try c.or(.cwd, "")
        phases = try c.or(.phases, [])
        phaseIndex = try c.or(.phaseIndex, -1)
        phaseTitle = try c.opt(.phaseTitle)
        inputTokens = try c.or(.inputTokens, 0)
        outputTokens = try c.or(.outputTokens, 0)
        costUsd = try c.or(.costUsd, 0)
        counts = try c.or(.counts, WorkflowCounts())
        portable = try c.or(.portable, true)
        resumeAt = try c.opt(.resumeAt)
        error = try c.opt(.error)
        createdAt = try c.or(.createdAt, 0)
        startedAt = try c.opt(.startedAt)
        finishedAt = try c.opt(.finishedAt)
    }
}

/// One agent, check or nested workflow of a run.
public struct WorkflowCall: Sendable, Hashable, Codable, Identifiable {
    public var seq: Int
    public var kind: WorkflowCallKind = .agent
    public var label: String?
    public var phase: String?
    public var agentType: String?
    public var model: String?
    public var state: WorkflowCallState = .queued
    public var attempt = 1
    public var childSessionId: String?
    /// The workflow() call this call ran under.
    public var parentSeq: Int?
    public var lastTool: String?
    /// "approval" while the agent waits on a tool approval.
    public var waiting: String?
    public var inputTokens: Int64 = 0
    public var outputTokens: Int64 = 0
    public var costUsd: Double = 0
    /// Why it failed or was skipped.
    public var error: String?
    public var startedAt: Int64?
    public var finishedAt: Int64?

    public var id: Int { seq }
    public var tokens: Int64 { inputTokens + outputTokens }
    public var waitingOnOwner: Bool { state == .running && waiting == "approval" }

    public init(seq: Int, kind: WorkflowCallKind = .agent, label: String? = nil, phase: String? = nil, model: String? = nil,
                state: WorkflowCallState = .queued, attempt: Int = 1, parentSeq: Int? = nil, lastTool: String? = nil, waiting: String? = nil, error: String? = nil) {
        self.seq = seq
        self.kind = kind
        self.label = label
        self.phase = phase
        self.model = model
        self.state = state
        self.attempt = attempt
        self.parentSeq = parentSeq
        self.lastTool = lastTool
        self.waiting = waiting
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        kind = try c.or(.kind, .agent)
        label = try c.opt(.label)
        phase = try c.opt(.phase)
        agentType = try c.opt(.agentType)
        model = try c.opt(.model)
        state = try c.or(.state, .queued)
        attempt = try c.or(.attempt, 1)
        childSessionId = try c.opt(.childSessionId)
        parentSeq = try c.opt(.parentSeq)
        lastTool = try c.opt(.lastTool)
        // events send false here; only the word means anything
        waiting = try? c.opt(.waiting)
        inputTokens = try c.or(.inputTokens, 0)
        outputTokens = try c.or(.outputTokens, 0)
        costUsd = try c.or(.costUsd, 0)
        error = try c.opt(.error)
        startedAt = try c.opt(.startedAt)
        finishedAt = try c.opt(.finishedAt)
    }
}

/// A line of the run's narrator log.
public struct WorkflowLogLine: Sendable, Hashable, Codable, Identifiable {
    public var n = 0
    public var ts: Int64 = 0
    public var text = ""

    public var id: Int { n }

    public init(n: Int = 0, ts: Int64 = 0, text: String = "") {
        self.n = n
        self.ts = ts
        self.text = text
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        n = try c.or(.n, 0)
        ts = try c.or(.ts, 0)
        text = try c.or(.text, "")
    }
}

/// GET /api/workflows/runs/:id. `result` is whatever the script returned: text, an object, or nothing.
/// `findings` come from a run with a finder/verifier panel; `refutedRate` is refuted over checked.
public struct WorkflowRunDetail: Sendable, Hashable, Codable {
    public var run: WorkflowRun
    public var calls: [WorkflowCall] = []
    public var logs: [WorkflowLogLine] = []
    public var result: JSONValue?
    public var findings: [WorkflowFinding] = []
    public var refutedRate: Double?

    public init(run: WorkflowRun, calls: [WorkflowCall] = [], logs: [WorkflowLogLine] = [], result: JSONValue? = nil,
                findings: [WorkflowFinding] = [], refutedRate: Double? = nil) {
        self.run = run
        self.calls = calls
        self.logs = logs
        self.result = result
        self.findings = findings
        self.refutedRate = refutedRate
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        run = try c.decode(WorkflowRun.self, forKey: .run)
        calls = try c.or(.calls, [])
        logs = try c.or(.logs, [])
        result = try? c.opt(.result)
        findings = (try? c.or(.findings, [WorkflowFinding]())) ?? []
        refutedRate = try? c.opt(.refutedRate)
    }
}
