import Foundation

// Repo sessions (core client/github.ts; Android model/Github.kt and logic/RepoWords.kt): a session in
// its own git worktree on its own branch; the hub pushes it, opens the pull request, merges a folder
// worktree into its base and cleans up. State words stay strings so a newer value still decodes.

public struct PullRequestRef: Sendable, Hashable, Decodable {
    public var number = 0
    public var url = ""
    /// open, merged or closed
    public var state = "open"
    public var draft = false

    public init(number: Int, url: String = "", state: String = "open", draft: Bool = false) {
        self.number = number
        self.url = url
        self.state = state
        self.draft = draft
    }

    private enum K: String, CodingKey { case number, url, state, draft }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        number = try c.or(.number, 0)
        url = try c.or(.url, "")
        state = try c.or(.state, "open")
        draft = try c.or(.draft, false)
    }
}

/// GET /api/sessions/:id/repo: the repo session in full.
public struct RepoSession: Sendable, Hashable, Decodable {
    public var repo = ""
    public var branch = ""
    public var base = ""
    public var pr: PullRequestRef?
    /// pending, success, failure or none
    public var ci: String?
    public var cleaned = false
    public var deviceName = ""
    public var commits: Int?
    public var dirty: Int?
    /// never, current or behind
    public var pushed = "never"
    public var canCleanUp = false
    public var folder = false
    public var merged = false
    /// Push and Open pull request can work; nil (an older hub): they can.
    public var pullRequests: Bool?
    public var canMerge = false
    public var online = false
    /// One plain sentence about where things stand.
    public var line = ""

    public init(repo: String = "", branch: String = "", base: String = "main") {
        self.repo = repo
        self.branch = branch
        self.base = base
    }

    private enum K: String, CodingKey { case repo, branch, base, pr, ci, cleaned, deviceName, commits, dirty, pushed, canCleanUp, folder, merged, pullRequests, canMerge, online, line }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        repo = try c.or(.repo, "")
        branch = try c.or(.branch, "")
        base = try c.or(.base, "")
        pr = try? c.opt(.pr)
        ci = try? c.opt(.ci)
        cleaned = try c.or(.cleaned, false)
        deviceName = try c.or(.deviceName, "")
        commits = try? c.opt(.commits)
        dirty = try? c.opt(.dirty)
        pushed = try c.or(.pushed, "never")
        canCleanUp = try c.or(.canCleanUp, false)
        folder = try c.or(.folder, false)
        merged = try c.or(.merged, false)
        pullRequests = try? c.opt(.pullRequests)
        canMerge = try c.or(.canMerge, false)
        online = try c.or(.online, false)
        line = try c.or(.line, "")
    }
}

public struct PrDraft: Sendable, Hashable, Decodable {
    public var title = ""
    public var body = ""
    public var base = ""
    public var head = ""

    private enum K: String, CodingKey { case title, body, base, head }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        title = try c.or(.title, "")
        body = try c.or(.body, "")
        base = try c.or(.base, "")
        head = try c.or(.head, "")
    }
}

public struct PushResult: Sendable, Hashable, Decodable {
    public var pushed = false
    public var line = ""

    private enum K: String, CodingKey { case pushed, line }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        pushed = try c.or(.pushed, false)
        line = try c.or(.line, "")
    }
}

public enum RepoWords {
    public struct Actions: Sendable, Hashable {
        public var push = false
        public var openPr = false
        public var viewPr = false
        public var cleanUp = false
        public var merge = false
        public var discard = false
    }

    /// The branch without the conclave/ every repo session branch starts with.
    public static func branchShort(_ b: String) -> String { b.hasPrefix("conclave/") ? String(b.dropFirst(9)) : b }

    /// "acme/widgets on fix-login-ab12".
    public static func whereLine(_ r: RepoSession) -> String { "\(r.repo.isEmpty ? "This folder" : r.repo) on \(branchShort(r.branch))" }

