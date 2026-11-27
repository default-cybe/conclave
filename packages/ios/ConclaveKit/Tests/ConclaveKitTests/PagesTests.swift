import Foundation
import Testing
@testable import ConclaveKit

// Ports of the Kotlin client's MediaTest, ConclaveClientFilesTest, PairingTest, InboxTest and
// TaskKindsTest for what the media viewer, Files, Devices, Inbox and Tasks screens use.
struct PagesTests {
    private func msg(_ json: String) throws -> Message { try Wire.decoder().decode(Message.self, from: Data(json.utf8)) }

    @Test func theGalleryReadsPicturesInOrderWithEachToolsAtItsCall() throws {
        let a = try msg(#"{"id":"m1","role":"user","content":[{"type":"image","mediaType":"image/png","data":"AAAA"}]}"#)
        let b = try msg(#"{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Browser","input":{}},{"type":"image","mediaType":"image/jpeg","data":"CCCC"}]}"#)
        let results = [
            "t1": ToolResultBlock(toolUseId: "t1", content: .array([
                ["type": "text", "text": "ok"], ["type": "image", "mediaType": "image/png", "data": "BBBB"],
                ["type": "image", "source": ["media_type": "image/webp", "data": "DDDD"]], ["type": "image"],
            ])),
        ]
        let pics = Gallery.pictures([a, b], toolResults: results)
        #expect(pics.map(\.data) == ["AAAA", "BBBB", "DDDD", "CCCC"])
        #expect(pics[2].mediaType == "image/webp")
        // the same picture twice shows once
        #expect(Gallery.pictures([a, a], toolResults: [:]).count == 1)
    }

    @Test func aFailedOrTextOnlyResultHasNoPictures() {
        #expect(Gallery.pictures(nil).isEmpty)
        #expect(Gallery.pictures(ToolResultBlock(content: "just text")).isEmpty)
        #expect(Gallery.pictures(ToolResultBlock(content: .array([["type": "image", "data": "AAAA"]]), isError: true)).isEmpty)
        // a trimmed picture keeps its block url
        #expect(Gallery.picture(["type": "image", "url": "conclave-block:s/m/2/0"])?.url == "conclave-block:s/m/2/0")
    }

    @Test func sizesAndFactsReadAsOnAndroid() {
        #expect(FileWords.size(512) == "512 B")
        #expect(FileWords.size(14_540) == "14.2 KB")
        #expect(FileWords.size(3 * 1024 * 1024) == "3.0 MB")
        #expect(FileWords.facts("application/pdf", size: 14_540) == "PDF, 14.2 KB")
        #expect(FileWords.facts("image/png", size: nil) == "PNG")
        #expect(FileWords.facts("application/octet-stream", size: 10, name: "backup.sh") == "SH, 10 B")
        #expect(FileWords.isPicture("Image/JPEG; q=1"))
        #expect(!FileWords.isPicture("image/svg+xml"))
    }

    @Test func filesGroupInTheWebsOrderAndSaveUnderASafeName() {
        let files = [
            SessionFile(key: "a:0", group: .uploaded, name: "sketch.png"),
            SessionFile(key: "b:0:1", group: .screenshot, name: "shot.png"),
            SessionFile(key: "share:t1", group: .generated, name: "report.pdf"),
        ]
        #expect(FileWords.groups(files).map(\.title) == ["Generated", "Screenshots", "Uploaded"])
        #expect(FileWords.groups([files[0]]).map(\.title) == ["Uploaded"])
        #expect(FileWords.safeName("../../etc/passwd") == "passwd")
        #expect(FileWords.safeName("") == "file")
        #expect(FileWords.safeName("a:b.txt") == "a_b.txt")
    }

    @Test func listsDevicesAndMakesACodeOfAKind() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"local","name":"homelab","online":true},{"id":"d1","name":"MacBook","online":false,"lastSeenAt":5,"info":{"hostname":"mbp","platform":"darwin","arch":"arm64"}}]"#)
        let devices = try await hub.client().devices()
        #expect(devices.map(\.id) == ["local", "d1"])
        #expect(DeviceWords.meta(devices[1]) == "mbp, darwin arm64")
        #expect(try #require(hub.take()).path == "/api/devices")
        hub.enqueue(#"{"code":"ABCD-EFGH","url":"https://hub.example.com","deepLink":"conclave://pair?url=x&code=ABCD-EFGH","expiresAt":9}"#)
        let code = try await hub.client().makePairingCode(.computer)
        #expect(code.code == "ABCD-EFGH")
        let req = try #require(hub.take())
        #expect(req.method == "POST")
        #expect(req.path == "/api/pairing")
        #expect(req.json == ["kind": "device"])
        #expect(req.headers["Authorization"] == "Bearer secret-token")
    }

