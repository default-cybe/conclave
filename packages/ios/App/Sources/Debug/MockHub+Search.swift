#if DEBUG
import Foundation

/// The mock hub's search, projects and folders, for the Search page and the new session sheet.
extension MockHub {
    /// Status and JSON body for the routes of search and the folder picker; nil for every other route.
    static func searchReply(_ method: String, _ url: URL, _ body: Data?) -> (Int, String)? {
        let p = url.path.split(separator: "/").map(String.init)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let arg = { (name: String) in query.first { $0.name == name }?.value ?? "" }
        guard method == "GET", p.first == "api" else { return nil }
        if p == ["api", "search"] { return (200, searchHits(arg("q"))) }
        if p == ["api", "projects"] { return (200, searchProjects) }
        guard p.count == 4, p[1] == "devices" else { return nil }
        let home = searchHomes[p[2]] ?? "/root"
        switch p[3] {
        case "folder":
            let path = arg("path")
            let abs = path == "~" ? home : path.hasPrefix("~/") ? home + String(path.dropFirst()) : path
            return (200, #"{"path":"\#(abs)","exists":true}"#)
        case "files":
            let path = arg("path")
            guard let names = searchTree[path] else { return (404, #"{"error":"ENOENT: no such file or directory, scandir '\#(path)'"}"#) }
            let entries = names.map { n -> String in
                let dir = !n.contains(".") || n.hasPrefix(".")
                let full = (path == "/" ? "" : path) + "/" + n
                let tail = dir ? #""type":"dir""# : #""type":"file","size":2048"#
                return #"{"name":"\#(n)","path":"\#(full)",\#(tail)}"#
            }
            return (200, "[" + entries.joined(separator: ",") + "]")
        default:
            return nil
        }
    }

    private static let searchHomes = ["local": "/home/conclave", "d1": "/Users/kai", "d2": "C:/Users/kai", "d3": "/root"]

    /// Folder listings by path; a name with a dot (not leading) is a file.
    private static let searchTree: [String: [String]] = [
        "/": ["home", "root", "srv", "etc"],
        "/home": ["conclave"],
        "/home/conclave": [".cache", ".config", "work", "notes", "README.md"],
        "/home/conclave/work": ["conclave", "kener-theme", "cv-ios", "resume-tool"],
        "/home/conclave/work/conclave": [".git", "packages", "docs", "scripts", "package.json"],
        "/home/conclave/work/conclave/packages": ["android", "core", "ios", "server", "web"],
        "/home/conclave/work/kener-theme": ["src", "theme.css"],
        "/home/conclave/notes": [],
        "/srv": ["media", "backups"],
        "/Users/kai": [".ssh", "Desktop", "Documents", "code", "fuzz"],
        "/Users/kai/code": ["conclave", "portfolio"],
        "/Users/kai/fuzz": ["audiotoolbox", "coremedia"],
    ]

    private static let searchProjects = """
    [{"id":"p1","name":"conclave","locations":[
       {"projectId":"p1","device":"local","path":"/home/conclave/work/conclave","pinned":true},
       {"projectId":"p1","device":"d1","path":"/Users/kai/code/conclave"}]},
     {"id":"p2","name":"kener-theme","locations":[{"projectId":"p2","device":"local","path":"/home/conclave/work/kener-theme"}]},
     {"id":"p3","name":"portfolio","locations":[{"projectId":"p3","device":"d1","path":"/Users/kai/code/portfolio"}]}]
    """

    /// Message hits shaped as engine.search: matches in [brackets], the session's title beside each.
    private static func searchHits(_ q: String) -> String {
        let q = q.lowercased()
        if q.contains("passkey") {
            return """
            [{"sessionId":"s2","messageId":"s2-m4","snippet":"…the login redirect breaks when the [passkey] prompt is dismissed on Safari, then the hub…","title":"Fix login redirect after the passkey prompt is dismissed on Safari and the hub restarts"},
             {"sessionId":"s2","messageId":"s2-m9","snippet":"Cancel on the [passkey] sheet now returns to /login with the next url kept.","title":"Fix login redirect after the passkey prompt is dismissed on Safari and the hub restarts"},
             {"sessionId":"s7","messageId":"s7-m3","snippet":"…jose verifies the session token; the [passkey] assertion still goes through webauthn.ts…","title":"Move auth middleware to jose"},
             {"sessionId":"s1","messageId":"m9","snippet":"Sign in on the iPad: pairing code first, [passkey] later through ASAuthorization.","title":"Native iPad client plan"}]
            """
        }
        if q.contains("backup") {
            return """
            [{"sessionId":"s3","messageId":"s3-m2","snippet":"…prune keeps 7 daily and 4 weekly [backup] snapshots on PBS…","title":"Backup script for PBS"},
             {"sessionId":"s8","messageId":"s8-m5","snippet":"pgBackRest does incremental [backup] and parallel restore; Barman…","title":"Compare Postgres backup tools: pgBackRest, Barman, WAL-G and plain pg_dump on a 40 GB database"}]
            """
        }
        return "[]"
    }
}
#endif
