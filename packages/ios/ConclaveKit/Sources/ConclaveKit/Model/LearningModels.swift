import Foundation

/// Reflect's Learnings (core client/learnings.ts): corrections, preferences, "remember: ..." and
/// praise caught from what you typed, waiting for Save or Skip. Nothing is written until Save.
public struct Learning: Sendable, Hashable, Decodable, Identifiable {
    public struct Target: Sendable, Hashable, Decodable {
        /// memory, agent, project or skill
        public var target: String
        public var label: String
        public var ref: String?
        public var refused: String?
    }

    public var id: String
    /// correction, preference, remember or positive
    public var kind: String
    /// The memory text, in third person.
    public var fact: String
    /// The instruction text for an agent, project or skill file.
    public var rule: String
    /// What you typed, exactly.
    public var quote: String
    public var count: Int
    public var sessionTitle: String?
    /// pending, saved or skipped
    public var status: String
    public var targets: [Target]

    private enum K: String, CodingKey { case id, kind, fact, rule, quote, count, sessionTitle, status, targets }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.or(.kind, "preference")
        fact = try c.or(.fact, "")
        rule = try c.or(.rule, "")
        quote = try c.or(.quote, "")
        count = try c.or(.count, 1)
        sessionTitle = try? c.opt(.sessionTitle)
        status = try c.or(.status, "pending")
        targets = (try? c.or(.targets, [Target]())) ?? []
    }

    /// "Correction", "Preference", "Remember", "Praise".
    public var kindWord: String {
        switch kind {
        case "correction": "Correction"
        case "remember": "Remember"
        case "positive": "Praise"
        default: "Preference"
        }
    }

    /// The text Save writes to a target: the fact for a memory, the rule for a file.
    public func text(for target: String) -> String { target == "memory" ? fact : rule }
}

public struct LearningsList: Sendable, Hashable, Decodable {
    public var items: [Learning] = []
    public var pending = 0
    public var queued = 0

    private enum K: String, CodingKey { case items, pending, queued }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        items = (try? c.or(.items, [Learning]())) ?? []
        pending = try c.or(.pending, 0)
        queued = try c.or(.queued, 0)
    }
}

extension ConclaveClient {
    public func learnings() async throws -> LearningsList { try await get(["api", "reflect", "learnings"]) }

    /// Save to a target with the text as shown (or edited).
    public func saveLearning(_ id: String, target: String, text: String) async throws -> LearningsList {
        try await send("POST", ["api", "reflect", "learnings", id, "save"], JSONValue.object(["target": .string(target), "text": .string(text)]))
    }

    public func skipLearning(_ id: String) async throws -> LearningsList { try await call("POST", ["api", "reflect", "learnings", id, "skip"]) }

    /// Nightly reflection: on or off and its time (GET/PUT /api/assistant/reflect).
    public func reflect() async throws -> ReflectSettings { try await get(["api", "assistant", "reflect"]) }

    public func setReflect(_ patch: JSONObject) async throws -> ReflectSettings {
        try await send("PUT", ["api", "assistant", "reflect"], JSONValue.object(patch))
    }
}

public struct ReflectSettings: Sendable, Hashable, Decodable {
    public var enabled = false
    /// "02:40", local to the owner.
    public var time: String?

    private enum K: String, CodingKey { case enabled, time }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        enabled = try c.or(.enabled, false)
        time = try? c.opt(.time)
    }
}
