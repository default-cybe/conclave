#if DEBUG
import ConclaveKit
import Foundation
import os

/// `-mockHub`: a paired hub with fixed sessions and one transcript, served by URLProtocol, and a
/// socket that says hello and stays open. For CI screenshots only; never in a release build.
enum MockHub {
    @MainActor
    static func appModel() -> AppModel {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [MockProtocol.self]
        return AppModel(store: Store(), session: URLSession(configuration: c), transport: Socket(), checksIdentity: false)
    }

    struct Store: PairingStore {
        func load() -> SavedPairing? { SavedPairing(addresses: ["https://hub.mock.test"], token: "mock", hubName: "homelab", publicKey: nil) }
        func save(_ p: SavedPairing?) {}
    }

    struct Socket: LiveTransport, LiveConnection {
        func connect(_ request: URLRequest) async throws -> any LiveConnection { self }
        func send(_ text: String) async throws {}
        func receive() async throws -> String {
            if await Gate.shared.first() { return #"{"type":"hello","seq":1}"# }
            try await Task.sleep(for: .seconds(3600))
            throw URLError(.networkConnectionLost)
        }
        func close() {}
    }

    actor Gate {
        static let shared = Gate()
        private var said = false
        func first() -> Bool { defer { said = true }; return !said }
    }

