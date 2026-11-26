import Foundation

/// A message this app sent while the session worked that the hub's list does not show yet.
/// `confirmedAt`: when the hub answered that it waits.
public struct Sending: Sendable, Hashable {
    public var item: QueuedMessage
    public var confirmedAt: Int64?

    public init(_ item: QueuedMessage, confirmedAt: Int64? = nil) {
        self.item = item
        self.confirmedAt = confirmedAt
    }
}

/// Messages sent while a session works, before they join the transcript (Android logic/PendingQueue.kt,
/// the web's store/queue.ts): the hub lists them, this app also holds the ones it sent until the hub's
/// list has them, and the user message that takes one's place carries its id in meta.pendingIds.
public enum PendingQueue {
    public static let queued = "Queued"
    public static let steering = "Sending to the running turn"
    /// One Stop held: it waits for Send or the x.
    public static let stopped = "Stopped"
    /// The label a stored message keeps when it joined a running turn.
    public static let steered = "Steered the running turn"

    private static let idPattern = Pattern("^[A-Za-z0-9_-]{6,64}$")

    /// The message joined the transcript in place of a waiting one: it is on screen already.
    public static func replacesPending(_ m: Message) -> Bool { !pendingIds(m).isEmpty }

    /// The list key of a waiting message.
    public static func key(_ id: String) -> String { "p:\(id)" }

    /// The list key of a message: the key of the waiting one it took the place of, so the row stays put.
    public static func keyOf(_ m: Message) -> String { pendingIds(m).first.map(key) ?? m.id }

    /// An id the hub keeps (SendInput.pendingId): "a_", the time in base 36 and 10 random letters.
    public static func newId(now: Int64 = nowMs(), using rng: inout some RandomNumberGenerator) -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        let rand = String((0..<10).map { _ in alphabet.randomElement(using: &rng)! })
        return "a_" + String(now, radix: 36) + rand
    }

    public static func newId(now: Int64 = nowMs()) -> String {
        var rng = SystemRandomNumberGenerator()
        return newId(now: now, using: &rng)
    }

    /// True for an id the hub would keep.
    public static func validId(_ id: String) -> Bool { idPattern.matchEntire(id) != nil }

    /// A message this app sends while the session works, as it shows until the hub lists it.
    public static func item(_ id: String, text: String, attachments: [Attachment], whenBusy: String, at: Int64) -> QueuedMessage {
        var q = QueuedMessage(id: id, text: text, at: at, whenBusy: whenBusy == "steer" ? "steer" : "queue")
        q.attachments = attachments.map { QueuedAttachment(name: $0.name, mediaType: $0.mediaType) }
        return q
    }

    /// The label a waiting message wears.
    public static func pendingWord(_ whenBusy: String, held: Bool = false) -> String {
        held ? stopped : whenBusy == "steer" ? steering : queued
    }

    /// The label a stored message keeps when it was sent while the session worked (meta.whenBusy).
    public static func storedWord(_ meta: JSONObject?) -> String? {
        switch meta?["whenBusy"]?.string {
        case "steer": steered
        case "queue": queued
        default: nil
        }
    }

    /// The hub's list in its order, then what this app sent that it does not list yet.
    public static func shown(_ hub: [QueuedMessage], _ sending: [Sending]) -> [QueuedMessage] {
        let listed = Set(hub.map(\.id))
        return hub + sending.map(\.item).filter { !listed.contains($0.id) }
    }

    /// After the hub's list arrives. A full load asked after the hub confirmed a send ([loadedFrom])
    /// is the whole truth: one of those it does not list is gone.
    public static func afterHubList(_ sending: [Sending], _ hub: [QueuedMessage], loadedFrom: Int64? = nil) -> [Sending] {
        let listed = Set(hub.map(\.id))
        return sending.filter { s in
            guard !listed.contains(s.item.id) else { return false }
            if let loadedFrom, let confirmed = s.confirmedAt, confirmed <= loadedFrom { return false }
            return true
        }
    }

    /// The waiting messages a user message took the place of (meta.pendingIds).
    public static func pendingIds(_ m: Message) -> [String] {
        guard m.role == .user else { return [] }
        return m.meta?["pendingIds"]?.array?.compactMap(\.string) ?? []
    }

    /// The hub's answer to a send: it waits (confirmed), or it leaves (refused, or it ran at once).
    public static func answered(_ sending: [Sending], _ id: String, _ result: SendResult?, now: Int64) -> [Sending] {
        guard sending.contains(where: { $0.item.id == id }) else { return sending }
        guard let result, result.queued, result.pendingId == id else { return sending.filter { $0.item.id != id } }
        return sending.map { $0.item.id == id ? Sending($0.item, confirmedAt: now) : $0 }
    }
}
