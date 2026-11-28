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
        func load() -> SavedPairing? { SavedPairing(addresses: ["https://conclave.tail4e2c.ts.net"], token: "mock", hubName: "conclave", publicKey: nil, clientId: "cli_mock") }
        func save(_ p: SavedPairing?) {}
        // two accounts, for the account menu's Switch account
        func loadAccounts() -> SavedAccounts {
            let sam = try? JSONDecoder().decode(AccountRef.self, from: Data(#"{"id":"sam","name":"sam","role":"member"}"#.utf8))
            return SavedAccounts(list: [load()!, SavedPairing(addresses: ["https://work.example.com"], token: "mock2", hubName: "work", account: sam)], active: 0)
        }
        func saveAccounts(_ a: SavedAccounts) {}
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
    static func reply(_ method: String, _ url: URL, _ body: Data?) -> (Int, String) {
        let path = url.path
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let p = path.split(separator: "/").map(String.init) // ["api", "sessions", id, ...]
        // each page's own routes (MockHub+*.swift) before the shared ones
        for r in [actionsReply, devicesReply, searchReply, memoryReply, boardReply] {
            if let hit = r(method, url, body) { return hit }
        }
        if p.count >= 3, p[0] == "api", p[1] == "sessions" {
            let id = p[2]
            if p.count == 4, p[3] == "files" { return (200, files) }
            // PATCH and seen answer with the session, as GET does
            if p.count == 3 || (p.count == 4 && p[3] == "seen") { return session(id, patch: method == "PATCH" ? body : nil) }
            if p.count == 4, p[3] == "messages" { return (200, method == "POST" ? #"{"messageId":"m-sent"}"# : messages) }
            // a block of the transcript (the Files tab's uploaded picture): every one is the picture
            if p.count == 7, p[3] == "messages", p[5] == "blocks" { return (200, #"{"type":"image","mediaType":"image/png","data":"\#(png)"}"#) }
        }
        if path == "/api/sessions", let parent = query.first(where: { $0.name == "parentId" })?.value, parent != "none" {
            return (200, parent == "s1" ? children : "[]")
        }
        if path == "/api/sessions", method == "POST" {
            // a new session, as the hub makes it: the person's default model filled in
            let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            var s: [String: Any] = ["id": "new-\(UUID().uuidString.prefix(6))", "title": "", "model": "anthropic/claude-opus-5-5", "updatedAt": now]
            for k in ["kind", "agent", "cwd", "device"] { if let v = input[k] { s[k] = v } }
            return (200, json(s))
        }
        if path == "/api/sessions" { return (200, json(sessionList())) }
        if path == "/api/devices" { return (200, devices) }
        if path == "/api/pairing" {
            return (200, #"{"code":"K7QM-4XPD","url":"https://hub.mock.test","deepLink":"conclave://pair?url=https%3A%2F%2Fhub.mock.test&code=K7QM-4XPD","expiresAt":\#(Int64(Date().timeIntervalSince1970 * 1000) + 582_000),"fingerprint":"9f3ac1e07b52d4e8"}"#)
        }
        // the owner's real shape: sign-in name "owner", the name to show set apart, several people
        if path == "/api/me" { return (200, method == "PATCH" ? #"{"ok":true}"# : #"{"id":"owner","name":"owner","displayName":"Kai","role":"owner","email":"kai@dymnitguys.com","people":true,"preferences":{"defaultModel":"anthropic/claude-opus-5-5"}}"#) }
        if path == "/api/info" { return (200, #"{"name":"conclave","version":"0.4.107","defaultModel":"anthropic/claude-sonnet-5-5"}"#) }
        if path == "/api/config" {
            if method == "PATCH" { return (200, #"{"ok":true}"#) }
            return (200, #"{"config":{"ui":{"name":"Kai"},"smallModel":"anthropic/claude-haiku-5","models":{"tiers":{"deep":"anthropic/claude-opus-5-5"},"sameModel":true},"limits":{"autoResume":true,"maxSteps":250,"subagentMaxSteps":100,"stuck":{"minutes":5},"routine":{"tokens":1000000,"minutes":120},"session":{"costUsd":2.5}},"cache":{"ttl":"auto"},"permissions":{"onFileConflict":"warn"},"memory":{"enabled":true}},"user":{},"secrets":{"providers":["anthropic","zai"],"keyed":["openrouter"]}}"#)
        }
        if path.hasPrefix("/api/providers/"), path.hasSuffix("/test") {
            if path.contains("zai") { return (200, #"{"ok":false,"detail":"HTTP 401 Unauthorized"}"#) }
            return (200, #"{"ok":true,"detail":"Found 12 models","latencyMs":184}"#)
        }
        if path == "/api/secrets" {
            if method != "GET" { return (200, #"{"ok":true}"#) }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            return (200, #"{"values":[{"name":"github-token","prefix":"ghp_","setAt":\#(now - 3 * 86_400_000)},{"name":"notion-key","prefix":"secr","setAt":\#(now - 7_200_000)},{"name":"telegram.bot","managedBy":"Settings > Notifications"}]}"#)
        }
        if path == "/api/clients" {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            return (200, #"[{"id":"cl-ipad","name":"Kai's iPad","platform":"ios","createdAt":1,"online":true,"revoked":false},{"id":"cl-pixel","name":"Pixel 8","platform":"android","createdAt":1,"lastSeenAt":\#(now - 3 * 3_600_000),"revoked":false},{"id":"cl-cli","name":"madx","platform":"linux","createdAt":1,"lastSeenAt":\#(now - 2 * 86_400_000),"revoked":false}]"#)
        }
        if path.hasPrefix("/api/clients/") { return (200, #"{"ok":true}"#) }
        if path == "/api/subscriptions" {
            return (200, #"{"mode":"builtin","state":"on","version":"6.9.3","management":true,"providers":[{"id":"claude","name":"Claude","plan":"Claude Pro or Max","accounts":1},{"id":"codex","name":"ChatGPT","plan":"ChatGPT Plus or Pro","accounts":0},{"id":"gemini","name":"Gemini","plan":"Gemini with a Google account","flow":"redirect","accounts":0},{"id":"qwen","name":"Qwen","plan":"Qwen Code","flow":"device","more":true}],"accounts":[{"name":"claude-kai.json","provider":"claude","providerName":"Claude","label":"kai@dymnitguys.com","state":"active","canRefresh":true},{"name":"claude-work.json","provider":"claude","providerName":"Claude","label":"work account","state":"unavailable","detail":"Weekly limit, resets Monday"}]}"#)
        }
        if path == "/api/logs/client" { return (200, #"{"accepted":1}"#) }
        if path == "/api/approvals" { return (200, approvals) }
        if path == "/api/questions" { return (200, questions) }
        if path == "/api/models" { return (200, models) }
        if path == "/api/agents" { return (200, agents) }
        if path == "/api/assistant/today" { return (200, today) }
        if path == "/api/goals" { return (200, goals) }
        if path == "/api/routines/preview" { return (200, #"{"next":[\#(now + 3_600_000),\#(now + 90_000_000)]}"#) }
        if path == "/api/routines" { return (200, method == "POST" ? #"{"id":"r9","name":"New routine","schedule":"0 9 * * *"}"# : routineList) }
        if path.hasPrefix("/api/routines/"), path.hasSuffix("/runs") { return (200, routineRuns) }
        return (200, "[]")
    }

    /// A tool's file as raw bytes (GET /api/sessions/:id/files/:toolUseId): a one-page PDF for t9,
    /// the purple picture for the rest. Nil for every other route.
    static func bytes(_ url: URL) -> (String, Data)? {
        let p = url.path.split(separator: "/").map(String.init)
        guard p.count == 5, p[1] == "sessions", p[3] == "files" else { return nil }
        switch p[4] {
        case "t9": return ("application/pdf", Data(pdf.utf8))
        case "t8": return ("text/markdown", Data("# Notes\n\nThe iPad keeps the web's column.\n".utf8))
        default: return ("image/png", Data(base64Encoded: png) ?? Data())
        }
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
         {"id":"s1","title":"Native iPad client plan","kind":"chat","model":"anthropic/claude-opus-5-5","chat":{"thinking":"high","sameModel":true},"updatedAt":\(ago(0.2))},
         {"id":"s2","title":"Fix login redirect after the passkey prompt is dismissed on Safari and the hub restarts","agent":"coder","cwd":"/home/conclave/work/conclave","device":"local","status":"running","updatedAt":\(ago(1))},
         {"id":"s3","title":"Backup script for PBS","agent":"coder","cwd":"/root/scripts","device":"d3","status":"waiting_approval","updatedAt":\(ago(3))},
         {"id":"s7","title":"Move auth middleware to jose","agent":"coder","cwd":"/home/conclave/work/conclave","updatedAt":\(ago(5))},
         {"id":"s8","title":"Compare Postgres backup tools: pgBackRest, Barman, WAL-G and plain pg_dump on a 40 GB database","kind":"chat","model":"openai/gpt-5.5","updatedAt":\(ago(7))},
         {"id":"s12","title":"Why does the Sonarr import keep failing for anime batches with absolute numbering","kind":"chat","updatedAt":\(ago(8))},
         {"id":"s13","title":"FSE paper: rewrite threats to validity","kind":"chat","model":"anthropic/claude-opus-5-5","updatedAt":\(ago(9))},
         {"id":"s4","title":"Trip to Lisbon","kind":"chat","pinned":true,"updatedAt":\(ago(30))},
         {"id":"s5","title":"Weekly plan","kind":"chat","updatedAt":\(ago(50))},
         {"id":"s14","title":"LeetCode 238 product except self in Python","kind":"chat","updatedAt":\(ago(52))},
         {"id":"s9","title":"Rust daemon sidecar review","agent":"coder","cwd":"/home/conclave/work/conclave","updatedAt":\(ago(60))},
         {"id":"s15","title":"Kener status page theme","agent":"coder","cwd":"/home/conclave/work/kener-theme","updatedAt":\(ago(70))},
         {"id":"s10","title":"Grocery list for the week","kind":"chat","updatedAt":\(ago(120))},
         {"id":"s6","title":"Sonarr episodes","agent":"coder","cwd":"/srv/media","updatedAt":\(ago(200))},
         {"id":"s11","title":"Paper section 4 edits","kind":"chat","updatedAt":\(ago(260))},
         {"id":"s16","title":"Secure Coding homework 5 write-up","kind":"chat","updatedAt":\(ago(400))},
         {"id":"s17","title":"Proxmox random reboot triage","agent":"coder","cwd":"/root","device":"d3","updatedAt":\(ago(500))},
         {"id":"a1","title":"Assistant","agent":"assistant","device":"local","meta":{"home":true},"updatedAt":\(ago(0.5))},
         {"id":"a2","title":"Plan the week around the FSE deadline","agent":"assistant","device":"local","updatedAt":\(ago(26))},
         {"id":"a3","title":"Evening check-in","agent":"assistant","device":"local","routineId":"r1","updatedAt":\(ago(20))},
         {"id":"h1","title":"macOS AudioToolbox fuzzing, crash triage of the gmalloc run","agent":"security","cwd":"/Users/kai/fuzz/audiotoolbox","device":"d1","status":"running","updatedAt":\(ago(2))},
         {"id":"h2","title":"Variant hunt: path traversal in the files route","agent":"security","cwd":"/home/conclave/work/conclave","updatedAt":\(ago(40))}
        ]
        """
    }

    static var devices: String {
        """
        [{"id":"local","name":"conclave","online":true,"info":{"hostname":"conclave","platform":"linux","arch":"x64"}},
         {"id":"d1","name":"MacBook Pro","online":true,"lastSeenAt":\(ago(0)),"info":{"hostname":"kais-mbp","platform":"darwin","arch":"arm64"}},
         {"id":"d2","name":"Gaming PC","online":false,"lastSeenAt":\(ago(3)),"info":{"hostname":"desktop-7k","platform":"win32","arch":"x64"}},
         {"id":"d3","name":"NAS","online":false,"lastSeenAt":\(ago(52)),"info":{"hostname":"nas","platform":"linux","arch":"arm64"}}]
        """
    }

    static var children: String {
        """
        [{"id":"s1-sub","parentId":"s1","title":"Build the app with xcodegen","agent":"builder","status":"waiting_approval","updatedAt":\(ago(0.05))},
         {"id":"c2","parentId":"s1","title":"Find the Android transcript logic","agent":"explore","status":"running","updatedAt":\(ago(0.02))},
         {"id":"c3","parentId":"s1","title":"Review the markdown renderer","agent":"reviewer","status":"idle","updatedAt":\(ago(0.6))},
         {"id":"c4","parentId":"s1","title":"Run the snapshot tests","agent":"tester","status":"error","updatedAt":\(ago(1.2))}]
        """
    }

    static var files: String {
        """
        [{"key":"share:t9","group":"generated","name":"ipad-plan.pdf","mediaType":"application/pdf","size":48210,"at":\(ago(0.1)),"messageId":"m3","index":3,"toolUseId":"t9"},
         {"key":"share:t8","group":"generated","name":"notes.md","mediaType":"text/markdown","size":2310,"at":\(ago(0.15)),"messageId":"m3","index":4,"toolUseId":"t8"},
         {"key":"gen:t7:0","group":"generated","name":"icon-a.png","mediaType":"image/png","size":912,"at":\(ago(0.2)),"messageId":"m3","index":5,"toolUseId":"t7","image":0},
         {"key":"gen:t7:1","group":"generated","name":"icon-b.png","mediaType":"image/png","size":912,"at":\(ago(0.2)),"messageId":"m3","index":5,"toolUseId":"t7","image":1},
         {"key":"m4:1","group":"uploaded","name":"icon-colour.png","mediaType":"image/png","size":120,"at":\(ago(0.3)),"messageId":"m4","index":1},
         {"key":"m5:0","group":"uploaded","name":"brief.txt","mediaType":"text/plain","size":640,"at":\(ago(0.4)),"messageId":"m5","index":0}]
        """
    }

    // a minimal one-page PDF with one line of text, for Quick Look
    private static let pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 60 Td (iPad plan) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"

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
      {"id":"claude-sonnet-5-5","ref":"anthropic/claude-sonnet-5-5","name":"Claude Sonnet 5.5","effort":{"levels":["low","medium","high"],"default":"medium"}},
      {"id":"claude-haiku-5","ref":"anthropic/claude-haiku-5","name":"Claude Haiku 5"}]},
     {"provider":"openai","name":"OpenAI","enabled":true,"configured":true,"models":[
      {"id":"gpt-5.5","ref":"openai/gpt-5.5","name":"GPT-5.5","effort":{"levels":["low","medium","high"],"default":"medium"}},
      {"id":"gpt-5.5-mini","ref":"openai/gpt-5.5-mini","name":"GPT-5.5 mini"}]},
     {"provider":"gemini","name":"Google","enabled":true,"configured":true,"models":[
      {"id":"gemini-3-pro","ref":"gemini/gemini-3-pro","name":"Gemini 3 Pro"},
      {"id":"gemini-3-flash","ref":"gemini/gemini-3-flash","name":"Gemini 3 Flash"}]},
     {"provider":"zai","name":"Z.ai","enabled":true,"configured":true,"models":[
      {"id":"glm-5","ref":"zai/glm-5","name":"GLM-5"}]}]
    """

    static let agents = """
    [{"name":"coder","description":"Writes and fixes code in your projects.","model":"anthropic/claude-opus-5-5","source":"builtin","tools":["Bash","Read","Edit","Write","Grep"],"prompt":"You are a careful senior engineer."},
     {"name":"security","description":"Hunts bugs within scope.yaml and proves each finding.","model":"anthropic/claude-opus-5-5","source":"builtin"},
     {"name":"assistant","description":"Your day: calendar, mail, goals and reminders.","model":"anthropic/claude-sonnet-5-5","source":"builtin"},
     {"name":"chat","description":"Plain chat.","source":"builtin"},
     {"name":"researcher","description":"Web research with sources, checked against primary pages.","model":"openai/gpt-5.5","source":"user"},
     {"name":"explore","description":"Read-only search of files and git history.","model":"anthropic/claude-haiku-5","source":"builtin","subagent":true,"primary":false},
     {"name":"reviewer","description":"Reviews a diff for bugs, security holes and test gaps.","source":"builtin","subagent":true,"primary":false}]
    """

    static var today: String {
        #"{"date":"2026-11-28","timezone":"America/Los_Angeles","tasks":{"dueToday":3,"overdue":1},"plan":{"summary":"FSE camera-ready is the big one today; gym after lunch, then interview prep.","focus":{"text":"Threats to validity rewrite","start":"09:30","end":"11:30"},"items":[{"time":"09:30","text":"Deep work: FSE threats to validity","kind":"focus"},{"time":"12:30","text":"Gym","kind":"event"},{"time":"15:00","text":"Recruiter call, Cloudflare","kind":"event"},{"text":"LeetCode 238 in Python","kind":"task"}]},"events":[{"id":"e1","title":"Recruiter call","start":\#(now + 7_200_000),"end":\#(now + 9_000_000),"calendar":"Work"},{"id":"e2","title":"CyLab group meeting","start":\#(now + 14_400_000),"end":\#(now + 18_000_000),"calendar":"CMU"}]}"#
    }

    static let goals = #"[{"id":"g1","title":"Land a full-time security role","area":"career","nextStep":"Two applications this week","targetDate":"2027-03-01","status":"active"},{"id":"g2","title":"Ship the FSE paper","area":"study","nextStep":"Camera-ready by Dec 5","status":"active"}]"#

    static var routineList: String {
        #"[{"id":"r1","name":"Evening check-in","schedule":"0 21 * * *","timezone":"America/Los_Angeles","agent":"assistant","prompt":"Short casual bullets: what is due tomorrow, and a wind-down line.","enabled":true,"lastRunAt":\#(ago(20)),"nextRunAt":\#(now + 10_800_000)},{"id":"r2","name":"Morning brief","schedule":"30 7 * * 1-5","agent":"assistant","prompt":"Summarize my calendar, unread mail and goals for the day.","enabled":true,"lastRunAt":\#(ago(9)),"nextRunAt":\#(now + 40_000_000)},{"id":"r3","name":"Sonarr check","schedule":"@every 6h","agent":"coder","prompt":"Check every tracked show downloaded its new episodes.","enabled":false}]"#
    }

    static var routineRuns: String {
        #"[{"id":"rr1","sessionId":"a3","status":"ok","trigger":"schedule","startedAt":\#(ago(20)),"summary":"3 things due tomorrow."},{"id":"rr2","status":"error","trigger":"manual","startedAt":\#(ago(44)),"error":"Plan refused: rate limited"}]"#
    }

    /// The composer as the screenshots show it: words and one picture.
    @MainActor
    static func fillComposer(_ chat: ChatModel) {
        guard chat.draft.isEmpty else { return }
        // one short line: a longer draft wrapped and the taller composer hid the transcript's end
        chat.draft = "Spacing like Android?"
        chat.files = [Attachment(mediaType: "image/png", data: png, name: "sidebar-sketch.png")]
    }

    // a 16x16 purple PNG
    private static let png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHUlEQVR4nGOs2vSAgRTARJLqUQ2jGkY1jGoYQhoAqpACKZMzvwUAAAAASUVORK5CYII="

    /// A tool output as long as real ones: 80 lines of a listing, escaped for a JSON string.
    private static let longListing = (1...80).map { "-rw-r--r--  1 conclave conclave  \(1000 + $0 * 37)  Nov 26 09:\(String(format: "%02d", $0 % 60))  App/Sources/File\($0).swift" }.joined(separator: "\\n")

    static var messages: String {
        let answer = """
        ## The plan\\n\\nPhase 2 reads chats. It uses **swift-markdown** and our own renderer, with `inline code` and [a link](https://example.com).\\n\\n1. Sidebar grouped by project\\n2. Transcript with older pages\\n3. Pictures decoded at display size\\n\\n- [x] Connect\\n- [ ] Composer\\n\\n```swift\\nlet page = try await client.messages(id, limit: TranscriptReducer.page, trim: true)\\ntranscript = TranscriptReducer.loaded(transcript, page, paged: true)\\n```\\n\\n| Phase | Scope | State |\\n|---|---|---|\\n| 1 | Kit, connect | done |\\n| 2 | Read chats | now |\\n\\n> Composer and approvals come in phase 3.
        """
        return """
        [
         {"id":"m1","sessionId":"s1","seq":1,"role":"user","content":[{"type":"text","text":"How should the native iPad client read chats?"}]},
         {"id":"m2","sessionId":"s1","seq":2,"role":"assistant","content":[
           {"type":"thinking","thinking":"Port the Android transcript logic first, then match the web's reading type.","durationMs":4000},
           {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls packages/ios"}},
           {"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"packages/android/app/src/main/kotlin/dev/conclave/app/ui/panel/SidePanel.kt"}},
           {"type":"tool_use","id":"t3","name":"Grep","input":{"pattern":"TranscriptReducer","path":"packages/ios"}},
           {"type":"tool_use","id":"t9","name":"ShareFile","input":{"path":"ipad-plan.pdf"}},
           {"type":"text","text":"\(answer)"}]},
         {"id":"m3","sessionId":"s1","seq":3,"role":"user","content":[{"type":"tool_result","toolUseId":"t1","content":"\(longListing)"},{"type":"tool_result","toolUseId":"t2","content":"620 lines"},{"type":"tool_result","toolUseId":"t3","content":"4 files"},
           {"type":"tool_result","toolUseId":"t9","content":"Shared ipad-plan.pdf","meta":{"file":{"toolUseId":"t9","name":"ipad-plan.pdf","title":"iPad plan","mediaType":"application/pdf","size":48210}}}]},
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
        let (status, type, data): (Int, String, Data)
        if let b = MockHub.bytes(url) {
            (status, type, data) = (200, b.0, b.1)
        } else {
            let (s, text) = MockHub.reply(request.httpMethod ?? "GET", url, Self.body(request))
            (status, type, data) = (s, "application/json", Data(text.utf8))
        }
        let res = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
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