    @Test func devicesSortHubFirstThenOnlineThenName() {
        let list = [Device(id: "z", name: "zeta", online: true), Device(id: "b", name: "beta"), Device(id: "local", name: "hub", online: true), Device(id: "a", name: "Alpha", online: true)]
        #expect(DeviceWords.sorted(list).map(\.id) == ["local", "a", "z", "b"])
        #expect(DeviceWords.summary(list) == "3 online, 1 offline")
        #expect(DeviceWords.state(Device(id: "b", lastSeenAt: 0), now: 3 * 3_600_000) == "seen 3h ago")
        #expect(DeviceWords.state(Device(id: "b"), now: 0) == "offline")
        #expect(DeviceWords.title(Device(id: "d9", name: " ")) == "d9")
    }

    @Test func theTimerCountsDownAndRunsOut() {
        let info = PairingInfo(code: "ABCD-EFGH", url: "https://hub.example.com/", expiresAt: 1_000_000)
        #expect(PairingWords.timer(info, now: info.expiresAt - 10 * 60_000) == "Expires in 10:00")
        #expect(PairingWords.timer(info, now: info.expiresAt - 9 * 60_000 - 42_000) == "Expires in 9:42")
        #expect(PairingWords.timer(info, now: info.expiresAt - 400) == "Expires in 0:01")
        #expect(PairingWords.clock(info, now: info.expiresAt - 9 * 60_000 - 41_500) == "9:42")
        #expect(!PairingWords.expired(info, now: info.expiresAt - 1))
        #expect(PairingWords.timer(info, now: info.expiresAt) == "Expired.")
        #expect(PairingWords.timer(info, now: info.expiresAt + 60_000) == "Expired.")
    }

