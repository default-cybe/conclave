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
/// the web's store/queue.ts). Phase 1 ports what the transcript reducer needs; the composer's half
/// (labels, ids, /btw) comes with phase 3.
public enum PendingQueue {
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
