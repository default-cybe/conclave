import Foundation
import Testing
@testable import ConclaveKit

// The "/" menu (Android Start.slashMatches/commandOf) and the command routes (routes.ts).
struct SlashTests {
    private let hubList = [
        CommandDef(name: "clear", chat: true), CommandDef(name: "compact", argumentHint: "[instructions]", chat: true),
        CommandDef(name: "cost", chat: true), CommandDef(name: "init"), CommandDef(name: "export", chat: true),
        CommandDef(name: "review"), CommandDef(name: "deploy", source: "user"), CommandDef(name: "btw", source: "user"),
    ]

    @Test func availablePutsBtwFirstAndTrimsForChats() {
        let code = Slash.available(hubList, chat: false)
        #expect(code.first?.name == "btw")
        #expect(code.filter { $0.name == "btw" }.count == 1)
        #expect(code.map(\.name).contains("init"))
        let chat = Slash.available(hubList, chat: true).map(\.name)
        #expect(!chat.contains("init") && !chat.contains("review"))
        #expect(chat.contains("compact") && chat.contains("deploy"))
    }

    @Test func matchesAndCommandOf() {
        let all = Slash.available(hubList, chat: false)
        #expect(Slash.matches("/", all).prefix(4).map(\.name) == ["btw", "compact", "cost", "init"])
        #expect(Slash.matches("/co", all).map(\.name) == ["compact", "cost"])
        #expect(Slash.matches("/pl", all).map(\.name) == ["deploy"])
        #expect(Slash.matches("/compact now", all).isEmpty)
        #expect(Slash.matches("hello", all).isEmpty)
        #expect(Slash.commandOf(" /compact keep the plan ", all) == "compact")
        #expect(Slash.commandOf("/nope", all) == nil)
        #expect(Slash.commandOf("compact", all) == nil)
        #expect(Slash.argument("/btw why is it slow? ") == "why is it slow?")
        #expect(Slash.argument("/btw") == "")
    }

    @Test func routes() async throws {
        let hub = MockHub()
        let c = hub.client()
        hub.enqueue(#"[{"name":"compact","description":"Summarize","argumentHint":"[instructions]","source":"builtin","chat":true,"body":""},{"name":"deploy","body":"x"}]"#)
        let list = try await c.commands()
        #expect(list.map(\.name) == ["compact", "deploy"])
        #expect(list[0].chat && list[1].source == "user" && !list[1].chat)
        #expect(hub.take()?.url.query == "builtins=1")

        hub.enqueue(#"{"ok":true,"output":"Compacted."}"#)
        #expect(try await c.runCommand("s1", line: "/compact").output == "Compacted.")
        let cmd = try #require(hub.take())
        #expect(cmd.path == "/api/sessions/s1/command")

        hub.enqueue(#"[{"id":"cp1","sessionId":"s1","seq":4,"commit":"abcdef1234","files":2,"createdAt":9}]"#)
        let cps = try await c.checkpoints("s1")
        #expect(cps.first?.files == 2 && cps.first?.commit == "abcdef1234")
        #expect(hub.take()?.path == "/api/sessions/s1/checkpoints")
        hub.enqueue(#"{"ok":true}"#)
        try await c.restoreCheckpoint("s1", checkpointId: "cp1")
        #expect(hub.take()?.path == "/api/sessions/s1/checkpoints/cp1/restore")

        hub.enqueue(#"{"answer":"Because of X."}"#)
        #expect(try await c.btw("s1", text: "why?").answer == "Because of X.")
        #expect(hub.take()?.path == "/api/sessions/s1/btw")
    }
}