    @Test func theCommandsCarryTheCodesAddress() {
        let info = PairingInfo(code: "ABCD-EFGH", url: "https://hub.example.com/")
        #expect(PairingWords.commands(info)[1] == "conclave daemon pair https://hub.example.com ABCD-EFGH")
        let none = PairingInfo(code: "ABCD-EFGH")
        #expect(PairingWords.commands(none, fallbackUrl: "http://192.168.1.20:7777/")[1] == "conclave daemon pair http://192.168.1.20:7777 ABCD-EFGH")
        #expect(PairingWords.grouped("abcdefghij") == "abcd efgh ij")
        // no em dashes in what the sheet says
        for k in PairKind.allCases { #expect(!PairingWords.help(k).contains("\u{2014}")) }
    }

    @Test func approvalCardsSayWhatTheAgentWants() {
        #expect(InboxWords.approvalLines("Bash", "Run: git push origin fix/login") == ("Wants to run", "git push origin fix/login"))
        #expect(InboxWords.approvalLines("Shell", "run: rm -rf build/cache") == ("Wants to run", "rm -rf build/cache"))
        #expect(InboxWords.approvalLines("Edit", "Edit src/auth/callback.ts") == ("Wants to use Edit", "Edit src/auth/callback.ts"))
        #expect(InboxWords.approvalLines("WebFetch", " ") == ("Wants to use WebFetch", "WebFetch"))
        // the hub's summary of a shell call is the agent's description: the command comes from input
        #expect(InboxWords.approvalLines("Bash", "Push fix/login", input: ["command": "git push origin fix/login"]) == ("Wants to run", "git push origin fix/login"))
    }

    @Test func aQuestionsLineIsItsFirstQuestion() throws {
        let q = try Wire.decoder().decode(QuestionRequest.self, from: Data(#"{"id":"q","sessionId":"s","questions":[{"question":"Keep the old API route?\nmore","options":[]}]}"#.utf8))
        #expect(InboxWords.questionLine(q) == "Asks: Keep the old API route?")
        let empty = try Wire.decoder().decode(QuestionRequest.self, from: Data(#"{"id":"q","sessionId":"s","questions":[]}"#.utf8))
        #expect(InboxWords.questionLine(empty) == "Asks a question")
    }

    @Test func eachAgentHasItsGlyph() {
        #expect(TaskKinds.glyph(agent: "explore") == .search)
        #expect(TaskKinds.glyph(agent: "Builder") == .build)
        #expect(TaskKinds.glyph(agent: "verifier") == .verify)
        #expect(TaskKinds.glyph(agent: "general-purpose") == .bot)
        #expect(TaskKinds.glyph(agent: nil) == .bot)
    }

    @Test func subagentsSayTheirStateLiveOnesFirst() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"c1","agent":"explore","status":"idle","updatedAt":3},{"id":"c2","agent":"builder","status":"running","updatedAt":1},{"id":"c3","status":"error","updatedAt":2}]"#)
        let kids = try await hub.client().children("s1")
        #expect(try #require(hub.take()).query("parentId") == "s1")
        #expect(TaskKinds.sorted(kids).map(\.id) == ["c2", "c1", "c3"])
        #expect(TaskKinds.state(kids[1]).word == "running")
        #expect(TaskKinds.state(kids[2]).word == "failed")
        #expect(TaskKinds.who(kids[2]) == "Subagent")
        #expect(TaskKinds.summary(kids) == "3 tasks, 1 running, 1 failed")
        #expect(TaskKinds.summary([]) == "No tasks")
    }

    @Test func meReadsTheOwnDefaultsAndPatchClearsWithNull() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"id":"u1","name":"sam","role":"member","preferences":{"defaultModel":"openai/gpt-5.5"}}"#)
        let me = try await hub.client().me()
        #expect(me.role == "member")
        #expect(me.preferences.defaultModel == "openai/gpt-5.5")
        #expect(me.shownName == "sam")
        _ = hub.take()
        hub.enqueue(#"{"ok":true}"#)
        try await hub.client().setDefaultModel(nil)
        let req = try #require(hub.take())
        #expect(req.method == "PATCH")
        #expect(req.path == "/api/me")
        #expect(req.json == ["defaultModel": nil])
    }

    @Test func filesListAndBytesUseTheSessionRoutes() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"key":"share:t1","group":"generated","name":"q3.pdf","mediaType":"application/pdf","size":"bad","at":5,"messageId":"m1","index":2,"toolUseId":"t1"}]"#)
        let files = try await hub.client().files("ses_1")
        #expect(files.first?.toolUseId == "t1")
        #expect(files.first?.size == nil)
        #expect(try #require(hub.take()).path == "/api/sessions/ses_1/files")
        hub.enqueue("%PDF")
        let bytes = try await hub.client().fileData("ses_1", toolUseId: "toolu_2", image: 1)
        #expect(String(decoding: bytes, as: UTF8.self) == "%PDF")
        let req = try #require(hub.take())
        #expect(req.path == "/api/sessions/ses_1/files/toolu_2")
        #expect(req.query("image") == "1")
        #expect(req.query("inline") == "1")
    }
}
