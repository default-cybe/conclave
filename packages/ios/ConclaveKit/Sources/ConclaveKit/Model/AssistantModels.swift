import Foundation

// Today, goals and routines (packages/android/client model/Today.kt and Models.kt Routine, RoutineRun;
// core assistant/types.ts Goal). Every field has a default so a hub that adds one never fails the page.

public struct DayPlanItem: Sendable, Hashable, Decodable {
    /// Local "HH:MM", when the item has a time.
    public var time: String?
    public var text = ""
    /// event, task, goal, focus or reminder.
    public var kind: String?

    private enum CodingKeys: String, CodingKey { case time, text, kind }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        time = try c.opt(.time)
        text = try c.or(.text, "")
        kind = try c.opt(.kind)
    }
}

public struct PlanFocus: Sendable, Hashable, Decodable {
    public var text = ""
    public var start = ""
    public var end = ""

    private enum CodingKeys: String, CodingKey { case text, start, end }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.or(.text, "")
        start = try c.or(.start, "")
        end = try c.or(.end, "")
    }
}

public struct PlanQuestion: Sendable, Hashable, Decodable {
    public var text = ""
    public var options: [String] = []
    public var answer: String?

    private enum CodingKeys: String, CodingKey { case text, options, answer }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.or(.text, "")
        options = try c.or(.options, [])
        answer = try c.opt(.answer)
    }
}

public struct DayPlan: Sendable, Hashable, Decodable {
    public var summary = ""
    public var items: [DayPlanItem] = []
    public var focus: PlanFocus?
    public var question: PlanQuestion?

    private enum CodingKeys: String, CodingKey { case summary, items, focus, question }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = try c.or(.summary, "")
        items = try c.or(.items, [])
        focus = try c.opt(.focus)
        question = try c.opt(.question)
    }
}

public struct TodayEvent: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var title = ""
    public var start: Int64 = 0
    public var end: Int64 = 0
    public var allDay = false
    public var calendar = ""
    /// "#2e7d32"
    public var color: String?

    private enum CodingKeys: String, CodingKey { case id, title, start, end, allDay, calendar, color }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.or(.title, "")
        start = try c.or(.start, 0)
        end = try c.or(.end, 0)
        allDay = try c.or(.allDay, false)
        calendar = try c.or(.calendar, "")
        color = try c.opt(.color)
    }
}

/// GET /api/assistant/today (routes-assistant.ts): the day plan, task counts and, with a calendar, its events.
public struct Today: Sendable, Hashable, Decodable {
    public var date = ""
    /// IANA zone the times read in.
    public var timezone = "UTC"
    public var plan: DayPlan?
    public var dueToday = 0
    public var overdue = 0
    /// Nil when no calendar is connected.
    public var events: [TodayEvent]?
    public var calendarError: String?

    private enum CodingKeys: String, CodingKey { case date, timezone, plan, tasks, events, calendarError }
    private enum TaskKeys: String, CodingKey { case dueToday, overdue }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.or(.date, "")
        timezone = try c.or(.timezone, "UTC")
        plan = try c.opt(.plan)
        if c.contains(.tasks), let t = try? c.nestedContainer(keyedBy: TaskKeys.self, forKey: .tasks) {
            dueToday = try t.or(.dueToday, 0)
            overdue = try t.or(.overdue, 0)
        }
        events = try c.opt(.events)
        calendarError = try c.opt(.calendarError)
    }
}

/// GET /api/goals (core assistant/types.ts Goal), the fields Home shows.
public struct Goal: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var title = ""
    public var area = "other"
    public var nextStep: String?
    /// Local date, YYYY-MM-DD.
    public var targetDate: String?
    /// active or done
    public var status = "active"
    public var parentId: String?

    private enum CodingKeys: String, CodingKey { case id, title, area, nextStep, targetDate, status, parentId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.or(.title, "")
        area = try c.or(.area, "other")
        nextStep = try c.opt(.nextStep)
        targetDate = try c.opt(.targetDate)
        status = try c.or(.status, "active")
        parentId = try c.opt(.parentId)
    }
}

/// GET /api/routines (Android Routine).
public struct Routine: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name = ""
    /// Cron, "@every 30m" or "@once 2026-10-20T09:00".
    public var schedule = ""
    public var timezone: String?
    public var agent = ""
    public var prompt = ""
    public var enabled = true
    public var lastRunAt: Int64?
    public var nextRunAt: Int64?

    private enum CodingKeys: String, CodingKey { case id, name, schedule, timezone, agent, prompt, enabled, lastRunAt, nextRunAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, "")
        schedule = try c.or(.schedule, "")
        timezone = try c.opt(.timezone)
        agent = try c.or(.agent, "")
        prompt = try c.or(.prompt, "")
        enabled = try c.or(.enabled, true)
        lastRunAt = try c.opt(.lastRunAt)
        nextRunAt = try c.opt(.nextRunAt)
    }
}

