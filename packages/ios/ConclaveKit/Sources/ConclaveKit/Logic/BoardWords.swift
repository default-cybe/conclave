import Foundation

/// The board's words (web features/tasks/taskWords.tsx and TasksPage, Android TasksScreen): columns
/// in the hub's order, each sorted, and a task's line under its title.
public enum BoardWords {
    /// What an empty column says (web COLUMNS).
    public static func empty(_ s: TaskStatus) -> String {
        switch s {
        case .inbox: "Ideas and requests land here."
        case .todo: "Nothing planned."
        case .doing: "Nothing in progress."
        case .review: "Nothing waiting for review."
        case .done: "Nothing finished yet."
        }
    }

    /// Done: newest first. Others: priority, then the nearest due date, then newest.
    public static func sorted(_ list: [BoardTask], _ status: TaskStatus) -> [BoardTask] {
        list.sorted { a, b in
            if status == .done { return a.updatedAt > b.updatedAt }
            if a.priority != b.priority { return a.priority > b.priority }
            let da = a.due ?? .max, db = b.due ?? .max
            if da != db { return da < db }
            return a.updatedAt > b.updatedAt
        }
    }

    /// Every column in order with its sorted tasks, empty ones too.
    public static func columns(_ tasks: [BoardTask]) -> [BoardColumn] {
        TaskStatus.allCases.map { s in BoardColumn(status: s, tasks: sorted(tasks.filter { $0.status == s }, s)) }
    }

    /// Only the top two priorities get a word.
    public static func priorityWord(_ p: Int) -> String? { p == 3 ? "urgent" : p == 2 ? "high" : nil }

    public enum DueTone: Sendable { case fault, warn, dim }

    private static let day: Int64 = 86_400_000

    /// "overdue", "overdue 2d", "due 18:00", "due tomorrow", "due 23 Nov", "was due 23 Nov".
    public static func due(_ due: Int64?, done: Bool, now: Int64, calendar: Calendar = .current) -> (text: String, tone: DueTone)? {
        guard let due, due > 0 else { return nil }
        let date = Date(timeIntervalSince1970: Double(due) / 1000)
        let today = Int64(calendar.startOfDay(for: Date(timeIntervalSince1970: Double(now) / 1000)).timeIntervalSince1970 * 1000)
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = Locale(identifier: "en_GB")
        func dateWord() -> String {
            if due >= today + day && due < today + 2 * day { return "tomorrow" }
            if due >= today - day && due < today { return "yesterday" }
            f.dateFormat = abs(due - today) < 6 * day ? "EEE" : "d MMM"
            return f.string(from: date)
        }
        if done { return ("was due \(dateWord())", .dim) }
        if due < now {
            let late = now - due
            return (late < day ? "overdue" : "overdue \(late / day)d", .fault)
        }
        let tone: DueTone = due - now < day ? .warn : .dim
        if due < today + day {
            f.dateFormat = "HH:mm"
            return ("due \(f.string(from: date))", tone)
        }
        return ("due \(dateWord())", tone)
    }

    /// The line under a task's title: "high, ios, coder, due tomorrow". Labels first, the agent once.
    public static func meta(_ t: BoardTask, now: Int64) -> String {
        var parts: [String] = []
        if t.status != .done, let p = priorityWord(t.priority) { parts.append(p) }
        parts += t.labels
        if let a = t.agent, !a.isEmpty, !t.labels.contains(a) { parts.append(a) }
        if let d = due(t.due, done: t.status == .done, now: now) { parts.append(d.text) }
        return parts.joined(separator: ", ")
    }

    /// "7 tasks, 2 doing, 1 in review"; "No tasks".
    public static func summary(_ tasks: [BoardTask]) -> String {
        guard !tasks.isEmpty else { return "No tasks" }
        var parts = ["\(tasks.count) \(tasks.count == 1 ? "task" : "tasks")"]
        let doing = tasks.filter { $0.status == .doing }.count
        let review = tasks.filter { $0.status == .review }.count
        if doing > 0 { parts.append("\(doing) doing") }
        if review > 0 { parts.append("\(review) in review") }
        return parts.joined(separator: ", ")
    }
}

/// One board column and its sorted tasks.
public struct BoardColumn: Sendable, Hashable {
    public var status: TaskStatus
    public var tasks: [BoardTask]
}

/// A state word's tone: signal is live work, warn waits, fault failed, dim is settled.
public enum RunTone: Sendable { case signal, warn, fault, dim }

/// One phase of a run with its calls, in meta.phases order.
public struct PhaseGroup: Sendable, Hashable {
    public var title: String
    public var detail: String?
    public var calls: [WorkflowCall]
}

/// A call row and how far it is indented (a nested workflow()'s calls sit under it).
public struct CallRow: Sendable, Hashable {
    public var call: WorkflowCall
    public var depth: Int
}

/// The words of a workflow run (Android logic/WorkflowRuns.kt WorkflowWords, web features/workflows/words.ts).
public enum WorkflowWords {
    private static let live: Set<WorkflowRunStatus> = [.queued, .running, .paused, .waitingReset]

