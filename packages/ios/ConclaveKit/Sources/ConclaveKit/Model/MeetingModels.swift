import Foundation

// Meetings (core meeting/wire.ts; Android model/Meetings.kt and logic/Meetings.kt). The phone and
// iPad never listen: no segments or answers here. Status and prep state stay strings.

public struct PrepProgress: Sendable, Hashable, Decodable {
    public var phase = ""
    public var done = 0
    public var total = 0
    public var startedAt: Int64?

    public init(phase: String, done: Int = 0, total: Int = 0, startedAt: Int64? = nil) {
        self.phase = phase
        self.done = done
        self.total = total
        self.startedAt = startedAt
    }

    private enum K: String, CodingKey { case phase, done, total, startedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        phase = try c.or(.phase, "")
        done = try c.or(.done, 0)
        total = try c.or(.total, 0)
        startedAt = try? c.opt(.startedAt)
    }
}

public struct Meeting: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var sessionId = ""
    public var device = ""
    public var cwd = ""
    public var title = ""
    public var agenda: String?
    /// scheduled, preparing, ready, live, paused, ending, ended or failed
    public var status = ""
    public var createdAt: Int64 = 0
    public var startedAt: Int64?
    public var endedAt: Int64?
    public var error: String?
    public var scheduledAt: Int64?
    public var durationMin: Int?
    public var tz: String?
    /// none, queued, running, waiting, done, failed or cancelled
    public var prepState = "none"
    public var prepProgress: PrepProgress?
    public var prepEditedAt: Int64?
    public var memoryId: String?

    public init(id: String, title: String = "", status: String = "scheduled", createdAt: Int64 = 0, scheduledAt: Int64? = nil, durationMin: Int? = nil) {
        self.id = id
        self.title = title
        self.status = status
        self.createdAt = createdAt
        self.scheduledAt = scheduledAt
        self.durationMin = durationMin
    }

    private enum K: String, CodingKey {
        case id, sessionId, device, cwd, title, agenda, status, createdAt, startedAt, endedAt, error, scheduledAt, durationMin, tz, prepState, prepProgress, prepEditedAt, memoryId
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.or(.sessionId, "")
        device = try c.or(.device, "")
        cwd = try c.or(.cwd, "")
        title = try c.or(.title, "")
        agenda = try? c.opt(.agenda)
        status = try c.or(.status, "")
        createdAt = try c.or(.createdAt, 0)
        startedAt = try? c.opt(.startedAt)
        endedAt = try? c.opt(.endedAt)
        error = try? c.opt(.error)
        scheduledAt = try? c.opt(.scheduledAt)
        durationMin = try? c.opt(.durationMin)
        tz = try? c.opt(.tz)
        prepState = try c.or(.prepState, "none")
        prepProgress = try? c.opt(.prepProgress)
        prepEditedAt = try? c.opt(.prepEditedAt)
        memoryId = try? c.opt(.memoryId)
    }
}

private struct MeetingList: Decodable { var meetings: [Meeting] = [] }
private struct MeetingNotes: Decodable { var markdown: String = "" }

/// The Meetings page's rules (Android logic/Meetings.kt, web features/meeting/time.ts).
public enum MeetingWords {
    static let minute: Int64 = 60_000
    static let hour = 60 * minute
    static let day = 24 * hour
    /// A ready meeting this close to its start is Now; this long past its end, never started, it is Past.
    static let nowWindow = 15 * minute
    static let notHeldAfter = 3 * hour

    public struct Sections: Sendable, Hashable {
        public var now: [Meeting] = []
        public var upcoming: [Meeting] = []
        public var past: [Meeting] = []
        public var isEmpty: Bool { now.isEmpty && upcoming.isEmpty && past.isEmpty }
    }

    /// Now, Upcoming and Past. A status a newer hub adds shows under Now, so it is never lost.
    public static func sections(_ meetings: [Meeting], now: Int64) -> Sections {
        var s = Sections()
        var seen = Set<String>()
        for m in meetings where seen.insert(m.id).inserted {
            let at = m.scheduledAt
            switch m.status {
            case "ended", "failed": s.past.append(m)
            case "live", "paused", "ending", "preparing": s.now.append(m)
            case "scheduled", "ready":
                if let at, now > staleAt(m, at) { s.past.append(m) }
                else if m.status == "ready", at.map({ $0 - now <= nowWindow }) ?? true { s.now.append(m) }
                else { s.upcoming.append(m) }
            default: s.now.append(m)
            }
        }
        s.now.sort { ($0.startedAt ?? $0.createdAt) > ($1.startedAt ?? $1.createdAt) }
        s.upcoming.sort { ($0.scheduledAt ?? .max) < ($1.scheduledAt ?? .max) }
        s.past.sort { pastKey($0) > pastKey($1) }
        return s
    }

    public static func pastKey(_ m: Meeting) -> Int64 { m.startedAt ?? m.scheduledAt ?? m.createdAt }

    static func staleAt(_ m: Meeting, _ at: Int64) -> Int64 { at + Int64(m.durationMin ?? 0) * minute + notHeldAfter }

    public static func notHeld(_ m: Meeting, now: Int64) -> Bool {
        guard let at = m.scheduledAt else { return false }
        return (m.status == "scheduled" || m.status == "ready") && m.startedAt == nil && now > staleAt(m, at)
    }

