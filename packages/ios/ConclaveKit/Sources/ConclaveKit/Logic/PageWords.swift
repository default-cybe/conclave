import Foundation

/// The pictures of a chat in reading order, for the media viewer's swipe (Android logic/Media.kt,
/// web ImageViewer's gallery): pictures in messages, and each tool's pictures where its call sits.
public enum Gallery {
    /// A tool result's image part as the transcript draws it: the hub's {data} or Anthropic's
    /// {source: {data}}, or the url a trimmed page left. Nil for any other part.
    public static func picture(_ part: JSONValue) -> MediaBlock? {
        guard part["type"]?.string == "image" else { return nil }
        let media = MediaBlock(mediaType: part["mediaType"]?.string ?? part["source"]?["media_type"]?.string ?? "image/png",
                               data: (part["data"] ?? part["source"]?["data"])?.string, url: part["url"]?.string)
        return media.data == nil && media.url == nil ? nil : media
    }

    public static func pictures(_ result: ToolResultBlock?) -> [MediaBlock] {
        guard let result, !result.isError, let parts = result.content.array else { return [] }
        return parts.compactMap(picture)
    }

    /// Every picture once, in order. A tool's results follow its call, not the message that carried them.
    public static func pictures(_ messages: [Message], toolResults: [String: ToolResultBlock]) -> [MediaBlock] {
        var out: [MediaBlock] = []
        var seen = Set<MediaBlock>()
        func add(_ m: MediaBlock) { if seen.insert(m).inserted { out.append(m) } }
        for msg in messages where msg.kind != .notice {
            for b in msg.content {
                switch b {
                case .image(let m) where m.data != nil || m.url != nil: add(m)
                case .toolUse(let u): pictures(toolResults[u.id]).forEach(add)
                default: break
                }
            }
        }
        return out
    }
}

/// Words for files (Android logic/FileCards.kt, web files/words.ts).
public enum FileWords {
    /// "512 B", "14.2 KB", "3.0 MB".
    public static func size(_ bytes: Int64) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        return String(format: "%.1f MB", kb / 1024)
    }

    /// "PDF", "PNG", "Markdown": the type in a word.
    public static func kind(_ mediaType: String, name: String = "") -> String {
        let t = mediaType.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        switch t {
        case "application/pdf": return "PDF"
        case "text/markdown": return "Markdown"
        case "text/plain": return "Text"
        case "text/html": return "HTML"
        case "image/svg+xml": return "SVG"
        case "image/jpeg": return "JPEG"
        default: break
        }
        if t.hasPrefix("image/") || t.hasPrefix("video/") || t.hasPrefix("audio/"), let sub = t.split(separator: "/").dropFirst().first { return sub.uppercased() }
        let ext = name.split(separator: ".").count > 1 ? name.split(separator: ".").last.map { $0.uppercased() } : nil
        return ext ?? "File"
    }

    /// "PDF, 14.2 KB"; the size left out when unknown.
    public static func facts(_ mediaType: String, size: Int64?, name: String = "") -> String {
        [kind(mediaType, name: name), size.map(self.size)].compactMap { $0 }.joined(separator: ", ")
    }

    public static func isPicture(_ mediaType: String) -> Bool {
        ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mediaType.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? "")
    }

    /// The web Files tab's groups in its order, each named; empty groups are left out.
    public static func groups(_ files: [SessionFile]) -> [(title: String, files: [SessionFile])] {
        let order: [(FileGroup, String)] = [(.generated, "Generated"), (.screenshot, "Screenshots"), (.uploaded, "Uploaded")]
        return order.compactMap { g, title in
            let f = files.filter { $0.group == g }
            return f.isEmpty ? nil : (title, f)
        }
    }

    /// A name safe to save under: no folders, never empty.
    public static func safeName(_ name: String) -> String {
        let base = name.split(separator: "/").last.map(String.init) ?? ""
        let clean = String(base.map { $0.isLetter || $0.isNumber || ".-_ ".contains($0) ? $0 : "_" }).trimmingCharacters(in: .whitespaces)
        return clean.isEmpty || clean.allSatisfy({ $0 == "." }) ? "file" : clean
    }
}

