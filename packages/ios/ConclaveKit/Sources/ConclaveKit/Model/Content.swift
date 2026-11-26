import Foundation

/// Anthropic-style content blocks, tagged by "type" (ContentBlock in packages/core/src/types.ts).
/// A type this app does not know decodes to `.unknown` with its name.
public enum ContentBlock: Sendable, Hashable, Codable {
    case text(String)
    case thinking(ThinkingBlock)
    case redactedThinking(String)
    case image(MediaBlock)
    case document(MediaBlock)
    case toolUse(ToolUseBlock)
    case toolResult(ToolResultBlock)
    case unknown(String)

    private enum Key: String, CodingKey { case type, text, data }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let type = try c.or(.type, "")
        switch type {
        case "text": self = .text(try c.or(.text, ""))
        case "thinking": self = .thinking(try ThinkingBlock(from: decoder))
        case "redacted_thinking": self = .redactedThinking(try c.or(.data, ""))
        case "image": self = .image(try MediaBlock(from: decoder))
        case "document": self = .document(try MediaBlock(from: decoder))
        case "tool_use": self = .toolUse(try ToolUseBlock(from: decoder))
        case "tool_result": self = .toolResult(try ToolResultBlock(from: decoder))
        default: self = .unknown(type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .text(let t):
            try c.encode("text", forKey: .type)
            try c.encode(t, forKey: .text)
        case .thinking(let b):
            try c.encode("thinking", forKey: .type)
            try b.encode(to: encoder)
        case .redactedThinking(let d):
            try c.encode("redacted_thinking", forKey: .type)
            try c.encode(d, forKey: .data)
        case .image(let b):
            try c.encode("image", forKey: .type)
            try b.encode(to: encoder)
        case .document(let b):
            try c.encode("document", forKey: .type)
            try b.encode(to: encoder)
        case .toolUse(let b):
            try c.encode("tool_use", forKey: .type)
            try b.encode(to: encoder)
        case .toolResult(let b):
            try c.encode("tool_result", forKey: .type)
            try b.encode(to: encoder)
        case .unknown(let type):
            try c.encode(type, forKey: .type)
        }
    }

    public var toolResult: ToolResultBlock? {
        if case .toolResult(let r) = self { return r }
        return nil
    }

    public var toolUse: ToolUseBlock? {
        if case .toolUse(let u) = self { return u }
        return nil
    }

    /// Context the hub adds to a user message for the model: "<system-reminder>...".
    public var isReminder: Bool {
        if case .text(let t) = self { return t.hasPrefix("<system-reminder>") }
        return false
    }
}

public struct ThinkingBlock: Sendable, Hashable, Codable {
    public var thinking: String
    public var signature: String?
    /// How long the model thought, in ms. Set by the hub when the block ends.
    public var durationMs: Int64?

    public init(thinking: String = "", signature: String? = nil, durationMs: Int64? = nil) {
        self.thinking = thinking
        self.signature = signature
        self.durationMs = durationMs
    }
}

extension ThinkingBlock {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(thinking: try c.or(.thinking, ""), signature: try c.opt(.signature), durationMs: try c.opt(.durationMs))
    }
}

/// An image or a document. `data` is base64 without the data: prefix.
/// A trimmed page leaves `data` out and `url` names the block to read (`BlockRef`).
public struct MediaBlock: Sendable, Hashable, Codable {
    public var mediaType: String
    public var data: String?
    public var url: String?
    /// Documents only.
    public var title: String?

    public init(mediaType: String = "", data: String? = nil, url: String? = nil, title: String? = nil) {
        self.mediaType = mediaType
        self.data = data
        self.url = url
        self.title = title
    }
}

extension MediaBlock {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(mediaType: try c.or(.mediaType, ""), data: try c.opt(.data), url: try c.opt(.url), title: try c.opt(.title))
    }
}

public struct ToolUseBlock: Sendable, Hashable, Codable {
    public var id: String
    public var name: String
    public var input: JSONObject
    /// Raw JSON streamed by message.delta (kind tool_input) before the block is final. Client side only.
    public var partialInput: String

    public init(id: String = "", name: String = "", input: JSONObject = [:], partialInput: String = "") {
        self.id = id
        self.name = name
        self.input = input
        self.partialInput = partialInput
    }

    private enum CodingKeys: String, CodingKey { case id, name, input }
}

extension ToolUseBlock {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.or(.id, ""), name: try c.or(.name, ""), input: try c.or(.input, [:]))
    }
}

public struct ToolResultBlock: Sendable, Hashable, Codable {
    public var toolUseId: String
    /// A string, or an array of text and image parts.
    public var content: JSONValue
    public var isError: Bool
    /// Diff, path, file cards, maps and the rest (ToolResultMeta on Android); typed when a screen needs it.
    public var meta: JSONObject?

    public init(toolUseId: String = "", content: JSONValue = "", isError: Bool = false, meta: JSONObject? = nil) {
        self.toolUseId = toolUseId
        self.content = content
        self.isError = isError
        self.meta = meta
    }

    /// Plain text of [content]. Images become "[image]".
    public var text: String {
        switch content {
        case .string(let s): return s
        case .array(let parts):
            return parts.map { part -> String in
                switch part["type"]?.string {
                case "text": return part["text"]?.string ?? ""
                case "image": return "[image]"
                default: return Self.json(part)
                }
            }.joined(separator: "\n")
        case .null: return ""
        default: return Self.json(content)
        }
    }

    private static func json(_ v: JSONValue) -> String {
        (try? Wire.encoder().encode(v)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

extension ToolResultBlock {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(toolUseId: try c.or(.toolUseId, ""), content: try c.or(.content, ""), isError: try c.or(.isError, false), meta: try c.opt(.meta))
    }
}

extension Array where Element == ContentBlock {
    /// The text blocks joined.
    public var plainText: String {
        compactMap { if case .text(let t) = $0 { t } else { nil } }
            .joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What the person wrote: the text blocks without the hub's reminders.
    public var visibleText: String {
        filter { !$0.isReminder }.plainText
    }
}