    /// The status word and its tone (ok, warn, fault, dim, live, neutral); Not held wins.
    public static func status(_ m: Meeting, now: Int64) -> (String, String) {
        if notHeld(m, now: now) { return ("Not held", "dim") }
        switch m.status {
        case "scheduled": return ("Scheduled", "neutral")
        case "preparing": return ("Preparing", "live")
        case "ready": return ("Ready", "neutral")
        case "live": return ("Listening", "fault")
        case "paused": return ("Paused", "warn")
        case "ending": return ("Writing notes", "live")
        case "ended": return ("Ended", "dim")
        case "failed": return ("Failed", "fault")
        default: return (m.status.prefix(1).uppercased() + m.status.dropFirst(), "neutral")
        }
    }

    /// The prep word on an Upcoming row.
    public static func prep(_ m: Meeting) -> (String, String) {
        switch m.prepState {
        case "queued": return ("Preparing", "live")
        case "running":
            if let p = m.prepProgress, p.total > 0 { return ("Preparing \(p.done)/\(p.total)", "live") }
            return ("Preparing", "live")
        case "waiting": return ("Needs your OK", "warn")
        case "done": return (m.prepEditedAt != nil ? "Edited" : "Prepared", "neutral")
        case "failed": return ("Prep failed", "fault")
        default: return m.prepEditedAt != nil ? ("Edited", "neutral") : ("Not prepared", "dim")
        }
    }

    /// The time slot for `ms` until the start: "in 3 days", "tomorrow 10:00", "in 2h 05m", "in 4:09", "now", "started 2h ago".
    public static func countdown(_ ms: Int64, start: Int64, zone: TimeZone) -> String {
        if ms >= 2 * day { return "in \(ms / day) days" }
        if ms >= day { return "tomorrow \(clock(start, zone))" }
        if ms >= hour { return "in \(ms / hour)h \(two((ms % hour) / minute))m" }
        if ms >= 10 * minute { return "in \(ms / minute)m" }
        if ms > 0 { let s = (ms + 999) / 1000; return "in \(s / 60):\(two(s % 60))" }
        if ms >= -nowWindow { return "now" }
        let a = -ms
        return "started " + (a < hour ? "\(a / minute)m" : a < day ? "\(a / hour)h" : "\(a / day)d") + " ago"
    }

    private static func two(_ n: Int64) -> String { n < 10 ? "0\(n)" : "\(n)" }

    public static func clock(_ ts: Int64, _ zone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.timeZone = zone
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(ts) / 1000))
    }

    /// "Mon 2 Nov, 10:00 to 11:00".
    public static func when(_ start: Int64, durationMin: Int?, zone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.timeZone = zone
        f.dateFormat = "EEE d MMM"
        let head = "\(f.string(from: Date(timeIntervalSince1970: TimeInterval(start) / 1000))), \(clock(start, zone))"
        guard let d = durationMin, d > 0 else { return head }
        return "\(head) to \(clock(start + Int64(d) * minute, zone))"
    }

    /// The last part of a path: "/home/me/capstone" is "capstone".
    public static func folderName(_ cwd: String) -> String {
        let t = cwd.trimmingCharacters(in: CharacterSet(charactersIn: "/\\"))
        let last = t.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        return last.isEmpty ? cwd : last
    }

    /// The zone a meeting's times read in: its own, else this device's.
    public static func zone(_ m: Meeting) -> TimeZone { m.tz.flatMap(TimeZone.init(identifier:)) ?? .current }
}

extension ConclaveClient {
    public func meetings() async throws -> [Meeting] {
        let r: MeetingList = try await get(["api", "meetings"], query: [("view", "all"), ("limit", "100")])
        return r.meetings
    }

    /// A meeting scheduled at `scheduledAt`, or prepared now without one ("Start now").
    public func createMeeting(title: String, agenda: String?, device: String?, cwd: String?, scheduledAt: Int64?, durationMin: Int?) async throws -> Meeting {
        var b: JSONObject = ["title": .string(title), "tz": .string(TimeZone.current.identifier)]
        if let agenda, !agenda.isEmpty { b["agenda"] = .string(agenda) }
        if let device, !device.isEmpty { b["device"] = .string(device) }
        if let cwd, !cwd.isEmpty { b["cwd"] = .string(cwd) }
        if let scheduledAt { b["scheduledAt"] = .number(Double(scheduledAt)) }
        if let durationMin { b["durationMin"] = .number(Double(durationMin)) }
        return try await send("POST", ["api", "meetings"], JSONValue.object(b))
    }

    public func deleteMeeting(_ id: String) async throws { try await sendUnit("DELETE", ["api", "meetings", id]) }

    /// An ended meeting's notes as Markdown; 404 before the wrap-up.
    public func meetingNotes(_ id: String) async throws -> String {
        let r: MeetingNotes = try await get(["api", "meetings", id, "notes"])
        return r.markdown
    }

    public func saveMeetingToMemory(_ id: String) async throws -> Meeting { try await call("POST", ["api", "meetings", id, "memory"]) }

    /// "Open as chat": a chat (to "chat") or Code session ("code") holding the prep, notes and transcript.
    public func meetingToChat(_ id: String, to: String = "chat") async throws -> Session {
        try await send("POST", ["api", "meetings", id, "chat"], JSONValue.object(["to": .string(to)]))
    }
}
