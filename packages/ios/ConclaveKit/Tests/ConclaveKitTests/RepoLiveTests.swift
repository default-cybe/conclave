import Foundation
import Testing
@testable import ConclaveKit

// Repo actions (Android RepoWords) and the live line's activity (Android SessionLive).
struct RepoLiveTests {
    private func repo(_ json: String) throws -> RepoSession { try JSONDecoder().decode(RepoSession.self, from: Data(json.utf8)) }

    @Test func actionsFollowTheState() throws {
        let fresh = try repo(#"{"repo":"acme/w","branch":"conclave/fix-ab12","base":"main","commits":2,"dirty":0,"pushed":"never","online":true}"#)
        let a = RepoWords.actions(fresh)
        #expect(a.push && a.openPr && !a.cleanUp && !a.viewPr)
        let open = try repo(#"{"repo":"acme/w","branch":"b","pr":{"number":12,"url":"https://github.com/acme/w/pull/12","state":"open"},"ci":"failure","commits":2,"dirty":1,"pushed":"current","online":true}"#)
        let b = RepoWords.actions(open)
        #expect(b.push && !b.openPr && b.viewPr)
        #expect(RepoWords.tone(open) == "fault")
        let merged = try repo(#"{"repo":"acme/w","branch":"b","pr":{"number":12,"url":"https://x","state":"merged"},"canCleanUp":true,"online":true}"#)
        let c = RepoWords.actions(merged)
        #expect(c.cleanUp && !c.push && !c.openPr && RepoWords.tone(merged) == "ok")
        let offline = try repo(#"{"repo":"acme/w","branch":"b","commits":3,"pushed":"never","online":false}"#)
        #expect(!RepoWords.actions(offline).push)
        let folder = try repo(#"{"branch":"conclave/try","base":"main","folder":true,"canMerge":true,"online":true,"pullRequests":false,"commits":1,"deviceName":"madx"}"#)
        let d = RepoWords.actions(folder)
        #expect(d.merge && d.discard && !d.push)
        #expect(RepoWords.discardBody(folder) == "The worktree on madx and try go. 1 commit is not merged and are lost.")
        #expect(RepoWords.branchShort("conclave/fix-ab12") == "fix-ab12")
        #expect(RepoWords.commitMessage("New chat") == "Work from Conclave")
    }

    /// "verb|target" for a tool call.
    private func step(_ name: String, _ input: JSONObject = [:]) -> String {
        let s = SessionLive.step(ToolUseBlock(id: "t1", name: name, input: input))
        return s.0 + "|" + (s.1 ?? "")
    }

    @Test func steps() {
        #expect(step("Bash", ["command": .string("bun test\nmore")]) == "Running|bun test")
        #expect(step("Read", ["file_path": .string("src/auth.ts")]) == "Reading|src/auth.ts")
        #expect(step("WebFetch", ["url": .string("https://docs.swift.org/x")]) == "Reading|docs.swift.org")
        #expect(step("mcp__github__create_issue") == "Running|github create_issue")
        #expect(step("TodoWrite") == "Planning|")
        // a running tool wins over the streaming text
        let m = try! JSONDecoder().decode(Message.self, from: Data(#"{"id":"m1","sessionId":"s","seq":1,"role":"assistant","content":[{"type":"tool_use","id":"t9","name":"Bash","input":{"command":"ls"}}],"createdAt":1}"#.utf8))
        #expect(SessionLive.activity([m], running: ["t9"]) == .tool(verb: "Running", target: "ls", id: "t9"))
        #expect(SessionLive.activity([m], running: []) == .thinking)
        #expect(SessionLive.duration(4_200) == "4s")
        #expect(SessionLive.duration(72_000) == "1m 12s")
        #expect(SessionLive.duration(780_000) == "13m")
    }
}