    /// Status and JSON body for a request, shaped as the hub answers it.
    static func reply(_ method: String, _ path: String, _ body: Data?) -> (Int, String) {
        let p = path.split(separator: "/").map(String.init) // ["api", "sessions", id, ...]
        if p.count >= 3, p[0] == "api", p[1] == "sessions" {
            let id = p[2]
            // PATCH and seen answer with the session, as GET does
            if p.count == 3 || (p.count == 4 && p[3] == "seen") { return session(id, patch: method == "PATCH" ? body : nil) }
            if p.count == 4, p[3] == "messages" { return (200, method == "POST" ? #"{"messageId":"m-sent"}"# : messages) }
        }
        if path == "/api/sessions" { return (200, json(sessionList())) }
        if path == "/api/approvals" { return (200, approvals) }
        if path == "/api/questions" { return (200, questions) }
        if path == "/api/models" { return (200, models) }
        return (200, "[]")
    }

    /// PATCHed sessions as JSON, so a model pick outlives the next list load. JSON Data keeps the lock state Sendable.
    private static let edited = OSAllocatedUnfairLock(initialState: [String: Data]())

    private static func sessionList() -> [[String: Any]] {
        let base = (try? JSONSerialization.jsonObject(with: Data(sessions.utf8))) as? [[String: Any]] ?? []
        let edits = edited.withLock { $0 }
        return base.map { s in
            (s["id"] as? String).flatMap { edits[$0] }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? s
        }
    }

    /// One session; a patch merges in (chat settings key by key) and is kept, as the hub does.
    private static func session(_ id: String, patch: Data?) -> (Int, String) {
        guard var s = sessionList().first(where: { $0["id"] as? String == id }) else { return (404, #"{"error":"Session not found"}"#) }
        if let patch, let changes = (try? JSONSerialization.jsonObject(with: patch)) as? [String: Any] {
            for (k, v) in changes {
                if k == "chat", let c = v as? [String: Any] {
                    s[k] = ((s[k] as? [String: Any]) ?? [:]).merging(c) { $1 }
                } else {
                    s[k] = v
                }
            }
            s["updatedAt"] = Int64(Date().timeIntervalSince1970 * 1000)
            let saved = Data(json(s).utf8)
            edited.withLock { $0[id] = saved }
        }
        return (200, json(s))
    }

    private static func json(_ v: Any) -> String {
        String(decoding: (try? JSONSerialization.data(withJSONObject: v)) ?? Data("null".utf8), as: UTF8.self)
    }

    private static let now = Int64(Date().timeIntervalSince1970 * 1000)
    private static func ago(_ h: Double) -> Int64 { now - Int64(h * 3_600_000) }

    static var sessions: String {
        """
        [
         {"id":"s1","title":"Native iPad client plan","kind":"chat","model":"anthropic/claude-opus-5-5","chat":{"thinking":"high"},"updatedAt":\(ago(0.2))},
         {"id":"s2","title":"Fix login redirect","agent":"coder","cwd":"/home/sam/conclave","status":"running","updatedAt":\(ago(1))},
         {"id":"s3","title":"Backup script for PBS","agent":"coder","cwd":"/srv/backup","status":"waiting_approval","updatedAt":\(ago(3))},
         {"id":"s4","title":"Trip to Lisbon","kind":"chat","pinned":true,"updatedAt":\(ago(30))},
         {"id":"s5","title":"Weekly plan","kind":"chat","updatedAt":\(ago(50))},
         {"id":"s6","title":"Sonarr episodes","agent":"coder","cwd":"/srv/media","updatedAt":\(ago(200))}
        ]
        """
    }

    static let approvals = """
    [{"id":"ap1","sessionId":"s1-sub","rootSessionId":"s1","tool":"Bash","summary":"Run: xcodegen generate","suggestedRule":"Bash(xcodegen:*)",
      "input":{"command":"xcodegen generate"},"from":{"sessionId":"s1-sub","agent":"builder","label":"build the app","chain":["s1-sub"]}}]
    """

    static let questions = """
    [{"id":"q1","sessionId":"s1","questions":[{"question":"Which layout should the iPad open with?","header":"Layout","options":[
      {"label":"Sidebar and chat","description":"Two columns, the list always in view"},
      {"label":"Chat only","description":"The sidebar slides in on demand"}]}]}]
    """

    static let models = """
    [{"provider":"anthropic","name":"Anthropic","enabled":true,"configured":true,"models":[
      {"id":"claude-opus-5-5","ref":"anthropic/claude-opus-5-5","name":"Claude Opus 5.5","effort":{"levels":["low","medium","high","xhigh","max"],"default":"medium"}},
      {"id":"claude-sonnet-5-5","ref":"anthropic/claude-sonnet-5-5","name":"Claude Sonnet 5.5","effort":{"levels":["low","medium","high"],"default":"medium"}}]}]
    """

    /// The composer as the screenshots show it: words and one picture.
    @MainActor
    static func fillComposer(_ chat: ChatModel) {
        guard chat.draft.isEmpty else { return }
        chat.draft = "Here is the sidebar sketch, does the spacing match Android?"
        chat.files = [Attachment(mediaType: "image/png", data: png, name: "sidebar-sketch.png")]
    }

    // a 16x16 purple PNG
    private static let png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHUlEQVR4nGOs2vSAgRTARJLqUQ2jGkY1jGoYQhoAqpACKZMzvwUAAAAASUVORK5CYII="

    static var messages: String {
        let answer = """
        ## The plan\\n\\nPhase 2 reads chats. It uses **swift-markdown** and our own renderer, with `inline code` and [a link](https://example.com).\\n\\n1. Sidebar grouped by project\\n2. Transcript with older pages\\n3. Pictures decoded at display size\\n\\n- [x] Connect\\n- [ ] Composer\\n\\n```swift\\nlet page = try await client.messages(id, limit: TranscriptReducer.page, trim: true)\\ntranscript = TranscriptReducer.loaded(transcript, page, paged: true)\\n```\\n\\n| Phase | Scope | State |\\n|---|---|---|\\n| 1 | Kit, connect | done |\\n| 2 | Read chats | now |\\n\\n> Composer and approvals come in phase 3.
        """
        return """
        [
         {"id":"m1","sessionId":"s1","seq":1,"role":"user","content":[{"type":"text","text":"How should the native iPad client read chats?"}]},
         {"id":"m2","sessionId":"s1","seq":2,"role":"assistant","content":[
           {"type":"thinking","thinking":"Port the Android transcript logic first.","durationMs":4000},
           {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls packages/ios"}},
           {"type":"text","text":"\(answer)"}]},
         {"id":"m3","sessionId":"s1","seq":3,"role":"user","content":[{"type":"tool_result","toolUseId":"t1","content":"App\\nConclaveKit\\nproject.yml"}]},
         {"id":"m4","sessionId":"s1","seq":4,"role":"user","content":[{"type":"text","text":"Here is the icon colour."},{"type":"image","mediaType":"image/png","data":"\(png)"}]}
        ]
        """
    }
}

final class MockProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        let (status, text) = MockHub.reply(request.httpMethod ?? "GET", url.path, Self.body(request))
        let res = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    /// URLSession hands a protocol the body as a stream, not httpBody.
    private static func body(_ r: URLRequest) -> Data? {
        if let b = r.httpBody { return b }
        guard let s = r.httpBodyStream else { return nil }
        s.open()
        defer { s.close() }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = s.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            out.append(buf, count: n)
        }
        return out
    }
}
#endif