/// Short relative time: "now", "5m", "3h", "2d" (Android Time.ago, short form).
public enum Ago {
    public static func short(_ at: Int64, now: Int64) -> String {
        let s = max(0, (now - at) / 1000)
        if s < 60 { return "now" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86_400 { return "\(s / 3600)h" }
        return "\(s / 86_400)d"
    }
}

/// The pair sheet's words (Android logic/Pairing.kt PairingWords).
public enum PairingWords {
    public static func help(_ kind: PairKind) -> String {
        switch kind {
        case .app:
            "For the Conclave app on a phone or a computer, or a browser. Type the code there, or scan it with the Conclave app. It signs in as you."
        case .computer:
            "For a computer without the desktop app: install the conclave command there, then pair it with this code."
        }
    }

    public static func waiting(_ kind: PairKind) -> String { kind == .app ? "Waiting for the app" : "Waiting for the computer" }

    public static func expired(_ info: PairingInfo, now: Int64) -> Bool { info.expiresAt <= now }

    /// "9:42": the time left, rounded up, so the last second reads 0:01.
    public static func clock(_ info: PairingInfo, now: Int64) -> String {
        let s = max(0, (info.expiresAt - now + 999) / 1000)
        let h = s / 3600, m = (s % 3600) / 60, ss = String(format: "%02d", s % 60)
        return h > 0 ? "\(h):\(String(format: "%02d", m)):\(ss)" : "\(m):\(ss)"
    }

    /// "Expires in 9:42", or "Expired." once it ran out.
    public static func timer(_ info: PairingInfo, now: Int64) -> String { expired(info, now: now) ? "Expired." : "Expires in \(clock(info, now: now))" }

    /// What to run on the computer, at the address the code carries (or the one this app uses).
    public static func commands(_ info: PairingInfo, fallbackUrl: String? = nil) -> [String] {
        var base = (info.url.isEmpty ? fallbackUrl ?? "" : info.url).trimmingCharacters(in: .whitespaces)
        while base.hasSuffix("/") { base.removeLast() }
        return [install, "conclave daemon pair \(base) \(info.code)", "conclave daemon install --start"]
    }

    public static let install = "curl -fsSL https://github.com/default-cybe/conclave/releases/latest/download/install.sh | sh"

    /// The fingerprint in groups of four, easier to compare by eye.
    public static func grouped(_ fp: String) -> String {
        stride(from: 0, to: fp.count, by: 4).map { i in
            let a = fp.index(fp.startIndex, offsetBy: i)
            return String(fp[a..<(fp.index(a, offsetBy: 4, limitedBy: fp.endIndex) ?? fp.endIndex)])
        }.joined(separator: " ")
    }
}

/// The Devices page (Android DevicesScreen, web DevicesPage).
public enum DeviceWords {
    /// Online first, then by name; the hub's own row leads.
    public static func sorted(_ devices: [Device]) -> [Device] {
        devices.sorted { a, b in
            if (a.id == "local") != (b.id == "local") { return a.id == "local" }
            if a.online != b.online { return a.online }
            return title(a).localizedCaseInsensitiveCompare(title(b)) == .orderedAscending
        }
    }

    public static func title(_ d: Device) -> String { d.name.trimmingCharacters(in: .whitespaces).isEmpty ? d.id : d.name }