    /// Queued, running, paused or waiting for a limit: it can still change.
    public static func isLive(_ s: WorkflowRunStatus) -> Bool { live.contains(s) }

    public static func runWord(_ s: WorkflowRunStatus) -> String {
        switch s {
        case .queued: "queued"
        case .running: "running"
        case .paused: "paused"
        case .waitingReset: "waiting for the limit"
        case .interrupted: "interrupted"
        case .done: "done"
        case .failed: "failed"
        case .stopped: "stopped"
        case .budget: "stopped at budget"
        }
    }

    public static func runTone(_ s: WorkflowRunStatus) -> RunTone {
        switch s {
        case .running: .signal
        case .paused, .waitingReset, .interrupted, .budget: .warn
        case .failed: .fault
        case .queued, .done, .stopped: .dim
        }
    }

    /// A call cut short because the owner stopped the run: not a failure of the call.
    public static func stoppedByRun(_ c: WorkflowCall) -> Bool { c.state == .failed && c.error == "the run was stopped" }

    public static func callWord(_ c: WorkflowCall) -> String {
        if c.waitingOnOwner { return "waiting for you" }
        if stoppedByRun(c) { return "stopped" }
        switch c.state {
        case .queued: return "queued"
        case .running: return "running"
        case .done: return "done"
        case .failed: return "failed"
        case .skipped: return "skipped"
        case .cached: return "cached"
        case .parked: return "waiting"
        }
    }

    public static func callTone(_ c: WorkflowCall) -> RunTone {
        if c.waitingOnOwner { return .warn }
        if stoppedByRun(c) { return .dim }
        switch c.state {
        case .running: return .signal
        case .failed: return .fault
        case .parked: return .warn
        default: return .dim
        }
    }

    /// "Phase 2 of 4, Verify", or nil before the first phase.
    public static func phaseLine(_ run: WorkflowRun) -> String? {
        guard run.phaseIndex >= 0 else { return nil }
        let title: String? = run.phases.indices.contains(run.phaseIndex) ? Optional(run.phases[run.phaseIndex].title) : run.phaseTitle
        guard let title else { return nil }
        return run.phases.isEmpty ? title : "Phase \(run.phaseIndex + 1) of \(run.phases.count), \(title)"
    }

    public static func agents(_ n: Int) -> String { n == 1 ? "1 agent" : "\(n) agents" }

    /// The sentence a run opens with, in three parts: "Running. Phase 2 of 4, Verify", "14 agents: 9 done,
    /// 1 running" and "412k tokens, $3.10". A running call that waits on an approval counts as waiting for you.
    public static func statusParts(_ run: WorkflowRun, _ calls: [WorkflowCall] = []) -> (head: String, agents: String, spend: String) {
        let c = run.counts
        let waiting = calls.filter { $0.kind == .agent && $0.waitingOnOwner }.count
        let running = max(0, c.running - waiting)
        let bits = ([
            c.done + c.cached > 0 ? "\(c.done + c.cached) done" : nil,
            running > 0 ? "\(running) running" : nil,
            waiting > 0 ? "\(waiting) waiting for you" : nil,
            c.failed > 0 ? "\(c.failed) failed" : nil,
            c.parked > 0 ? "\(c.parked) waiting for a limit" : nil,
            c.skipped > 0 ? "\(c.skipped) skipped" : nil,
        ] as [String?]).compactMap { $0 }
        let word = runWord(run.status)
        let lead = word.prefix(1).uppercased() + word.dropFirst()
        let who = agents(c.agents) + (bits.isEmpty ? "" : ": " + bits.joined(separator: ", "))
        let spend = "\(tokens(run.inputTokens + run.outputTokens)) tokens, \(usd(run.costUsd))"
        return ([lead, phaseLine(run)].compactMap { $0 }.joined(separator: ". "), who, spend)
    }

    /// "Running. Phase 2 of 4, Verify. 14 agents: 9 done, 1 running. 412k tokens, $3.10."
    public static func statusSentence(_ run: WorkflowRun, _ calls: [WorkflowCall] = []) -> String {
        let p = statusParts(run, calls)
        return "\(p.head). \(p.agents). \(p.spend)."
    }

    /// A run's line in the list: "14 agents, 412k tokens, $3.10".
    public static func runMeta(_ run: WorkflowRun) -> String {
        [agents(run.counts.agents), "\(tokens(run.inputTokens + run.outputTokens)) tokens", usd(run.costUsd)].joined(separator: ", ")
    }

    /// Calls by phase in meta.phases order; calls in a phase meta does not name come last, under "Other calls".
    public static func byPhase(_ run: WorkflowRun, _ calls: [WorkflowCall]) -> [PhaseGroup] {
        let titles = Set(run.phases.map(\.title))
        let groups = run.phases.map { p in PhaseGroup(title: p.title, detail: p.detail, calls: calls.filter { $0.phase == p.title }) }
        let other = calls.filter { $0.phase.map { !titles.contains($0) } ?? true }
        return other.isEmpty ? groups : groups + [PhaseGroup(title: "Other calls", detail: nil, calls: other)]
    }

