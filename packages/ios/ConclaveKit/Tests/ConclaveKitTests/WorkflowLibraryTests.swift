import Foundation
import Testing
@testable import ConclaveKit

// The workflow library, presets, start and findings (routes-workflows.ts), and the launch form,
// ported from the Kotlin client's LaunchArgsTest.
struct WorkflowLibraryTests {
    private let schema = [WorkflowArgField("question"), WorkflowArgField("votes", type: "number"), WorkflowArgField("fast", type: "boolean")]

    private func json(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }

    @Test func libraryDecodesSchemaInOrderAndLastRun() async throws {
        let hub = MockHub()
        hub.enqueue(#"""
        [{"id":"review-changes","name":"review-changes","description":"Review","source":"builtin","portable":false,"runnable":true,
          "phases":[{"title":"Find"},{"title":"Verify"}],
          "argsSchema":{"base":{"type":"string","description":"Branch"},"votes":{"type":"number"},"strict":{"type":"boolean"}},
          "lastRun":{"id":"r1","status":"done","createdAt":5,"finishedAt":9}},
         {"id":"plugin:x","name":"","source":"plugin","runnable":false,"error":"boom","phases":[],"lastRun":{"id":"r2","status":"teleporting","createdAt":3}}]
        """#)
        let l = try await hub.client().workflows()
        #expect(try #require(hub.take()).path == "/api/workflows")
        #expect(l.count == 2)
        #expect(l[0].argsSchema?.map(\.name) == ["base", "votes", "strict"])
        #expect(l[0].argsSchema?.map(\.type) == ["string", "number", "boolean"])
        #expect(l[0].argsSchema?.first?.description == "Branch")
        #expect(l[0].phases == ["Find", "Verify"])
        #expect(!l[0].portable)
        #expect(l[0].lastRunAt == 9)
        #expect(l[0].lastRunStatus == .done)
        #expect(l[1].name == "plugin:x")
        #expect(l[1].argsSchema == nil)
        #expect(!l[1].runnable && l[1].error == "boom")
        #expect(l[1].lastRunAt == 3)
        #expect(l[1].portable)
    }

    @Test func keyOrderReadsTheTextOrder() {
        let text = #"""
        [ {"a":1,"argsSchema":{"zeta":{"d":"x,}"},"al\"pha":{"n":[1,{"argsSchema":{}}]},"mid":true}},
          {"argsSchema":null}, 7, {"x":{"argsSchema":{"inner":1}},"argsSchema":{}} ]
        """#
        let o = JSONKeyOrder.keys(ofField: "argsSchema", inArray: Data(text.utf8))
        #expect(o?.count == 4)
        #expect(o?[0] == ["zeta", "al\"pha", "mid"])
        #expect(o?[1] == nil)
        #expect(o?[2] == nil)
        // a nested argsSchema is not the element's own
        #expect(o?[3] == [])
        #expect(JSONKeyOrder.keys(ofField: "argsSchema", inArray: Data("[]".utf8)) == [])
        #expect(JSONKeyOrder.keys(ofField: "argsSchema", inArray: Data(#"{"a":1}"#.utf8)) == nil)
    }

    @Test func presetsStartAndFindingsHitTheirRoutes() async throws {
        let hub = MockHub()
        let c = hub.client()
        hub.enqueue(#"[{"id":"p1","workflow":"w","name":"quick","args":{"fast":true},"createdAt":1}]"#)
        let ps = try await c.workflowPresets("w")
        #expect(ps.first?.args == json(#"{"fast":true}"#))
        #expect(hub.take()?.path == "/api/workflows/w/presets")

        hub.enqueue(#"{"id":"p2","workflow":"w","name":"none","args":null,"createdAt":1}"#, status: 201)
        _ = try await c.saveWorkflowPreset("w", name: "none", args: nil)
        let save = try #require(hub.take())
        #expect(save.method == "POST")
        // no args: the key is left out, since the hub refuses a non-object
        #expect(save.json == json(#"{"name":"none"}"#))

        hub.enqueue("", status: 204)
        try await c.deleteWorkflowPreset("w", presetId: "p2")
        let del = try #require(hub.take())
        #expect(del.method == "DELETE" && del.path == "/api/workflows/w/presets/p2")

        hub.enqueue(#"{"id":"r9","name":"w","status":"queued","createdAt":1}"#, status: 201)
        let run = try await c.startWorkflow("w", args: json(#"{"q":1}"#), device: "pc", cwd: "~/code", budgetTokens: 2_000_000)
        #expect(run.id == "r9")
        let start = try #require(hub.take())
        #expect(start.path == "/api/workflows/runs")
        #expect(start.json == json(#"{"name":"w","args":{"q":1},"device":"pc","cwd":"~/code","budget":{"tokens":2000000}}"#))

        hub.enqueue(#"{"id":"f1","title":"Bug","proven":false,"verdict":"dismissed","reason":"by design","votes":["confirmed",null,"refuted"]}"#)
        let f = try await c.judgeFinding("r9", findingId: "f1", verdict: .dismissed, reason: "by design")
        #expect(f.verdict == .dismissed && f.reason == "by design")
        #expect(f.votesWord == "1 of 3 refuters confirmed")
        let judge = try #require(hub.take())
        #expect(judge.path == "/api/workflows/runs/r9/findings/f1")
        #expect(judge.json == json(#"{"verdict":"dismissed","reason":"by design"}"#))
    }

    @Test func runDetailReadsFindings() throws {
        let d: WorkflowRunDetail = try decode(#"""
        {"run":{"id":"r1","name":"w","status":"done","createdAt":1},"calls":[],"logs":[],"refutedRate":0.25,
         "findings":[{"id":"f1","title":"Null check","priority":"P1","file":"a.ts","line":4,"proven":true,"data":{"quote":"x!","scenario":"empty list"}},
                     {"id":"f2","title":"Odd votes","proven":false,"votes":{"a":1}}]}
        """#)
        #expect(d.refutedRate == 0.25)
        #expect(d.findings.count == 2)
        #expect(d.findings[0].place == "a.ts:4")
        #expect(d.findings[0].quote == "x!" && d.findings[0].scenario == "empty list")
        #expect(d.findings[1].votes == nil && d.findings[1].votesWord == nil && d.findings[1].place == nil)
    }

    @Test func aPresetReplacesTheWholeForm() {
        #expect(Launch.formOf(schema, json(#"{"question":"a","fast":true,"maxVerify":5}"#)) == LaunchForm(texts: ["question": "a"], bools: ["fast": true], raw: #"{"maxVerify":5}"#))
        #expect(Launch.formOf(schema, json(#"{"votes":3}"#)) == LaunchForm(texts: ["votes": "3"]))
        #expect(Launch.formOf(schema, nil) == LaunchForm())
        #expect(Launch.formOf(schema, .null) == LaunchForm())
    }

    @Test func stringsRoundTripUnescaped() throws {
        let tricky = "say \"hi\"\\n\nline two\""
        let args = JSONValue.object(["question": .string(tricky), "fast": .bool(false)])
        let form = Launch.formOf(schema, args)
        #expect(form.texts["question"] == tricky)
        #expect(try Launch.argsOf(schema, form).get() == args)
    }

    @Test func argsComeBackTypedWithExtras() throws {
        let o = try #require(try Launch.argsOf(schema, LaunchForm(texts: ["question": " q ", "votes": "3"], raw: #"{"maxVerify":5,"question":"x"}"#)).get()?.object)
        #expect(o["question"] == .string("q"))
        #expect(o["votes"] == .number(3))
        #expect(o["fast"] == .bool(false))
        #expect(o["maxVerify"] == .number(5))
        #expect((try? Launch.argsOf(schema, LaunchForm(texts: ["votes": "many"])).get()) == nil)
        #expect((try? Launch.argsOf(schema, LaunchForm(texts: ["votes": "NaN"])).get()) == nil)
        #expect((try? Launch.argsOf(schema, LaunchForm(raw: "[1]")).get()) == nil)
        // no schema: the box is the args, empty is none
        #expect(try Launch.argsOf(nil, LaunchForm()).get() == nil)
        #expect((try? Launch.argsOf(nil, LaunchForm(raw: "{bad")).get()) == nil)
        #expect(try Launch.argsOf(nil, LaunchForm(raw: #"{"q":1}"#)).get() == json(#"{"q":1}"#))
    }

    @Test func budgetReadsKAndM() {
        /// "none", the count, or "bad".
        func word(_ s: String) -> String {
            switch Launch.budgetTokens(s) {
            case .success(let n): n.map { String($0) } ?? "none"
            case .failure: "bad"
            }
        }
        #expect(word("") == "none")
        #expect(word(" 500k ") == "500000")
        #expect(word("2M") == "2000000")
        #expect(word("1.5m") == "1500000")
        #expect(word("1200") == "1200")
        #expect(word("lots") == "bad")
        #expect(word("-5k") == "bad")
        #expect(word("1e5") == "bad")
    }
}