    /// "macbook, darwin arm64"; blank parts left out.
    public static func meta(_ d: Device) -> String {
        guard let i = d.info else { return "" }
        let sys = [i.platform, i.arch].filter { !$0.isEmpty }.joined(separator: " ")
        return [i.hostname, sys].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// "online", "seen 3h ago", "offline".
    public static func state(_ d: Device, now: Int64) -> String {
        if d.online { return "online" }
        guard let at = d.lastSeenAt else { return "offline" }
        let a = Ago.short(at, now: now)
        return a == "now" ? "seen just now" : "seen \(a) ago"
    }

    /// "2 online, 1 offline".
    public static func summary(_ devices: [Device]) -> String {
        let on = devices.filter(\.online).count
        return "\(on) online, \(devices.count - on) offline"
    }
}

/// The Inbox (Android logic/Inbox.kt, ApprovalsScreen): what waits on you across sessions.
public enum InboxWords {
    private static let run = try! NSRegularExpression(pattern: #"^(run|bash)\s*:\s*"#, options: .caseInsensitive)

    private static func stripRun(_ s: String) -> (Bool, String) {
        let r = NSRange(s.startIndex..., in: s)
        guard let m = run.firstMatch(in: s, range: r) else { return (false, s) }
        return (true, String(s[Range(m.range, in: s)!.upperBound...]))
    }

    /// An approval's label and line: "Wants to run" with the command, else "Wants to use Edit" with the summary.
    public static func approvalLines(_ tool: String, _ summary: String, input: JSONObject? = nil) -> (label: String, line: String) {
        let s = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let command = input?["command"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        let (shell, rest) = stripRun(s)
        if tool.lowercased() == "bash" || shell {
            if let command, !command.isEmpty { return ("Wants to run", command) }
            return ("Wants to run", rest.trimmingCharacters(in: .whitespaces).isEmpty ? tool : rest)
        }
        return ("Wants to use \(tool.isEmpty ? "a tool" : tool)", s.isEmpty ? tool : s)
    }

    /// "Asks: Keep the old API route?".
    public static func questionLine(_ q: QuestionRequest) -> String {
        let first = q.questions.first?.question.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").first.map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first, !first.isEmpty else { return "Asks a question" }
        return "Asks: \(first)"
    }

    public static let empty = "Nothing waits on you."
}

/// A session's background work as rows (Android logic/TaskKinds.kt and Tasks.kt, here from the
/// sessions it started): the agent's glyph and the state in a word.
public enum TaskGlyph: Sendable { case flow, device, search, build, test, review, debug, research, design, verify, bot }

public enum TaskKinds {
    private static let agents: [String: TaskGlyph] = [
        "explore": .search, "builder": .build, "tester": .test, "reviewer": .review,
        "debugger": .debug, "researcher": .research, "designer": .design, "verifier": .verify,
    ]

    /// The agent's own glyph, a bot when it has none.
    public static func glyph(agent: String?) -> TaskGlyph { agent.flatMap { agents[$0.lowercased()] } ?? .bot }

    public enum Tone: Sendable { case live, waits, failed, quiet }

    /// The state in a word and its tone: running in signal, waiting in amber, failed in fault.
    public static func state(_ s: Session) -> (word: String, tone: Tone) {
        switch s.status {
        case .running: ("running", .live)
        case .waitingApproval, .waitingInput: ("waiting on you", .waits)
        case .waitingReset: ("resumes later", .quiet)
        case .paused: ("paused", .quiet)
        case .error: ("failed", .failed)
        case .idle: ("done", .quiet)
        }
    }

    /// "Subagent explore" or "Subagent" without an agent.
    public static func who(_ s: Session) -> String { s.agent.isEmpty ? "Subagent" : "Subagent \(s.agent)" }

    /// Live ones first, each group newest first.
    public static func sorted(_ children: [Session]) -> [Session] {
        children.sorted { a, b in
            let la = state(a).tone == .live || state(a).tone == .waits, lb = state(b).tone == .live || state(b).tone == .waits
            return la != lb ? la : a.updatedAt > b.updatedAt
        }
    }

    /// "2 running, 1 failed" for the Tasks pane's head; "No tasks" when there are none.
    public static func summary(_ children: [Session]) -> String {
        guard !children.isEmpty else { return "No tasks" }
        let running = children.filter { state($0).tone == .live || state($0).tone == .waits }.count
        let failed = children.filter { $0.status == .error }.count
        var parts = ["\(children.count) \(children.count == 1 ? "task" : "tasks")"]
        if running > 0 { parts.append("\(running) running") }
        if failed > 0 { parts.append("\(failed) failed") }
        return parts.joined(separator: ", ")
    }
}
