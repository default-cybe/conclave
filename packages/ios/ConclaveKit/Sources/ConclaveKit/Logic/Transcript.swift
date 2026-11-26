import Foundation

/// Live state of one chat. A value; `TranscriptReducer` makes new copies (Android logic/Transcript.kt).
public struct Transcript: Sendable, Hashable {
    public var sessionId: String
    /// Sorted by seq.
    public var messages: [Message] = []
    /// Tool results by toolUseId, from tool_result blocks and tool.completed events.
    public var toolResults: [String: ToolResultBlock] = [:]
    /// Latest progress line per running tool.
    public var toolProgress: [String: String] = [:]
    /// toolUseIds started but not completed yet.
    public var runningTools: Set<String> = []
    public var todos: [Todo] = []
    public var approvals: [ApprovalRequest] = []
    public var questions: [QuestionRequest] = []
    /// Messages waiting while the session works, as the hub lists them.
    public var queue: [QueuedMessage] = []
    /// Messages this app sent while it worked that the hub's list does not show yet.
    public var sending: [Sending] = []
    /// session.queue events applied, so a load never lays an older list over a newer one.
    public var queueVersion = 0
    /// The hub has messages before the first one held: scrolling to the top reads the page before it.
    public var older = false

    public init(sessionId: String) { self.sessionId = sessionId }

    public var lastSeq: Int64 { messages.map(\.seq).max() ?? 0 }

    /// What waits, in the order it will run.
    public var pending: [QueuedMessage] { PendingQueue.shown(queue, sending) }
}

public enum TranscriptReducer {
    /// Messages a load or an older page reads at once (the web's store.ts PAGE): a big chat never comes whole.
    public static let page = 200

    /// A load: [paged] when it read the newest page (no cursor), which says whether older messages wait.
    public static func loaded(_ t: Transcript, _ fetched: [Message], paged: Bool) -> Transcript {
        var out = merge(t, fetched)
        if paged { out.older = fetched.count >= page }
        return out
    }

    /// The page before the first message held, laid in front of it.
    public static func olderPage(_ t: Transcript, _ page: [Message]) -> Transcript {
        var out = merge(t, page)
        out.older = page.count >= Self.page
        return out
    }

    /// The seq the next older page reads before, or nil when there is none to read.
    public static func olderBefore(_ t: Transcript) -> Int64? { t.older ? t.messages.first?.seq : nil }

    /// Merge messages read over REST. A reply that ended here stays: a copy without a stop
    /// reason was read before it ended, and its answer came after the last update.
    public static func merge(_ t: Transcript, _ fetched: [Message]) -> Transcript {
        guard !fetched.isEmpty else { return t }
        var byId: [String: Message] = [:]
        var order: [String] = []
        for m in t.messages {
            if byId.updateValue(m, forKey: m.id) == nil { order.append(m.id) }
        }
        for m in fetched {
            if !m.sessionId.isEmpty && m.sessionId != t.sessionId { continue }
            if m.stopReason == nil && byId[m.id]?.stopReason != nil { continue }
            if byId.updateValue(m, forKey: m.id) == nil { order.append(m.id) }
        }
        var out = t
        out.messages = sorted(order.map { byId[$0]! }, createdAtToo: true)
        out.toolResults.merge(results(fetched)) { _, new in new }
        return dropTaken(out, fetched)
    }

    /// The hub's list from a load (GET /queue), asked at [askedAt] when the transcript had seen
    /// [version] queue events. A session.queue event that came meanwhile is newer: the load is left out.
    public static func loadedQueue(_ t: Transcript, _ list: [QueuedMessage], askedAt: Int64, version: Int) -> Transcript {
        guard t.queueVersion == version else { return t }
        let taken = Set(t.messages.flatMap(PendingQueue.pendingIds))
        var out = t
        out.queue = list.filter { !taken.contains($0.id) }
        out.sending = PendingQueue.afterHubList(t.sending, out.queue, loadedFrom: askedAt)
        return out
    }

    /// This app sent [item] while the session worked: it shows at once.
    public static func sent(_ t: Transcript, _ item: QueuedMessage) -> Transcript {
        var out = t
        out.sending.append(Sending(item))
        return out
    }

    /// The hub answered the send of [id]: it waits (until the hub's list has it), or it leaves.
    public static func answered(_ t: Transcript, _ id: String, _ result: SendResult?, now: Int64 = nowMs()) -> Transcript {
        var out = t
        out.sending = PendingQueue.answered(t.sending, id, result, now: now)
        return out
    }

    /// Where a reload after a reconnect starts: just before the last reply when it is still open
    /// here (it may have ended meanwhile), else after the newest message. Nil loads everything.
    public static func reloadAfter(_ t: Transcript) -> Int64? {
        let last = t.messages.last { $0.role == .assistant && $0.kind == .normal }
        let after = last.flatMap { $0.stopReason == nil ? $0.seq - 1 : nil } ?? t.lastSeq
        return after > 0 ? after : nil
    }

