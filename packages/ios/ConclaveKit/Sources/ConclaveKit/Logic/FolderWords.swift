import Foundation

// The folder picker of a new Code session and the Search page (web features/home/FolderPicker.tsx
// recentFolders, filterFolders, crumbs; Android logic/Locations.kt and Start.computers; web
// SessionList snippetParts).

/// A folder the picker offers: the project's or folder's name, and the path under it when the name alone is not clear.
public struct FolderRow: Sendable, Hashable, Identifiable {
    public var path: String
    public var name: String
    public var detail: String?
    public var projectId: String?

    public var id: String { path }

    public init(path: String, name: String, detail: String? = nil, projectId: String? = nil) {
        self.path = path
        self.name = name
        self.detail = detail
        self.projectId = projectId
    }
}

/// One step of the folder browser's breadcrumb.
public struct Crumb: Sendable, Hashable {
    public var name: String
    public var path: String

    public init(name: String, path: String) {
        self.name = name
        self.path = path
    }
}

public enum FolderWords {
    /// Without trailing slashes; "/" stays.
    static func trim(_ p: String) -> String {
        var s = p
        while s.count > 1, s.hasSuffix("/") || s.hasSuffix("\\") { s.removeLast() }
        return s
    }

    /// A path with ~ for the device's home.
    public static func tildePath(_ path: String, home: String?) -> String {
        guard let home, !home.isEmpty, home != "/", home != "~" else { return path }
        let h = trim(home)
        if path == h { return "~" }
        return path.hasPrefix(h + "/") ? "~" + String(path.dropFirst(h.count)) : path
    }

    /// A typed path back to a full one: "~/code" with home /home/kai is /home/kai/code.
    public static func expandTilde(_ typed: String, home: String?) -> String {
        let t = typed.trimmingCharacters(in: .whitespaces)
        guard let home, !home.isEmpty, home != "~" else { return t }
        let h = trim(home)
        if t == "~" { return h.isEmpty ? "/" : h }
        return t.hasPrefix("~/") ? h + String(t.dropFirst()) : t
    }

    /// The folder's own name ("portfolio").
    public static func baseName(_ path: String) -> String {
        let name = trim(path).split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        return name.isEmpty ? path : name
    }

    /// "/" (or "C:/" on Windows) first, then each folder with its own path.
    public static func crumbs(_ path: String) -> [Crumb] {
        let win = path.range(of: #"^[A-Za-z]:"#, options: .regularExpression) != nil
        let parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init)
        var out: [Crumb] = win ? [] : [Crumb(name: "/", path: "/")]
        var at = ""
        for (i, p) in parts.enumerated() {
            if win && i == 0 { at = p + "/" } else if at.isEmpty || at.hasSuffix("/") { at = (at.isEmpty ? "/" : at) + p } else { at += "/" + p }
            out.append(Crumb(name: p, path: at))
        }
        return out
    }

    /// The folder above, or nil at the top.
    public static func parent(_ path: String) -> String? {
        let c = crumbs(path)
        return c.count > 1 ? c[c.count - 2].path : nil
    }

    public static func join(_ dir: String, _ name: String) -> String {
        let d = trim(dir)
        return d.hasSuffix("/") ? d + name : d + "/" + name
    }

    /// What the browser lists: folders (and links that may be ones) by name; dot folders only when asked.
    public static func folders(_ entries: [FileEntry], hidden: Bool = false) -> [FileEntry] {
        entries.filter { $0.isFolder && (hidden || !$0.name.hasPrefix(".")) }
            .sorted { $0.name.lowercased() < $1.name.lowercased() }
    }

    /// The project whose folder on the device holds `abs`, the deepest one, and the path inside it.
    static func projectOf(_ projects: [Project], device: String, _ abs: String) -> (project: Project, rel: String)? {
        var best: (project: Project, rel: String, depth: Int)?
        for p in projects {
            for l in p.locations where l.device == device {
                let root = trim(l.path)
                guard !root.isEmpty, abs == root || abs.hasPrefix(root + "/") else { continue }
                if best == nil || root.count > best!.depth {
                    best = (p, abs == root ? "" : String(abs.dropFirst(root.count + 1)), root.count)
                }
            }
        }
        return best.map { (project: $0.project, rel: $0.rel) }
    }

    /// A row shows its path when the name is not the path's own, or two rows share a name.
    public static func withDetails(_ rows: [FolderRow], home: String? = nil) -> [FolderRow] {
        var count: [String: Int] = [:]
        for r in rows { count[r.name.lowercased(), default: 0] += 1 }
        return rows.map { r in
            let shown = tildePath(r.path, home: home)
            let plain = shown == r.name || shown == "~/" + r.name
            var out = r
            out.detail = (count[r.name.lowercased()] ?? 0) > 1 || !plain ? shown : nil
            return out
        }
    }

