import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client ClientTest.kt (REST half; the socket is in LiveTests).
struct ClientTests {
    @Test func sendsBearerTokenAndParsesList() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"s1","title":"A"},{"id":"s2","title":"B","pinned":true}]"#)
        let sessions = try await hub.client().listSessions(archived: false, search: "build fix")
        #expect(sessions.map(\.id) == ["s1", "s2"])
        #expect(sessions[1].pinned)
        let req = try #require(hub.take())
        #expect(req.method == "GET")
        #expect(req.path == "/api/sessions")
        #expect(req.query("archived") == "false")
        #expect(req.query("search") == "build fix")
        #expect(req.headers["Authorization"] == "Bearer secret-token")
    }

    @Test func topLevelSessionsReadsEveryPage() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"a"},{"id":"b"}]"#)
        hub.enqueue(#"[{"id":"c"}]"#)
        let all = try await hub.client().topLevelSessions(archived: false, page: 2)
        #expect(all.map(\.id) == ["a", "b", "c"])
        let first = try #require(hub.take()), second = try #require(hub.take())
        #expect(first.query("parentId") == "none")
        #expect(first.query("offset") == "0")
        #expect(second.query("offset") == "2")
        #expect(second.query("limit") == "2")
    }

    @Test func postsJsonBodies() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"id":"s9","title":"New"}"#)
        let s = try await hub.client().createSession(CreateSessionInput(agent: "coder", prompt: "hi", kind: .chat))
        #expect(s.id == "s9")
        let req = try #require(hub.take())
        #expect(req.method == "POST")
        #expect(req.headers["Content-Type"] == "application/json")
        #expect(req.json == ["agent": "coder", "kind": "chat", "prompt": "hi"])
    }

    @Test func patchesChatSwitches() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"id":"s1"}"#)
        _ = try await hub.client().updateSession("s1", SessionPatch(chat: ChatSettingsPatch(webSearch: false, agentThinking: true)))
        let req = try #require(hub.take())
        #expect(req.method == "PATCH")
        #expect(req.json == ["chat": ["thinking": nil, "webSearch": false]])
    }

    @Test func resolvesApprovalAndIgnoresOkBody() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"ok":true}"#)
        try await hub.client().resolveApproval("a1", .allowSession)
        let req = try #require(hub.take())
        #expect(req.path == "/api/approvals/a1")
        #expect(req.json == ["decision": "allow", "scope": "session"])
    }

    @Test func pairsWithoutToken() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"token":"tok","clientId":"c1","hub":{"name":"home","version":"0.4"},"addresses":["https://a.example"]}"#)
        let res = try await hub.client(nil).pair(code: "ABCD-1234", name: "iPad")
        #expect(res.token == "tok")
        #expect(res.addresses == ["https://a.example"])
        let req = try #require(hub.take())
        #expect(req.headers["Authorization"] == nil)
        #expect(req.json == ["code": "ABCD-1234", "name": "iPad", "platform": "ios"])
    }

    @Test func mapsErrorsToApiError() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"error":"Session not found"}"#, status: 404)
        await #expect(throws: ConclaveAPIError(status: 404, message: "Session not found", body: #"{"error":"Session not found"}"#)) {
            try await hub.client().session("nope")
        }
        hub.enqueue("too many", status: 429, headers: ["retry-after": "30"])
        do {
            _ = try await hub.client().session("x")
            Issue.record("no error")
        } catch let e as ConclaveAPIError {
            #expect(e.status == 429)
            #expect(e.message == "too many")
            #expect(e.retryAfterSeconds == 30)
        }
    }

    @Test func keepsBasePathPrefixAndEncodesIds() async throws {
        let hub = MockHub(path: "/conclave/")
        hub.enqueue(#"{"id":"a b/c"}"#)
        _ = try await hub.client().session("a b/c")
        #expect(try #require(hub.take()).path == "/conclave/api/sessions/a%20b%2Fc")
    }

    @Test func webSocketURLLeavesTheTokenOut() throws {
        let c = ConclaveClient(baseURL: "https://hub.example/base/", token: "secret-token")
        #expect(try c.webSocketURL().absoluteString == "wss://hub.example/base/api/ws")
        let plain = ConclaveClient(baseURL: "http://192.168.1.5:7777", token: "secret-token")
        #expect(try plain.webSocketURL().absoluteString == "ws://192.168.1.5:7777/api/ws")
    }

    @Test func backoffMatchesTypeScript() {
        #expect((0...6).map(ConclaveClient.defaultBackoff) == [500, 1000, 2000, 4000, 8000, 15000, 15000])
        #expect(ConclaveClient.backgroundBackoff(0) == 1000)
        #expect(ConclaveClient.backgroundBackoff(9) == 60000)
        #expect(ConclaveClient.refusedWait(status: 429, retryAfterSeconds: 12, refusals: 0, backoff: 500) == 12000)
        #expect(ConclaveClient.refusedWait(status: 429, retryAfterSeconds: nil, refusals: 0, backoff: 500) == 30000)
        #expect(ConclaveClient.refusedWait(status: 401, retryAfterSeconds: nil, refusals: 0, backoff: 500) == 60000)
        #expect(ConclaveClient.refusedWait(status: 401, retryAfterSeconds: nil, refusals: 9, backoff: 500) == 480_000)
    }

    @Test func nextModelPostsTheRefusedReply() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"model":"openai/gpt-5.5"}"#)
        _ = try await hub.client().tryNextModel("s1", messageId: "m7")
        let req = try #require(hub.take())
        #expect(req.path == "/api/sessions/s1/next-model")
        #expect(req.json == ["messageId": "m7"])
    }
}
