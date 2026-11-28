import Foundation

// The Map (GET /api/map, core client/map.ts; Android model/Map.kt) and the memory map
// (GET /api/memory/graph, owner only). Kinds and states stay strings.

public struct MapTool: Sendable, Hashable, Decodable {
    public var name = ""
    public var target: String?

    private enum K: String, CodingKey { case name, target }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        name = try c.or(.name, "")
        target = try? c.opt(.target)
    }
}

public struct MapNode: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    /// chat, session, subagent, workflow or agent
    public var kind = "session"
    public var title = ""
    /// running, waiting, idle, done, failed or paused
    public var state = "idle"
    public var waitingOn: String?
    public var agent: String?
    public var model: String?
    public var device = "local"
    public var cwd: String?
    public var parentId: String?
    public var runId: String?
    public var startedAt: Int64 = 0
    public var tool: MapTool?

    public init(id: String, kind: String = "session", title: String = "", state: String = "idle", device: String = "local", parentId: String? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.state = state
        self.device = device
        self.parentId = parentId
    }

    private enum K: String, CodingKey { case id, kind, title, state, waitingOn, agent, model, device, cwd, parentId, runId, startedAt, tool }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.or(.kind, "session")
        title = try c.or(.title, "")
        state = try c.or(.state, "idle")
        waitingOn = try? c.opt(.waitingOn)
        agent = try? c.opt(.agent)
        model = try? c.opt(.model)
        device = try c.or(.device, "local")
        cwd = try? c.opt(.cwd)
        parentId = try? c.opt(.parentId)
        runId = try? c.opt(.runId)
        startedAt = try c.or(.startedAt, 0)
        tool = try? c.opt(.tool)
    }
}

public struct MapDevice: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name = ""
    public var online: Bool?

    private enum K: String, CodingKey { case id, name, online }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, "")
        online = try? c.opt(.online)
    }
}

public struct MapSnapshot: Sendable, Hashable, Decodable {
    public var devices: [MapDevice] = []
    public var nodes: [MapNode] = []

    private enum K: String, CodingKey { case devices, nodes }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        devices = try c.or(.devices, [])
        nodes = try c.or(.nodes, [])
    }
}

public enum MapWords {
    /// What runs, by computer: the hub first, then devices by name; each row's work, live first.
    public static func byDevice(_ s: MapSnapshot) -> [(MapDevice?, String, [MapNode])] {
        let top = s.nodes.filter { $0.parentId == nil }
        let ids = Array(Set(top.map(\.device))).sorted { a, b in
            if a == "local" { return b != "local" }
            if b == "local" { return false }
            return name(a, s) < name(b, s)
        }
        return ids.map { d in
            let rows = top.filter { $0.device == d }.sorted { rank($0.state) != rank($1.state) ? rank($0.state) < rank($1.state) : $0.startedAt > $1.startedAt }
            return (s.devices.first { $0.id == d }, name(d, s), rows)
        }
    }

    static func name(_ id: String, _ s: MapSnapshot) -> String {
        if let d = s.devices.first(where: { $0.id == id }), !d.name.isEmpty { return d.name }
        return id == "local" ? "This hub" : id
    }

    static func rank(_ state: String) -> Int {
        switch state {
        case "running": 0
        case "waiting": 1
        case "paused": 2
        case "failed": 3
        case "idle": 4
        default: 5
        }
    }

    /// "Running bun test", "Waiting on you", "Done".
    public static func line(_ n: MapNode) -> String {
        switch n.state {
        case "running":
            if let t = n.tool { return t.target.map { "\(t.name) \($0)" } ?? t.name }
            return "Working"
        case "waiting": return n.waitingOn.map { "Waiting on \($0)" } ?? "Waiting on you"
        case "paused": return "Paused"
        case "failed": return "Failed"
        case "done": return "Done"
        default: return "Idle"
        }
    }

    /// How many subagents work under `id` now.
    public static func children(_ s: MapSnapshot, of id: String) -> Int {
        s.nodes.filter { $0.parentId == id && $0.state == "running" }.count
    }
}

public struct MemoryGraphNode: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    /// fact, profile, procedure, episode, note, tag or session
    public var kind = "note"
    public var title = ""
    public var memoryId: String?
    public var sessionId: String?
    public var area = ""
    public var degree = 0

    private enum K: String, CodingKey { case id, kind, title, memoryId, sessionId, area, degree }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.or(.kind, "note")
        title = try c.or(.title, "")
        memoryId = try? c.opt(.memoryId)
        sessionId = try? c.opt(.sessionId)
        area = try c.or(.area, "")
        degree = try c.or(.degree, 0)
    }
}

/// Every memory item once; links as [from, to, label] indexes into nodes and labels.
public struct MemoryGraph: Sendable, Hashable, Decodable {
    public var nodes: [MemoryGraphNode] = []
    public var edges: [[Int]] = []
    public var labels: [String] = []

    public init() {}

    private enum K: String, CodingKey { case nodes, edges, labels }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        nodes = try c.or(.nodes, [])
        edges = try c.or(.edges, [])
        labels = try c.or(.labels, [])
    }

    /// The links that point at real nodes, as (from, to) index pairs.
    public var links: [(Int, Int)] {
        edges.compactMap { e in
            guard e.count >= 2, nodes.indices.contains(e[0]), nodes.indices.contains(e[1]), e[0] != e[1] else { return nil }
            return (e[0], e[1])
        }
    }

    /// Rings: every item on one circle, grouped by kind so a kind is one arc; angles in radians.
    public func ringAngles() -> [Double] {
        let order = nodes.indices.sorted { a, b in nodes[a].kind != nodes[b].kind ? nodes[a].kind < nodes[b].kind : nodes[a].degree > nodes[b].degree }
        var out = [Double](repeating: 0, count: nodes.count)
        for (slot, i) in order.enumerated() { out[i] = Double(slot) / Double(max(nodes.count, 1)) * 2 * .pi }
        return out
    }

    /// The items linked to `i`, with the link's label.
    public func neighbours(_ i: Int) -> [(MemoryGraphNode, String)] {
        edges.compactMap { e in
            guard e.count >= 2 else { return nil }
            let other = e[0] == i ? e[1] : e[1] == i ? e[0] : -1
            guard nodes.indices.contains(other), other != i else { return nil }
            let label = e.count > 2 && labels.indices.contains(e[2]) ? labels[e[2]] : ""
            return (nodes[other], label)
        }
    }
}

extension ConclaveClient {
    public func map() async throws -> MapSnapshot {
        // minutes behind UTC, as JavaScript's getTimezoneOffset (Android MapWords.tzOffset)
        let mins = -TimeZone.current.secondsFromGMT() / 60
        return try await get(["api", "map"], query: [("tz", String(mins))])
    }

    public func memoryGraph() async throws -> MemoryGraph { try await get(["api", "memory", "graph"]) }
}
