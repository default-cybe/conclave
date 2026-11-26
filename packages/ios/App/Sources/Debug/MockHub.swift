#if DEBUG
import ConclaveKit
import Foundation

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

    static func reply(_ path: String) -> String {
        if path.hasSuffix("/messages") { return messages }
        if path == "/api/sessions" { return sessions }
        if path == "/api/approvals" { return approvals }
        if path == "/api/questions" { return questions }
        if path == "/api/models" { return models }
        return "[]"
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
        let body = Data(MockHub.reply(url.path).utf8)
        let res = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
#endif
