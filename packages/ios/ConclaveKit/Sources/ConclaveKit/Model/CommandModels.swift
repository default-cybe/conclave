import Foundation

/// GET /api/commands?builtins=1: the hub's built-in commands first (source "builtin", `chat` when
/// it also fits a chat), then the custom ones. An older hub sends only the custom ones.
public struct CommandDef: Sendable, Hashable, Decodable, Identifiable {
    public var id: String { name }
    public var name: String
    public var description: String?
    public var argumentHint: String?
    public var source: String
    public var chat: Bool

    public init(name: String, description: String? = nil, argumentHint: String? = nil, source: String = "builtin", chat: Bool = false) {
        self.name = name
        self.description = description
        self.argumentHint = argumentHint
        self.source = source
        self.chat = chat
    }

    private enum CodingKeys: String, CodingKey { case name, description, argumentHint, source, chat }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        description = try? c.opt(.description)
        argumentHint = try? c.opt(.argumentHint)
        source = (try? c.or(.source, "user")) ?? "user"
        chat = (try? c.or(.chat, false)) ?? false
    }
}

/// POST /api/sessions/:id/command: what the hub said back, when it said anything.
public struct CommandResult: Sendable, Hashable, Decodable {
    public var ok: Bool = true
    public var output: String?
}

/// A checkpoint the hub took before a file change (core types.ts Checkpoint).
public struct Checkpoint: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var seq: Int64 = 0
    public var commit: String = ""
    public var files: Int = 0
    public var createdAt: Int64 = 0
    public var device: String?

    public init(id: String, seq: Int64 = 0, commit: String = "", files: Int = 0, createdAt: Int64 = 0, device: String? = nil) {
        self.id = id
        self.seq = seq
        self.commit = commit
        self.files = files
        self.createdAt = createdAt
        self.device = device
    }

    private enum CodingKeys: String, CodingKey { case id, seq, commit, files, createdAt, device }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        seq = try c.or(.seq, 0)
        commit = try c.or(.commit, "")
        files = try c.or(.files, 0)
        createdAt = try c.or(.createdAt, 0)
        device = try? c.opt(.device)
    }
}

/// GET /api/sessions/:id/export: the sanitized transcript and a file name for it.
public struct ExportResult: Sendable, Hashable, Decodable {
    public var content: String = ""
    public var filename: String = ""
}

/// POST /api/sessions/:id/btw: the side answer, never put in the transcript.
public struct BtwAnswer: Sendable, Hashable, Decodable {
    public var answer: String = ""
}