    /// Which actions the session offers now (Android RepoWords.actions, canMerge, canDiscard).
    public static func actions(_ r: RepoSession) -> Actions {
        var a = Actions()
        a.viewPr = r.pr.map { $0.url.hasPrefix("https://") || $0.url.hasPrefix("http://") } ?? false
        a.merge = r.folder && !r.cleaned && r.online && r.canMerge
        a.discard = r.folder && !r.cleaned && r.online && !r.merged
        if r.cleaned { return Actions(viewPr: a.viewPr) }
        a.cleanUp = r.canCleanUp
        // a folder worktree with no GitHub origin, or GitHub not connected: nothing to push to
        if r.pullRequests == false { return a }
        let commits = r.commits ?? 0, dirty = r.dirty ?? 0
        let live = r.pr?.state == "open"
        let done = r.pr != nil && !live
        a.push = r.online && !done && (r.pushed == "behind" || (r.pushed == "never" && (commits > 0 || dirty > 0)) || (live && dirty > 0))
        a.openPr = r.online && !live && !done && (commits > 0 || dirty > 0)
        return a
    }

    /// The tone of the line: ok (merged, checks passed), fault (a check failed), live (checks run), quiet.
    public static func tone(_ r: RepoSession) -> String {
        guard let pr = r.pr, !r.cleaned else { return "quiet" }
        if pr.state == "merged" { return "ok" }
        if pr.state == "closed" { return "quiet" }
        switch r.ci {
        case "failure": return "fault"
        case "pending": return "live"
        case "success": return "ok"
        default: return "quiet"
        }
    }

    /// "2 files are not committed."
    public static func dirtyWords(_ n: Int) -> String { "\(n) \(n == 1 ? "file is" : "files are") not committed." }

    /// The commit message the dialogs start with: the session's title, else a plain one.
    public static func commitMessage(_ title: String) -> String {
        let t = title.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || t == "New chat" || t == "New session" ? "Work from Conclave" : t
    }

    /// What Clean up does, before it asks.
    public static func cleanUpBody(_ r: RepoSession) -> String {
        let dev = r.deviceName.isEmpty ? "the device" : r.deviceName
        let dirty = r.dirty ?? 0
        let lost = dirty > 0 ? " \(dirtyWords(dirty)) They are lost." : ""
        if r.folder && r.pr == nil { return "The worktree on \(dev) and \(branchShort(r.branch)) go." + lost }
        return "The worktree on \(dev) goes. \(branchShort(r.branch)) stays on GitHub." + lost + (r.canCleanUp ? "" : " The pull request is not merged or closed yet.")
    }

    /// What Discard loses, before it asks.
    public static func discardBody(_ r: RepoSession) -> String {
        let dev = r.deviceName.isEmpty ? "the device" : r.deviceName
        let commits = r.commits ?? 0, dirty = r.dirty ?? 0
        return "The worktree on \(dev) and \(branchShort(r.branch)) go."
            + (commits > 0 ? " \(commits) \(commits == 1 ? "commit is" : "commits are") not merged and are lost." : "")
            + (dirty > 0 ? " \(dirtyWords(dirty)) They are lost." : "")
    }
}

extension ConclaveClient {
    /// Nil for a session that is not a repo session (the hub answers 404).
    public func repoSession(_ id: String, refresh: Bool = false) async throws -> RepoSession? {
        do {
            return try await get(["api", "sessions", id, "repo"], query: refresh ? [("refresh", "1")] : [])
        } catch let e as ConclaveAPIError where e.status == 404 {
            return nil
        }
    }

    /// With a message, what is not committed goes in a commit first.
    public func pushRepo(_ id: String, commitMessage: String?) async throws -> PushResult {
        var b: JSONObject = [:]
        if let commitMessage, !commitMessage.isEmpty { b["commitMessage"] = .string(commitMessage) }
        return try await send("POST", ["api", "sessions", id, "repo", "push"], JSONValue.object(b))
    }

    public func prDraft(_ id: String) async throws -> PrDraft { try await get(["api", "sessions", id, "repo", "pr-draft"]) }

    public func openPullRequest(_ id: String, title: String, body: String, draft: Bool) async throws -> RepoSession {
        try await send("POST", ["api", "sessions", id, "repo", "pr"], JSONValue.object(["title": .string(title), "body": .string(body), "draft": .bool(draft)]))
    }

    public func cleanUpRepo(_ id: String, force: Bool, discard: Bool) async throws -> RepoSession {
        try await send("POST", ["api", "sessions", id, "repo", "cleanup"], JSONValue.object(["force": .bool(force), "discard": .bool(discard)]))
    }

    public func mergeRepo(_ id: String, squash: Bool) async throws -> RepoSession {
        try await send("POST", ["api", "sessions", id, "repo", "merge"], JSONValue.object(["squash": .bool(squash)]))
    }
}
