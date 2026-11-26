import Foundation

/// Where a picture or document a trimmed page left out lives: block [index] of message
/// [messageId], part [part] of a tool result.
public struct BlockRef: Sendable, Hashable {
    public var sessionId: String
    public var messageId: String
    public var index: Int
    public var part: Int?

    public init(sessionId: String, messageId: String, index: Int, part: Int? = nil) {
        self.sessionId = sessionId
        self.messageId = messageId
        self.index = index
        self.part = part
    }

    private static let scheme = "conclave-block:"

    public var url: String {
        Self.scheme + ([sessionId, messageId, String(index)] + (part.map { [String($0)] } ?? [])).joined(separator: "/")
    }

    /// The ref [url] names, or nil for any other url.
    public static func of(_ url: String?) -> BlockRef? {
        guard let url, url.hasPrefix(scheme) else { return nil }
        let parts = url.dropFirst(scheme.count).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard (3...4).contains(parts.count), let index = Int(parts[2]) else { return nil }
        return BlockRef(sessionId: parts[0], messageId: parts[1], index: index, part: parts.count == 4 ? Int(parts[3]) : nil)
    }
}

/// A page read with trim=1 (hub core session/trim.ts): a block over 100 KB comes without its
/// image or document data, listed in meta.trimmed. Each picture or document it cut gets a
/// `BlockRef` url, so the screen reads that one block (GET .../messages/:id/blocks/:index) only
/// when it shows, and a big chat never holds every screenshot's base64 at once. Cut text stays cut.
public enum Trimmed {
    public static func mark(_ m: Message) -> Message {
        let cut = Set(m.meta?["trimmed"]?.array?.compactMap { $0["index"]?.number.map { Int($0) } } ?? [])
        guard !cut.isEmpty else { return m }
        var out = m
        out.content = m.content.enumerated().map { i, b in
            guard cut.contains(i) else { return b }
            let ref = BlockRef(sessionId: m.sessionId, messageId: m.id, index: i)
            switch b {
            case .image(var x) where x.data == nil && x.url == nil:
                x.url = ref.url
                return .image(x)
            case .document(var x) where x.data == nil && x.url == nil:
                x.url = ref.url
                return .document(x)
            case .toolResult(var r):
                guard let parts = r.content.array else { return b }
                r.content = .array(parts.enumerated().map { k, part in
                    guard var o = part.object, o["type"]?.string == "image", o["data"] == nil, o["url"] == nil else { return part }
                    o["url"] = .string(BlockRef(sessionId: m.sessionId, messageId: m.id, index: i, part: k).url)
                    return .object(o)
                })
                return .toolResult(r)
            default:
                return b
            }
        }
        return out
    }
}
