import Foundation
import Testing
@testable import ConclaveKit

// Ports of the Kotlin client's WorkflowsTest (decoding, words, phases, controls) and the board's
// columns, sorting and due words from the web's taskWords, plus the client paths of both.
struct BoardTests {
    private let detailJson = #"""
    {
      "run":{"id":"r1","name":"review-changes","source":"builtin","status":"running","sessionId":"s1","device":"pc","cwd":"/home/kai/code/site",
        "phases":[{"title":"Scope"},{"title":"Find"},{"title":"Verify"},{"title":"Report"}],"phaseIndex":2,"phaseTitle":"Verify",
        "inputTokens":400000,"outputTokens":12000,"costUsd":3.1,
        "counts":{"agents":14,"queued":1,"running":2,"done":8,"cached":1,"failed":1,"skipped":0,"parked":1},"portable":false,"createdAt":1},
      "calls":[
        {"seq":1,"kind":"check","label":"scope the diff","phase":"Scope","state":"done","attempt":1,"inputTokens":0,"outputTokens":0,"costUsd":0},
        {"seq":2,"kind":"agent","label":"correctness","phase":"Find","model":"anthropic/claude-sonnet-5-5","state":"done","attempt":1,"inputTokens":9000,"outputTokens":1000,"costUsd":0.04},
        {"seq":3,"kind":"agent","label":"verify 1","phase":"Verify","state":"running","attempt":1,"lastTool":"Reading src/auth.ts","waiting":"approval","childSessionId":"c3","inputTokens":0,"outputTokens":0,"costUsd":0},
        {"seq":4,"kind":"workflow","label":"nested","phase":"Verify","state":"running","attempt":1,"inputTokens":0,"outputTokens":0,"costUsd":0},
        {"seq":5,"kind":"agent","label":"inner","phase":"Verify","parentSeq":4,"state":"running","attempt":2,"lastTool":"Running bun test","inputTokens":0,"outputTokens":0,"costUsd":0},
        {"seq":6,"kind":"agent","label":"odd","phase":"Unlisted","state":"teleporting","attempt":1,"inputTokens":0,"outputTokens":0,"costUsd":0}
      ],
      "logs":[{"n":1,"ts":5,"text":"Scoped 12 files."}],
      "result":null,
      "findings":[{"id":"f1","title":"Null check missing","proven":true,"votes":{"a":1}}]
    }
    """#

    private func detail() throws -> WorkflowRunDetail { try decode(detailJson) }

    @Test func runDetailDecodesWithUnknownValues() async throws {
        let hub = MockHub()
        hub.enqueue(detailJson)
        let d = try await hub.client().workflowRun("r1")
        #expect(try #require(hub.take()).path == "/api/workflows/runs/r1")
        #expect(d.run.status == .running)
        #expect(d.calls.count == 6)
        #expect(d.calls.last?.state == .queued)
        #expect(d.calls[2].waitingOnOwner)
        #expect(d.logs.map(\.text) == ["Scoped 12 files."])
        #expect(d.result == nil)
    }

    @Test func statusSentenceCountsAnApprovalAsWaitingForYou() throws {
        let d = try detail()
        #expect(WorkflowWords.statusSentence(d.run, d.calls)
            == "Running. Phase 3 of 4, Verify. 14 agents: 9 done, 1 running, 1 waiting for you, 1 failed, 1 waiting for a limit. 412k tokens, $3.10.")
        var one = d.run
        one.status = .done
        one.phaseIndex = -1
        one.counts = WorkflowCounts(agents: 1, done: 1)
        #expect(WorkflowWords.statusSentence(one) == "Done. 1 agent: 1 done. 412k tokens, $3.10.")
        one.status = .budget
        #expect(WorkflowWords.statusSentence(one).hasPrefix("Stopped at budget."))
        #expect(WorkflowWords.runMeta(d.run) == "14 agents, 412k tokens, $3.10")
    }

    @Test func wordsAndTones() throws {
        let d = try detail()
        #expect(WorkflowWords.callWord(d.calls[2]) == "waiting for you")
        #expect(WorkflowWords.callTone(d.calls[2]) == .warn)
        var stopped = d.calls[1]
        stopped.state = .failed
        stopped.error = "the run was stopped"
        #expect(WorkflowWords.callWord(stopped) == "stopped")
        #expect(WorkflowWords.callTone(stopped) == .dim)
        var parked = d.calls[1]
        parked.state = .parked
        #expect(WorkflowWords.callWord(parked) == "waiting")
        #expect(WorkflowWords.isLive(.waitingReset))
        #expect(!WorkflowWords.isLive(.interrupted))
        #expect(WorkflowWords.runTone(.failed) == .fault)
        #expect(WorkflowWords.runWord(.waitingReset) == "waiting for the limit")
    }

    @Test func phasesGroupInMetaOrderAndNestedCallsIndent() throws {
        let d = try detail()
        let groups = WorkflowWords.byPhase(d.run, d.calls)
        #expect(groups.map(\.title) == ["Scope", "Find", "Verify", "Report", "Other calls"])
        #expect(groups[2].calls.map(\.seq) == [3, 4, 5])
        var done = d.run
        done.status = .done
        #expect(WorkflowWords.phaseProgress(groups[3], index: 3, run: done) == "no agents")
        #expect(WorkflowWords.phaseProgress(groups[3], index: 3, run: d.run) == "not started")
        #expect(WorkflowWords.phaseProgress(groups[1], index: 1, run: d.run) == "1 of 1 done")
        let rows = WorkflowWords.rows(groups[2].calls)
        #expect(rows.map(\.call.seq) == [3, 4, 5])
        #expect(rows.map(\.depth) == [0, 0, 1])
        // a parent chain that loops still lists every call once
        let loop = [WorkflowCall(seq: 7, state: .running, parentSeq: 8), WorkflowCall(seq: 8, state: .running, parentSeq: 7)]
        #expect(WorkflowWords.rows(loop).map(\.call.seq) == [7, 8])
    }

    @Test func callMetaActivityAndReport() throws {
        let d = try detail()
        #expect(WorkflowWords.callMeta(d.calls[1], lastTool: nil) == "Sonnet 5.5, 10k tokens, $0.04")
        #expect(WorkflowWords.callMeta(d.calls[0], lastTool: nil) == "check")
        #expect(WorkflowWords.callMeta(d.calls[4], lastTool: d.calls[4].lastTool) == "Running bun test, attempt 2")
        #expect(WorkflowWords.callLabel(WorkflowCall(seq: 9)) == "call 9")
        #expect(WorkflowWords.activity(d) == "inner: Running bun test")
        var ended = d
        ended.run.status = .done
        #expect(WorkflowWords.activity(ended) == nil)
        #expect(WorkflowWords.report(nil) == nil)
        #expect(WorkflowWords.report("Safe to merge.") == "Safe to merge.")
        #expect(WorkflowWords.report(["report": "# Verdict", "proven": [1]]) == "# Verdict")
        #expect(WorkflowWords.report(["count": 2]) == nil)
    }

    @Test func durationsTokensAndMoney() {
        let run = WorkflowRun(id: "r", status: .done, startedAt: 1_000, finishedAt: 253_000)
        #expect(WorkflowWords.duration(run, now: 0) == "4m 12s")
        let live = WorkflowRun(id: "r", status: .running, startedAt: 1_000)
        #expect(WorkflowWords.duration(live, now: 3_901_000) == "1h 5m")
        #expect(WorkflowWords.duration(WorkflowRun(id: "r", status: .failed), now: 9) == nil)
        #expect(WorkflowWords.tokens(412_000) == "412k")
        #expect(WorkflowWords.tokens(1_200) == "1.2k")
        #expect(WorkflowWords.tokens(3_400_000) == "3.4M")
        #expect(WorkflowWords.usd(0) == "$0")
        #expect(WorkflowWords.usd(0.0042) == "$0.0042")
        #expect(WorkflowWords.usd(3.1) == "$3.10")
        #expect(WorkflowWords.usd(1240) == "$1,240")
    }

    @Test func runsListAndControlsHitTheirPaths() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"r2","name":"deep-research","status":"waiting_reset","resumeAt":99,"counts":{"agents":3},"createdAt":2}]"#)
        let runs = try await hub.client().workflowRuns(sessionId: "s1", limit: 50)
        let req = try #require(hub.take())
        #expect(req.path == "/api/workflows/runs")
        #expect(req.query("sessionId") == "s1")
        #expect(req.query("limit") == "50")
        #expect(req.query("status") == nil)
        #expect(runs.first?.resumeAt == 99)
        #expect(runs.first?.status == .waitingReset)

        for _ in 0..<3 { hub.enqueue(#"{"id":"r2","status":"paused"}"#) }
        _ = try await hub.client().pauseWorkflow("r2")
        _ = try await hub.client().resumeWorkflow("r2")
        _ = try await hub.client().stopWorkflow("r2")
        let paths = (0..<3).compactMap { _ in hub.take() }
        #expect(paths.map(\.path) == ["/api/workflows/runs/r2/pause", "/api/workflows/runs/r2/resume", "/api/workflows/runs/r2/stop"])
        #expect(paths.allSatisfy { $0.method == "POST" })
    }

    @Test func tasksDecodeLenientlyAndTheClientHitsItsRoutes() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"t1","title":"Ship iPad search","status":"doing","priority":2,"labels":["ios"],"updatedAt":5},{"id":"t2","status":"someday"}]"#)
        let tasks = try await hub.client().tasks(status: .doing)
        var req = try #require(hub.take())
        #expect(req.path == "/api/tasks")
        #expect(req.query("status") == "doing")
        #expect(tasks.map(\.status) == [.doing, .inbox])
        #expect(tasks[1].labels.isEmpty)

        hub.enqueue(#"{"id":"t3","title":"Port Usage page","status":"inbox"}"#)
        let made = try await hub.client().createTask(TaskInput(title: "Port Usage page", status: .inbox))
        req = try #require(hub.take())
        #expect(req.method == "POST")
        #expect(req.json == ["title": "Port Usage page", "status": "inbox"])
        #expect(made.id == "t3")

        hub.enqueue(#"{"id":"t3","status":"review"}"#)
        _ = try await hub.client().updateTask("t3", TaskInput(status: .review))
        req = try #require(hub.take())
        #expect(req.method == "PATCH")
        #expect(req.path == "/api/tasks/t3")
        #expect(req.json == ["status": "review"])

        hub.enqueue(#"{"id":"s9","title":"Port Usage page","status":"running"}"#)
        let s = try await hub.client().startTask("t3")
        req = try #require(hub.take())
        #expect(req.path == "/api/tasks/t3/start")
        #expect(s.id == "s9")

        hub.enqueue(#"{"ok":true}"#)
        try await hub.client().deleteTask("t3")
        req = try #require(hub.take())
        #expect(req.method == "DELETE")
        #expect(req.path == "/api/tasks/t3")
    }

    @Test func columnsKeepTheHubsOrderAndSortLikeTheWeb() {
        let tasks = [
            BoardTask(id: "a", status: .todo, priority: 1, updatedAt: 9),
            BoardTask(id: "b", status: .todo, priority: 3, updatedAt: 1),
            BoardTask(id: "c", status: .todo, priority: 1, due: 50, updatedAt: 2),
            BoardTask(id: "d", status: .done, priority: 3, updatedAt: 1),
            BoardTask(id: "e", status: .done, updatedAt: 7),
        ]
        let cols = BoardWords.columns(tasks)
        #expect(cols.map(\.status) == [.inbox, .todo, .doing, .review, .done])
        #expect(cols[1].tasks.map(\.id) == ["b", "c", "a"])
        #expect(cols[4].tasks.map(\.id) == ["e", "d"])
        #expect(BoardWords.summary(tasks) == "5 tasks")
        #expect(BoardWords.summary([BoardTask(id: "x", status: .doing)]) == "1 task, 1 doing")
        #expect(BoardWords.summary([]) == "No tasks")
    }

    @Test func dueWordsAndTheTaskLine() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now: Int64 = 1_795_780_800_000 // Fri 27 Nov 2026, 12:00 UTC
        let h: Int64 = 3_600_000, day: Int64 = 86_400_000
        func words(_ due: Int64, done: Bool = false) -> String? { BoardWords.due(due, done: done, now: now, calendar: cal)?.text }
        #expect(words(now - h) == "overdue")
        #expect(BoardWords.due(now - h, done: false, now: now, calendar: cal)?.tone == .fault)
        #expect(words(now - 2 * day - 1) == "overdue 2d")
        #expect(words(now + 6 * h) == "due 18:00")
        #expect(BoardWords.due(now + 6 * h, done: false, now: now, calendar: cal)?.tone == .warn)
        #expect(words(now + day) == "due tomorrow")
        #expect(words(now + 10 * day) == "due 7 Dec")
        #expect(words(now - 4 * day, done: true) == "was due Mon")
        #expect(BoardWords.due(nil, done: false, now: now) == nil)
        let t = BoardTask(id: "t", status: .todo, priority: 2, agent: "coder", labels: ["ios", "coder"])
        #expect(BoardWords.meta(t, now: now) == "high, ios, coder")
        #expect(BoardWords.priorityWord(1) == nil)
    }
}
