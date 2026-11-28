import Foundation

// The workflow library, its presets and a run's findings (routes-workflows.ts; Android
// client model/Workflows.kt WorkflowSummary, WorkflowPreset, WorkflowFinding).

/// One declared arg of a workflow's meta.args: "string", "number" or "boolean".
public struct WorkflowArgField: Sendable, Hashable {
    public var name: String
    public var type: String
    public var description: String?

    public init(_ name: String, type: String = "string", description: String? = nil) {
        self.name = name
        self.type = type
        self.description = description
    }
}

/// GET /api/workflows: one row of the library. `id` is the name, or plugin:name.
public struct WorkflowSummary: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var description: String
    public var whenToUse: String?
    /// builtin, project, user, plugin, claude-code or inline.
    public var source: String
    /// The declared args in the script's order; nil when it declares none (the form is a JSON box).
    public var argsSchema: [WorkflowArgField]?
    public var phases: [String]
    /// False when the script uses the Conclave layer, so it does not run in Claude Code.
    public var portable: Bool
    public var runnable: Bool
    public var error: String?
    public var lastRunAt: Int64?
    public var lastRunStatus: WorkflowRunStatus?

    public init(id: String, name: String = "", description: String = "", source: String = "user", argsSchema: [WorkflowArgField]? = nil,
                phases: [String] = [], portable: Bool = true, runnable: Bool = true, error: String? = nil, lastRunAt: Int64? = nil,
                lastRunStatus: WorkflowRunStatus? = nil) {
        self.id = id
        self.name = name.isEmpty ? id : name
        self.description = description
        self.source = source
        self.argsSchema = argsSchema
        self.phases = phases
        self.portable = portable
        self.runnable = runnable
        self.error = error
        self.lastRunAt = lastRunAt
        self.lastRunStatus = lastRunStatus
    }

    /// The web's SOURCE_HEADING, in its SOURCE_ORDER.
    public static let sourceOrder = ["builtin", "project", "user", "plugin", "claude-code", "inline"]
    public static func sourceHeading(_ s: String) -> String {
        switch s {
        case "builtin": "Built in"
        case "project": "This project"
        case "user": "Yours"
        case "plugin": "From plugins"
        case "claude-code": "From Claude Code"
        default: "Scripts"
        }
    }

    private enum CodingKeys: String, CodingKey { case id, name, description, whenToUse, source, argsSchema, phases, portable, runnable, error, lastRun }
    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }
    private struct Field: Decodable { var type: String?; var description: String? }
    private struct Phase: Decodable { var title: String? }
    private struct LastRun: Decodable { var status: String?; var createdAt: Int64?; var finishedAt: Int64? }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let n: String = try c.or(.name, "")
        name = n.isEmpty ? id : n
        description = try c.or(.description, "")
        whenToUse = try c.opt(.whenToUse)
        source = try c.or(.source, "user")
        if let s = try? c.nestedContainer(keyedBy: Key.self, forKey: .argsSchema) {
            // allKeys has no order; ConclaveClient.workflows() puts the fields back in the JSON's order (JSONKeyOrder)
            argsSchema = s.allKeys.map { k in
                let f = try? s.decode(Field.self, forKey: k)
                return WorkflowArgField(k.stringValue, type: f?.type ?? "string", description: f?.description)
            }
        }
        phases = ((try? c.or(.phases, [Phase]())) ?? []).compactMap(\.title)
        portable = (try? c.or(.portable, true)) ?? true
        runnable = try c.or(.runnable, true)
        error = try c.opt(.error)
        let last: LastRun? = try? c.opt(.lastRun)
        lastRunAt = last?.finishedAt ?? last?.createdAt
        lastRunStatus = last?.status.flatMap(WorkflowRunStatus.init(rawValue:))
    }
}

/// A saved args preset for one workflow (GET /api/workflows/:id/presets).
public struct WorkflowPreset: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var args: JSONValue?

    public init(id: String, name: String, args: JSONValue? = nil) {
        self.id = id
        self.name = name
        self.args = args
    }

    private enum CodingKeys: String, CodingKey { case id, name, args }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, "")
        args = try? c.opt(.args)
    }
}

public enum FindingVerdict: String, Sendable, Hashable, Codable, CaseIterable {
    case fixed, dismissed, ignored
}

/// One finding of a run (spec 3.18): open until it has a verdict.
public struct WorkflowFinding: Sendable, Hashable, Codable, Identifiable {
    /// "src/auth.ts:42", or the file alone.
    public var place: String? { file.map { f in line.map { "\(f):\($0)" } ?? f } }
    /// Web Findings votesWord: "2 of 3 refuters confirmed".
    public var votesWord: String? {
        guard let v = votes, !v.isEmpty else { return nil }
        return "\(v.filter { $0 == "confirmed" }.count) of \(v.count) refuters confirmed"
    }
    public var scenario: String? { data?["scenario"]?.string }
    public var quote: String? { data?["quote"]?.string }

    public var id: String
    public var title: String
    public var priority: String?
    public var file: String?
    public var line: Int?
    public var proven: Bool
    public var verdict: FindingVerdict?
    public var reason: String?
    /// The finder's extras: scenario and quote are shown.
    public var data: JSONValue?
    /// One entry per refuter: "confirmed", "refuted" or null.
    public var votes: [String?]?

    public init(id: String, title: String, priority: String? = nil, file: String? = nil, line: Int? = nil, proven: Bool = false,
                verdict: FindingVerdict? = nil, reason: String? = nil, data: JSONValue? = nil, votes: [String?]? = nil) {
        self.id = id
        self.title = title
        self.priority = priority
        self.file = file
        self.line = line
        self.proven = proven
        self.verdict = verdict
        self.reason = reason
        self.data = data
        self.votes = votes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.or(.title, "")
        priority = try? c.opt(.priority)
        file = try? c.opt(.file)
        line = try? c.opt(.line)
        proven = (try? c.or(.proven, false)) ?? false
        verdict = try? c.opt(.verdict)
        reason = try? c.opt(.reason)
        data = try? c.opt(.data)
        votes = try? c.opt(.votes)
    }
}