    /// "3 of 5 done", "not started" for a later phase of a live run, or "no agents".
    public static func phaseProgress(_ g: PhaseGroup, index: Int, run: WorkflowRun) -> String {
        if !g.calls.isEmpty { return "\(g.calls.filter { $0.state == .done || $0.state == .cached }.count) of \(g.calls.count) done" }
        return index > run.phaseIndex && isLive(run.status) ? "not started" : "no agents"
    }

    /// Rows of one phase: calls in order, a nested workflow()'s calls right under it, indented (at most 3).
    public static func rows(_ calls: [WorkflowCall]) -> [CallRow] {
        let seqs = Set(calls.map(\.seq))
        func nested(_ c: WorkflowCall) -> Bool { c.parentSeq.map { seqs.contains($0) } ?? false }
        let children = Dictionary(grouping: calls.filter(nested)) { $0.parentSeq ?? 0 }
        var out: [CallRow] = []
        var seen = Set<Int>()
        func walk(_ c: WorkflowCall, _ depth: Int) {
            guard seen.insert(c.seq).inserted else { return }
            out.append(CallRow(call: c, depth: depth))
            for k in children[c.seq] ?? [] { walk(k, min(depth + 1, 3)) }
        }
        for c in calls where !nested(c) { walk(c, 0) }
        // a cycle of parents has no top: list what is left flat
        for c in calls where !seen.contains(c.seq) { walk(c, 0) }
        return out
    }

    public static func callLabel(_ c: WorkflowCall) -> String {
        if let l = c.label, !l.trimmingCharacters(in: .whitespaces).isEmpty { return l }
        return c.kind == .workflow ? "workflow" : "call \(c.seq)"
    }

    /// "Sonnet 5.5, Reading src/auth.ts, 12k tokens, $0.04" under a call's label.
    public static func callMeta(_ c: WorkflowCall, lastTool: String?) -> String {
        let model = ModelRefs.displayName(c.model)
        let parts: [String?] = [
            model.isEmpty ? (c.kind == .agent ? nil : c.kind.rawValue) : model,
            c.state == .failed && !stoppedByRun(c) ? c.error : lastTool,
            c.tokens > 0 ? "\(tokens(c.tokens)) tokens" : nil,
            c.costUsd > 0 ? usd(c.costUsd) : nil,
            c.attempt > 1 ? "attempt \(c.attempt)" : nil,
        ]
        return parts.compactMap { $0 }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.joined(separator: ", ")
    }

    /// What happens now in a live run: the newest running call with a tool, as "label: tool".
    public static func activity(_ d: WorkflowRunDetail) -> String? {
        guard isLive(d.run.status),
              let c = d.calls.last(where: { $0.state == .running && !($0.lastTool ?? "").isEmpty }),
              let tool = c.lastTool else { return nil }
        let t = tool.hasPrefix("needs approval: ") ? String(tool.dropFirst("needs approval: ".count)) : tool
        return "\(callLabel(c)): \(t)"
    }

    /// The run's report as text: a string result, or an object's "report", "summary" or "text". Nil when none.
    public static func report(_ r: JSONValue?) -> String? {
        guard let r else { return nil }
        let text = r.string ?? ["report", "summary", "text"].lazy.compactMap { r[$0]?.string }.first
        let t = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? nil : t
    }

    /// How long it ran: "42s", "4m 12s", "1h 5m". A live run counts to `now`; nil before it started.
    public static func duration(_ run: WorkflowRun, now: Int64) -> String? {
        let start = run.startedAt ?? (run.createdAt > 0 ? run.createdAt : nil)
        guard let start, let end = run.finishedAt ?? (isLive(run.status) ? now : nil), end >= start else { return nil }
        let s = (end - start) / 1000
        if s < 60 { return "\(s)s" }
        if s < 3600 { return s % 60 == 0 ? "\(s / 60)m" : "\(s / 60)m \(s % 60)s" }
        return (s % 3600) / 60 == 0 ? "\(s / 3600)h" : "\(s / 3600)h \((s % 3600) / 60)m"
    }

    /// "412k", "1.2k", "3.4M" (Android Format.tokens).
    public static func tokens(_ n: Int64) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", Double(n) / 1e9) }
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1e6) }
        if n >= 10_000 { return "\(Int64((Double(n) / 1000).rounded()))k" }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1e3) }
        return "\(n)"
    }

    /// "$0", "$0.0042", "$3.10", "$1,240" (Android Format.usd).
    public static func usd(_ v: Double) -> String {
        if v == 0 { return "$0" }
        if abs(v) < 0.01 { return String(format: "$%.4f", v) }
        if abs(v) < 100 { return String(format: "$%.2f", v) }
        let n = Int64(v.rounded())
        let digits = String(abs(n))
        let grouped = digits.reversed().enumerated().map { i, ch in i > 0 && i % 3 == 0 ? "\(ch)," : "\(ch)" }.reversed().joined()
        return (n < 0 ? "-$" : "$") + grouped
    }
}
