import Foundation

// The sidebar's grouping and search (Android logic/Drawer.kt and Panel.kt).
// shortcut: Group by device, the project list, Delegated work and Imported are not ported; they
// come with the Devices and Projects pages (phase 5). Without the project list a session groups
// under its folder, or under its projectId with the folder's name, as Android does before it loads.

/// Chat, Assistant or Code (Android Start.modeOf).
public enum StartMode: Sendable, Hashable {
    case chat, assistant, code

    public static let assistantAgent = "assistant"

    public static func of(_ s: Session) -> StartMode {
        s.isChat ? .chat : s.agent == assistantAgent ? .assistant : .code
    }
}

public enum GroupBy: String, Sendable, CaseIterable {
    case project, time

    public var label: String { self == .project ? "Project" : "Time" }

    /// The stored choice; Project when nothing, or something unknown, is stored.
    public static func from(_ wire: String?) -> GroupBy { wire.flatMap(GroupBy.init(rawValue:)) ?? .project }
}

public enum RecentDot: Sendable, Hashable { case none, running, waiting }

/// One row of the sidebar.
public struct Recent: Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var isChat: Bool
    public var dot: RecentDot
}

public struct DrawerGroup: Sendable, Hashable, Identifiable {
    public var key: String
    public var title: String
    public var items: [Recent]
    public var id: String { key }
}

public enum Panel {
    /// Not archived, not incognito, not a subagent (unless moved to the main list), not a workflow's agent.
    public static func shown(_ s: Session) -> Bool {
        let moved = s.meta?["movedFrom"]?.object != nil
        let workflowAgent = s.meta?["workflow"]?["runId"]?.string != nil
        return !s.archived && !s.isIncognito && !(s.parentId != nil && !moved) && !workflowAgent
    }

    /// Waiting on you wins over running.
    public static func dot(_ s: Session, asked: Bool = false) -> RecentDot {
        if asked || s.status == .waitingApproval || s.status == .waitingInput { return .waiting }
        return s.status == .running ? .running : .none
    }

    /// The session's own title, or "New chat" and "New session" until it has one.
    public static func title(_ s: Session) -> String {
        let t = s.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? (s.isChat ? "New chat" : "New session") : t
    }
}

public enum Drawer {
    public static let pinned = "pinned"
    public static let chats = "chats"
    public static let noProject = "none"

    /// The conversations of `mode` (all when nil) grouped by `by`: Pinned first, then the groups
    /// newest first, each newest first; by project, sessions without a folder and then chats go last.
    /// `query` keeps titles that have it, or for a session its agent, folder or project name.
    public static func groups(
        _ sessions: [Session], mode: StartMode? = nil, by: GroupBy, waiting: Set<String> = [],
        query: String = "", now: Int64 = nowMs(), zone: TimeZone = .current
    ) -> [DrawerGroup] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let list = sessions.filter { Panel.shown($0) && (mode == nil || StartMode.of($0) == mode) }
            .enumerated().sorted { ($0.element.updatedAt, -$0.offset) > ($1.element.updatedAt, -$1.offset) }.map(\.element)
        var out: [DrawerGroup] = []
        for s in list {
            let (key, title) = s.pinned ? (pinned, "Pinned") : by == .project ? projectGroup(s) : timeGroup(s.updatedAt, now: now, zone: zone)
            if !needle.isEmpty && !matches(s, needle, key.hasPrefix("p:") ? title : "") { continue }
            let row = Recent(id: s.id, title: Panel.title(s), isChat: s.isChat, dot: Panel.dot(s, asked: waiting.contains(s.id)))
            if let i = out.firstIndex(where: { $0.key == key }) { out[i].items.append(row) } else { out.append(DrawerGroup(key: key, title: title, items: [row])) }
        }
        let tail = [noProject, chats]
        return out.filter { $0.key == pinned } + out.filter { $0.key != pinned && !tail.contains($0.key) }
            + tail.flatMap { k in out.filter { $0.key == k } }
    }

    /// Today, Yesterday, This week (the 7 days before), Older.
    public static func timeGroup(_ ts: Int64, now: Int64 = nowMs(), zone: TimeZone = .current) -> (String, String) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let day = { (ms: Int64) in cal.startOfDay(for: Date(timeIntervalSince1970: Double(ms) / 1000)) }
        let days = cal.dateComponents([.day], from: day(ts), to: day(now)).day ?? 0
        switch days {
        case ...0: return ("today", "Today")
        case 1: return ("yesterday", "Yesterday")
        case 2..<7: return ("week", "This week")
        default: return ("older", "Older")
        }
    }

    /// Chats under Chats; a session under its project id, else its folder; no folder under No project.
    public static func projectGroup(_ s: Session) -> (String, String) {
        if s.isChat { return (chats, "Chats") }
        let cwd = trim(s.cwd)
        if cwd.isEmpty || cwd == "~" || cwd == "/" || cwd == "." { return (noProject, "No project") }
        let folder = lastSegment(cwd)
        if let p = s.projectId { return ("p:\(p)", folder) }
        return ("f:\(folder.lowercased())", folder)
    }

    private static func matches(_ s: Session, _ needle: String, _ group: String) -> Bool {
        if Panel.title(s).lowercased().contains(needle) { return true }
        if s.isChat { return false }
        return [s.agent, lastSegment(trim(s.cwd)), group].contains { $0.lowercased().contains(needle) }
    }

    private static func trim(_ p: String) -> String {
        var s = p
        while s.count > 1, s.last == "/" || s.last == "\\" { s.removeLast() }
        return s
    }

    private static func lastSegment(_ path: String) -> String {
        path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    }
}