    /// Recent: the folders of recent sessions on the device, newest first, each once, at most `max`.
    /// Chats, the home folder and repository worktrees are left out; a project's folder reads by its name.
    public static func recent(_ sessions: [Session], projects: [Project] = [], device: String, home: String? = nil, max: Int = 8) -> [FolderRow] {
        var seen = Set<String>()
        var rows: [FolderRow] = []
        for s in sessions.sorted(by: { $0.updatedAt > $1.updatedAt }) {
            if rows.count >= max { break }
            guard s.device == device, !s.isChat, !s.cwd.isEmpty, s.cwd != "~", s.meta?["repo"] == nil else { continue }
            let abs = trim(expandTilde(s.cwd, home: home))
            if let home, abs == trim(home) { continue }
            guard seen.insert(abs).inserted else { continue }
            let hit = projectOf(projects, device: device, abs)
            let name = hit.map { $0.rel.isEmpty ? $0.project.name : "\($0.project.name)/\($0.rel)" } ?? baseName(abs)
            rows.append(FolderRow(path: s.cwd, name: name, projectId: hit?.project.id))
        }
        return withDetails(rows, home: home)
    }

    /// Rows whose name or path holds every word of the query, in any case.
    public static func filter(_ rows: [FolderRow], _ q: String) -> [FolderRow] {
        let words = SearchWords.words(q)
        guard !words.isEmpty else { return rows }
        return rows.filter { r in words.allSatisfy { r.name.lowercased().contains($0) || r.path.lowercased().contains($0) } }
    }

    /// What the folder list shows: Recent, or with a query the recent and project folders that match it.
    public static func choices(recent: [FolderRow], projects: [Project], device: String, query: String, home: String? = nil) -> [FolderRow] {
        guard !SearchWords.words(query).isEmpty else { return recent }
        let have = Set(recent.map { trim(expandTilde($0.path, home: home)) })
        let extra = projects.flatMap { p in
            p.locations.filter { $0.device == device }.map { FolderRow(path: tildePath($0.path, home: home), name: p.name, projectId: p.id) }
        }.filter { !have.contains(trim(expandTilde($0.path, home: home))) }
        return withDetails(filter(recent + extra, query), home: home)
    }

    /// Where a Code session can run, as the picker lists them: the hub first (even before the list is
    /// in), then online computers by name. Phones never run code.
    public static func computers(_ devices: [Device]) -> [Device] {
        let hub = devices.first { $0.id == "local" } ?? Device(id: "local", online: true)
        let phone = { (d: Device) in ["ios", "android"].contains(d.info?.platform.lowercased() ?? "") }
        return [hub] + devices.filter { $0.id != "local" && $0.online && !phone($0) }
            .sorted { DeviceWords.title($0).lowercased() < DeviceWords.title($1).lowercased() }
    }

    /// A place to run in a picker: a computer by its name, the hub as "conclave (hub)".
    public static func placeName(_ d: Device) -> String {
        let name = d.name.trimmingCharacters(in: .whitespaces)
        if d.id == "local" { return "\(name.isEmpty ? "conclave" : name) (hub)" }
        return name.isEmpty ? d.id : name
    }
}

/// A run of a hit's snippet: plain words, or words the query matched.
public struct SnippetPart: Sendable, Hashable {
    public var text: String
    public var match: Bool

    public init(_ text: String, match: Bool = false) {
        self.text = text
        self.match = match
    }
}

/// The message hits of one session, in the order the hub ranked them.
public struct HitGroup: Sendable, Hashable, Identifiable {
    public var sessionId: String
    public var title: String
    public var hits: [SearchHit]

    public var id: String { sessionId }
}

public enum SearchWords {
    /// Messages are searched from three letters on, as Android's list.
    public static let minMessageQuery = 3

    public static func words(_ q: String) -> [String] {
        q.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// Chats and sessions whose title holds every word of the query, newest first.
    public static func titleHits(_ sessions: [Session], _ q: String, max: Int = 20) -> [Session] {
        let ws = words(q)
        guard !ws.isEmpty else { return [] }
        return Array(sessions.filter { s in
            let t = Panel.title(s).lowercased()
            return Panel.shown(s) && ws.allSatisfy { t.contains($0) }
        }
        .sorted { $0.updatedAt > $1.updatedAt }
        .prefix(max))
    }

    /// Hits by session, each session where its best hit ranked. `titles` names a session the hub sent no title for.
    public static func groups(_ hits: [SearchHit], titles: [String: String] = [:]) -> [HitGroup] {
        var out: [HitGroup] = []
        for h in hits {
            if let i = out.firstIndex(where: { $0.sessionId == h.sessionId }) {
                out[i].hits.append(h)
            } else {
                let t = h.title.trimmingCharacters(in: .whitespaces)
                out.append(HitGroup(sessionId: h.sessionId, title: t.isEmpty ? titles[h.sessionId] ?? "Untitled" : t, hits: [h]))
            }
        }
        return out
    }

    /// The hub marks matches as [word] (sqlite snippet()); line breaks read as spaces.
    public static func snippet(_ raw: String) -> [SnippetPart] {
        var out: [SnippetPart] = []
        var plain = ""
        func flush() {
            if !plain.isEmpty { out.append(SnippetPart(plain)) }
            plain = ""
        }
        var i = raw.startIndex
        while i < raw.endIndex {
            let next = raw.index(after: i)
            // a mark holds 1 to 80 characters and no line break
            if raw[i] == "[", let close = raw[next...].prefix(81).firstIndex(where: { $0 == "]" || $0 == "\n" }), raw[close] == "]", close > next {
                flush()
                out.append(SnippetPart(String(raw[next..<close]), match: true))
                i = raw.index(after: close)
                continue
            }
            plain.append(raw[i] == "\n" ? " " : raw[i])
            i = next
        }
        flush()
        return out
    }
}