/// GET /api/routines/:id/runs (Android RoutineRun).
public struct RoutineRun: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var sessionId: String?
    /// running, ok, error or skipped
    public var status = "running"
    /// schedule, manual or webhook
    public var trigger = "manual"
    public var startedAt: Int64 = 0
    public var error: String?
    public var summary: String?

    private enum CodingKeys: String, CodingKey { case id, sessionId, status, trigger, startedAt, error, summary }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.opt(.sessionId)
        status = try c.or(.status, "running")
        trigger = try c.or(.trigger, "manual")
        startedAt = try c.or(.startedAt, 0)
        error = try c.opt(.error)
        summary = try c.opt(.summary)
    }
}

/// POST /api/routines and PATCH /api/routines/:id (server RoutineInput): only the fields set are sent.
public struct RoutineInput: Sendable, Hashable, Encodable {
    public var name: String?
    public var schedule: String?
    public var prompt: String?
    public var agent: String?
    public var enabled: Bool?

    public init(name: String? = nil, schedule: String? = nil, prompt: String? = nil, agent: String? = nil, enabled: Bool? = nil) {
        self.name = name
        self.schedule = schedule
        self.prompt = prompt
        self.agent = agent
        self.enabled = enabled
    }
}

/// GET /api/routines/preview: the next runs, or why the schedule is not one the hub reads.
public struct SchedulePreview: Sendable, Hashable, Decodable {
    public var next: [Int64] = []
    public var error: String?

    private enum CodingKeys: String, CodingKey { case next, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        next = try c.or(.next, [])
        error = try c.opt(.error)
    }
}

/// The routine editor's schedule (web RoutineEditor's field, as choices instead of words): a kind,
/// a time and a day or interval, made into the cron, "@every" or "@once" line the hub reads.
public enum Schedules {
    public enum Kind: String, Sendable, CaseIterable { case daily, weekdays, weekly, every, once, custom }

    public static func label(_ k: Kind) -> String {
        switch k {
        case .daily: "Every day"
        case .weekdays: "Weekdays"
        case .weekly: "Weekly"
        case .every: "Every…"
        case .once: "Once"
        case .custom: "Cron"
        }
    }

    /// `hour`/`minute` for daily, weekdays, weekly (on `weekday`, 0 Sunday) and once (on `date`,
    /// "YYYY-MM-DD"); `every` minutes for an interval (a whole number of hours reads as hours).
    public static func expr(_ k: Kind, hour: Int, minute: Int, weekday: Int = 1, every: Int = 30, date: String = "", custom: String = "") -> String {
        switch k {
        case .daily: return "\(minute) \(hour) * * *"
        case .weekdays: return "\(minute) \(hour) * * 1-5"
        case .weekly: return "\(minute) \(hour) * * \(weekday)"
        case .every: return every % 60 == 0 ? "@every \(every / 60)h" : "@every \(max(every, 1))m"
        case .once: return "@once \(date)T\(two(hour)):\(two(minute))"
        case .custom: return custom.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        }
    }

    /// A saved schedule back into the editor's choices; anything else opens as Cron.
    public static func parse(_ s: String) -> (kind: Kind, hour: Int, minute: Int, weekday: Int, every: Int, date: String) {
        let f = s.split(separator: " ").map(String.init)
        if f.count == 2, f[0] == "@every", let n = Int(f[1].dropLast()) {
            if f[1].hasSuffix("m") { return (.every, 9, 0, 1, n, "") }
            if f[1].hasSuffix("h") { return (.every, 9, 0, 1, n * 60, "") }
        }
        if f.count == 2, f[0] == "@once" {
            let p = f[1].split(separator: "T").map(String.init)
            let t = p.count == 2 ? p[1].split(separator: ":").compactMap { Int($0) } : []
            if p.count == 2, t.count == 2 { return (.once, t[0], t[1], 1, 30, p[0]) }
        }
        if f.count == 5, let m = Int(f[0]), let h = Int(f[1]), f[2] == "*", f[3] == "*" {
            if f[4] == "*" { return (.daily, h, m, 1, 30, "") }
            if f[4] == "1-5" { return (.weekdays, h, m, 1, 30, "") }
            if let d = Int(f[4]), (0...6).contains(d) { return (.weekly, h, m, d, 30, "") }
        }
        return (.custom, 9, 0, 1, 30, "")
    }

    private static func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}
