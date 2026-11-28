import Foundation

// Session actions: fork, rewind, and moving a session to another device or agent
// (packages/server/src/routes.ts fork, rewind, PATCH; routes-projects.ts move; Android ConclaveClient.kt).
extension ConclaveClient {
    /// A new session with this one's messages, up to and including `fromSeq` when given (all of them otherwise).
    public func forkSession(_ id: String, fromSeq: Int64? = nil) async throws -> Session {
        let body: JSONObject = fromSeq.map { ["fromSeq": .number(Double($0))] } ?? [:]
        return try await send("POST", ["api", "sessions", id, "fork"], JSONValue.object(body))
    }

    /// The hub keeps messages up to `seq` and drops the rest; `restoreFiles` undoes file changes made after it.
    public func rewind(_ id: String, seq: Int64, restoreFiles: Bool = false) async throws -> Session {
        try await send("POST", ["api", "sessions", id, "rewind"], JSONValue.object(["seq": .number(Double(seq)), "restoreFiles": .bool(restoreFiles)]))
    }

    /// Run the session on another device, in `cwd` or the folder the hub finds there. Not resolved: `line` says why.
    public func moveSession(_ id: String, device: String, cwd: String? = nil) async throws -> MoveResult {
        var body: JSONObject = ["device": .string(device)]
        if let cwd { body["cwd"] = .string(cwd) }
        return try await send("POST", ["api", "sessions", id, "move"], JSONValue.object(body))
    }

    /// GET /api/agents: the agents this account sees (routes.ts agentsFor).
    public func agents() async throws -> [AgentDef] { try await get(["api", "agents"]) }

    /// Agent, device and folder: PATCH fields SessionPatch leaves out. A new device on an agent session goes
    /// through the move's folder search and answers 409 when none was found (routes-projects.ts patchSession).
    public func updateSession(_ id: String, _ patch: SessionPlacePatch) async throws -> Session {
        try await send("PATCH", ["api", "sessions", id], JSONValue.object(patch.json))
    }
}

public struct SessionPlacePatch: Sendable, Hashable {
    public var agent: String?
    public var device: String?
    public var cwd: String?

    public init(agent: String? = nil, device: String? = nil, cwd: String? = nil) {
        self.agent = agent
        self.device = device
        self.cwd = cwd
    }

    var json: JSONObject {
        var o: JSONObject = [:]
        if let agent { o["agent"] = .string(agent) }
        if let device { o["device"] = .string(device) }
        if let cwd { o["cwd"] = .string(cwd) }
        return o
    }
}

/// POST /api/sessions/:id/move (core client/projects.ts MoveResult), the fields an app shows.
public struct MoveResult: Sendable, Hashable, Decodable {
    public var resolved = false
    /// "Moved to macbook at ~/Developer/portfolio (Syncthing)." or why it did not move.
    public var line = ""
    public var session: Session?
    /// offline, not-found or mismatch when not resolved.
    public var reason: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        resolved = try c.or(.resolved, false)
        line = try c.or(.line, "")
        session = try c.opt(.session)
        reason = try c.opt(.reason)
    }

    private enum CodingKeys: String, CodingKey { case resolved, line, session, reason }
}