    public static func apply(_ t: Transcript, _ event: EngineEvent) -> Transcript {
        var out = t
        switch event {
        // your message took a waiting one's place: the bubble goes in the same copy, so both never show
        case .messageCreated(let m), .messageUpdated(let m):
            guard m.sessionId == t.sessionId else { return t }
            return dropTaken(upsert(t, m), [m])
        // a refused reply the next model replaces, or an empty one: it leaves at once
        case .messageDeleted(let sid, let mid):
            guard sid == t.sessionId else { return t }
            return remove(t, mid)
        case .sessionQueue(let sid, let queue):
            guard sid == t.sessionId else { return t }
            out.queue = queue
            out.sending = PendingQueue.afterHubList(t.sending, queue)
            out.queueVersion += 1
        case .messageDelta(let d):
            guard d.sessionId == t.sessionId else { return t }
            return applyDelta(t, d)
        case .toolStarted(let sid, _, let id, _, _):
            guard sid == t.sessionId else { return t }
            out.runningTools.insert(id)
        case .toolProgress(let sid, let id, let text):
            guard sid == t.sessionId else { return t }
            out.toolProgress[id] = text
        case .toolCompleted(let sid, let id, let result):
            guard sid == t.sessionId else { return t }
            out.toolResults[id] = result
            out.runningTools.remove(id)
            out.toolProgress[id] = nil
        case .todoUpdated(let sid, let todos):
            guard sid == t.sessionId else { return t }
            out.todos = todos
        // its own, and those of its subagents and workflow agents: they wait on you here too
        case .approvalRequested(let a):
            guard Asks.showsIn(a, t.sessionId) else { return t }
            out.approvals = t.approvals.filter { $0.id != a.id } + [a]
        case .approvalResolved(let id, _):
            out.approvals.removeAll { $0.id == id }
        case .questionAsked(let q):
            guard Asks.showsIn(q, t.sessionId) else { return t }
            out.questions = t.questions.filter { $0.id != q.id } + [q]
        case .questionAnswered(let id, _):
            out.questions.removeAll { $0.id == id }
        case .sessionUpdated(let s):
            // the turn ended: nothing can still be running
            guard s.id == t.sessionId, s.status == .idle else { return t }
            out.runningTools = []
            out.toolProgress = [:]
        default:
            return t
        }
        return out
    }

    /// Without the waiting messages these messages took the place of.
    private static func dropTaken(_ t: Transcript, _ messages: [Message]) -> Transcript {
        guard !t.queue.isEmpty || !t.sending.isEmpty else { return t }
        let taken = Set(messages.flatMap(PendingQueue.pendingIds))
        guard !taken.isEmpty else { return t }
        var out = t
        out.queue.removeAll { taken.contains($0.id) }
        out.sending.removeAll { taken.contains($0.item.id) }
        return out
    }

    /// Without message [id]; its calls stop counting as running.
    private static func remove(_ t: Transcript, _ id: String) -> Transcript {
        guard let gone = t.messages.first(where: { $0.id == id }) else { return t }
        var out = t
        out.messages.removeAll { $0.id == id }
        for call in gone.content.compactMap(\.toolUse?.id) {
            out.runningTools.remove(call)
            out.toolProgress[call] = nil
        }
        return out
    }

    private static func upsert(_ t: Transcript, _ m: Message) -> Transcript {
        var out = t
        if let i = t.messages.firstIndex(where: { $0.id == m.id }) { out.messages[i] = m } else { out.messages.append(m) }
        out.messages = sorted(out.messages, createdAtToo: false)
        out.toolResults.merge(results([m])) { _, new in new }
        return out
    }

    /// Stable sort by seq (then createdAt), as Kotlin's sortedWith keeps ties in place.
    private static func sorted(_ list: [Message], createdAtToo: Bool) -> [Message] {
        list.enumerated().sorted { a, b in
            if a.element.seq != b.element.seq { return a.element.seq < b.element.seq }
            if createdAtToo, a.element.createdAt != b.element.createdAt { return a.element.createdAt < b.element.createdAt }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// Append streamed text to block [index] of the right message.
    private static func applyDelta(_ t: Transcript, _ d: MessageDelta) -> Transcript {
        let idx = t.messages.firstIndex { $0.id == d.messageId }
        // a delta for a message not seen yet starts a placeholder at the end
        var m = idx.map { t.messages[$0] }
            ?? Message(id: d.messageId, sessionId: d.sessionId, seq: t.lastSeq + 1, role: .assistant, kind: .normal, createdAt: nowMs())
        while m.content.count <= d.index { m.content.append(empty(d.kind)) }
        m.content[d.index] = append(m.content[d.index], d)
        var out = t
        if let idx { out.messages[idx] = m } else { out.messages.append(m) }
        return out
    }

    private static func empty(_ kind: DeltaKind) -> ContentBlock {
        switch kind {
        case .text: .text("")
        case .thinking: .thinking(ThinkingBlock())
        case .toolInput: .toolUse(ToolUseBlock())
        }
    }

    private static func append(_ block: ContentBlock, _ d: MessageDelta) -> ContentBlock {
        switch (d.kind, block) {
        case (.text, .text(let s)):
            return .text(s + d.text)
        case (.text, _):
            return .text(d.text)
        case (.thinking, .thinking(var b)):
            b.thinking += d.text
            return .thinking(b)
        case (.thinking, _):
            return .thinking(ThinkingBlock(thinking: d.text))
        case (.toolInput, .toolUse(var u)):
            u.partialInput += d.text
            return .toolUse(u)
        case (.toolInput, _):
            return .toolUse(ToolUseBlock(partialInput: d.text))
        }
    }

    private static func results(_ messages: [Message]) -> [String: ToolResultBlock] {
        var out: [String: ToolResultBlock] = [:]
        for m in messages { for case .toolResult(let r) in m.content { out[r.toolUseId] = r } }
        return out
    }
}

public func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
