#if DEBUG
import Foundation

/// Board and workflow fixtures for `-mockHub`: seven tasks across the columns, one running run
/// (parity-batch, 3 phases, 4 agents, a log) and two finished ones. Writes answer as if saved.
extension MockHub {
    /// Status and JSON for /api/tasks and /api/workflows/runs; nil for every other route.
    static func boardReply(_ method: String, _ url: URL, _ body: Data?) -> (Int, String)? {
        let p = url.path.split(separator: "/").map(String.init)
        let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        if p.count >= 2, p[0] == "api", p[1] == "tasks" {
            let tasks = boardTasks()
            switch (method, p.count) {
            case ("GET", 2): return (200, boardJSON(tasks))
            case ("POST", 2):
                var t: [String: Any] = ["id": "t-\(UUID().uuidString.prefix(6))", "description": "", "status": "inbox", "priority": 0,
                                        "labels": [String](), "createdAt": boardNow, "updatedAt": boardNow]
                for (k, v) in input { t[k] = v }
                return (200, boardJSON(t))
            default: break
            }
            guard p.count >= 3, var t = tasks.first(where: { $0["id"] as? String == p[2] }) else { return (404, #"{"error":"unknown task"}"#) }
            switch (method, p.count) {
            case ("PATCH", 3):
                for (k, v) in input { t[k] = v }
                t["updatedAt"] = boardNow
                return (200, boardJSON(t))
            case ("DELETE", 3): return (200, #"{"ok":true}"#)
            case ("POST", 4) where p[3] == "start":
                return (200, boardJSON(["id": "s1", "title": t["title"] ?? "", "status": "running", "taskId": p[2], "updatedAt": boardNow] as [String: Any]))
            default: return nil
            }
        }
        // the "/" menu, Checkpoints, commands and /btw (ConclaveClient+Commands)
        if p == ["api", "commands"] {
            return (200, boardJSON([
                ["name": "clear", "description": "Clear the conversation and start fresh", "source": "builtin", "chat": true, "body": ""],
                ["name": "compact", "description": "Summarize older messages to free context", "argumentHint": "[instructions]", "source": "builtin", "chat": true, "body": ""],
                ["name": "cost", "description": "Tokens and cost of this session", "source": "builtin", "chat": true, "body": ""],
                ["name": "export", "description": "Share this session as Markdown", "source": "builtin", "chat": true, "body": ""],
                ["name": "fork", "description": "Fork this session", "source": "builtin", "chat": true, "body": ""],
                ["name": "init", "description": "Write an AGENTS.md that explains this project", "source": "builtin", "body": ""],
                ["name": "review", "description": "Second opinion on the last reply", "argumentHint": "[model]", "source": "builtin", "body": ""],
                ["name": "ship", "description": "Run the tests, then open a pull request", "source": "user", "body": "x"],
            ] as [[String: Any]]))
        }
        if p.count == 4, p[0] == "api", p[1] == "sessions" {
            switch (method, p[3]) {
            case ("GET", "checkpoints"):
                return (200, boardJSON([["id": "cp2", "sessionId": p[2], "seq": 14, "commit": "9f3c2a71bd", "files": 3, "createdAt": boardAgo(12)],
                                        ["id": "cp1", "sessionId": p[2], "seq": 6, "commit": "41ad0e9c55", "files": 1, "createdAt": boardAgo(95)]] as [[String: Any]]))
            case ("POST", "command"): return (200, #"{"ok":true,"output":"Compacted."}"#)
            case ("POST", "btw"): return (200, #"{"answer":"It reads the cache first, so the second run is fast."}"#)
            case ("GET", "export"): return (200, #"{"content":"# Chat\n\nHello","filename":"chat.md"}"#)
            default: break
            }
        }
        if p.count == 6, p[0] == "api", p[1] == "sessions", p[3] == "checkpoints", p[5] == "restore" { return (200, #"{"ok":true}"#) }
        if p.count == 2, p[0] == "api", p[1] == "workflows", method == "GET" { return (200, boardJSON(library())) }
        if p.count >= 4, p[0] == "api", p[1] == "workflows", p[2] != "runs", p[3] == "presets" {
            switch method {
            case "GET": return (200, boardJSON(p[2] == "review-changes" ? [["id": "pr1", "workflow": p[2], "name": "ios branch", "args": ["base": "main", "strict": true], "createdAt": boardAgo(3000)],
                                                                           ["id": "pr2", "workflow": p[2], "name": "quick", "args": ["strict": false], "createdAt": boardAgo(900)]] as [[String: Any]] : [[String: Any]]()))
            case "POST": return (201, boardJSON(["id": "pr-\(UUID().uuidString.prefix(6))", "workflow": p[2], "name": input["name"] ?? "", "args": input["args"] ?? NSNull(), "createdAt": boardNow] as [String: Any]))
            default: return (204, "")
            }
        }
        guard p.count >= 3, p[0] == "api", p[1] == "workflows", p[2] == "runs" else { return nil }
        let runs = boardRuns()
        if p.count == 3, method == "GET" { return (200, boardJSON(runs)) }
        if p.count == 3, method == "POST" {
            var run = runs[0]
            run["id"] = "wfr_parity"
            run["name"] = input["name"] ?? "workflow"
            return (201, boardJSON(run))
        }
        if p.count == 6, method == "POST", p[4] == "findings" {
            guard var f = (boardDetail(runs[1])["findings"] as? [[String: Any]])?.first(where: { $0["id"] as? String == p[5] }) else { return (404, #"{"error":"unknown finding"}"#) }
            f["verdict"] = input["verdict"]
            if let r = input["reason"] { f["reason"] = r }
            f["decidedAt"] = boardNow
            return (200, boardJSON(f))
        }
        guard p.count >= 4, var run = runs.first(where: { $0["id"] as? String == p[3] }) else { return (404, #"{"error":"unknown run"}"#) }
        if p.count == 4, method == "GET" { return (200, boardJSON(boardDetail(run))) }
        if p.count == 5, method == "POST" {
            switch p[4] {
            case "pause": run["status"] = "paused"
            case "resume": run["status"] = "running"
            case "stop": run["status"] = "stopped"; run["finishedAt"] = boardNow
            default: return nil
            }
            return (200, boardJSON(run))
        }
        return nil
    }

    private static var boardNow: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private static func boardAgo(_ min: Double) -> Int64 { boardNow - Int64(min * 60_000) }

    private static func boardJSON(_ v: Any) -> String {
        String(decoding: (try? JSONSerialization.data(withJSONObject: v)) ?? Data("null".utf8), as: UTF8.self)
    }

    private static func boardTasks() -> [[String: Any]] {
        func task(_ id: String, _ title: String, _ status: String, _ priority: Int, _ labels: [String], agent: String? = nil, dueH: Double? = nil,
                  _ min: Double, _ description: String = "") -> [String: Any] {
            var t: [String: Any] = ["id": id, "title": title, "description": description, "status": status, "priority": priority, "labels": labels,
                                    "createdAt": boardAgo(min + 600), "updatedAt": boardAgo(min)]
            if let agent { t["agent"] = agent }
            if let dueH { t["due"] = boardNow + Int64(dueH * 3_600_000) }
            return t
        }
        return [
            task("t1", "Ship iPad search", "doing", 3, ["ios"], agent: "coder", dueH: 5, 12, "Search across chats from the sidebar, with the web's ranking."),
            task("t2", "Port Usage page", "doing", 2, ["ios"], agent: "coder", 40),
            task("t3", "Port Tasks board", "review", 2, ["ios"], dueH: 26, 95),
            task("t4", "Widget for running tasks", "todo", 1, ["ios", "widget"], 300),
            task("t5", "Check share sheet on iPhone SE", "todo", 0, ["qa"], dueH: -30, 900),
            task("t6", "Idea: offline drafts", "inbox", 0, [], 1440),
            task("t7", "Pairing QR code", "done", 2, ["ios"], agent: "coder", 2880),
        ]
    }

    private static func boardRuns() -> [[String: Any]] {
        [
            ["id": "wfr_parity", "name": "parity-batch", "description": "Port the remaining Android pages to iOS", "source": "user", "status": "running",
             "sessionId": "s1", "device": "local", "cwd": "/home/conclave/work/cv-ios",
             "phases": [["title": "Plan"], ["title": "Port", "detail": "One agent per page"], ["title": "Verify"]], "phaseIndex": 1, "phaseTitle": "Port",
             "inputTokens": 186_000, "outputTokens": 14_200, "costUsd": 1.84,
             "counts": ["agents": 4, "queued": 1, "running": 2, "done": 1], "createdAt": boardAgo(19), "startedAt": boardAgo(18)],
            ["id": "wfr_review", "name": "review-changes", "source": "builtin", "status": "done", "sessionId": "s2", "device": "local", "cwd": "/home/conclave/work/cv-ios",
             "phases": [["title": "Find"], ["title": "Verify"]], "phaseIndex": 1,
             "inputTokens": 412_000, "outputTokens": 21_000, "costUsd": 3.1,
             "counts": ["agents": 6, "done": 6], "createdAt": boardAgo(190), "startedAt": boardAgo(189), "finishedAt": boardAgo(176)],
            ["id": "wfr_research", "name": "deep-research", "source": "builtin", "status": "failed", "device": "local", "cwd": "",
             "phases": [["title": "Search"], ["title": "Write"]], "phaseIndex": 0,
             "inputTokens": 58_000, "outputTokens": 3_100, "costUsd": 0.42, "error": "every search agent hit the usage limit",
             "counts": ["agents": 3, "done": 1, "failed": 2], "createdAt": boardAgo(1500), "startedAt": boardAgo(1500), "finishedAt": boardAgo(1492)],
        ]
    }

    private static func library() -> [[String: Any]] {
        [
            ["id": "review-changes", "name": "review-changes", "description": "Review the working changes with a finder panel and refuters, then report what holds up.",
             "whenToUse": "Before you open a pull request.", "source": "builtin", "portable": false, "runnable": true,
             "phases": [["title": "Scope"], ["title": "Find"], ["title": "Verify"], ["title": "Report"]],
             "argsSchema": ["base": ["type": "string", "description": "Branch to compare with"], "votes": ["type": "number", "description": "Refuters per finding"],
                            "strict": ["type": "boolean", "description": "Report only proven findings"]],
             "lastRun": ["id": "wfr_review", "status": "done", "createdAt": boardAgo(190), "finishedAt": boardAgo(176)]],
            ["id": "deep-research", "name": "deep-research", "description": "Search the web in parallel, check every claim against its source and write a cited report.",
             "source": "builtin", "portable": true, "runnable": true, "phases": [["title": "Search"], ["title": "Check"], ["title": "Write"]],
             "argsSchema": ["question": ["type": "string", "description": "What to find out"]],
             "lastRun": ["id": "wfr_research", "status": "failed", "createdAt": boardAgo(1500), "finishedAt": boardAgo(1492)]],
            ["id": "bug-hunt", "name": "bug-hunt", "description": "Hunt for bugs file by file and prove each with a failing test.", "source": "builtin", "portable": false, "runnable": true,
             "phases": [["title": "Map"], ["title": "Hunt"], ["title": "Prove"]]],
            ["id": "parity-batch", "name": "parity-batch", "description": "Port the remaining Android pages to iOS, one agent per page.", "source": "project", "portable": false, "runnable": true,
             "phases": [["title": "Plan"], ["title": "Port"], ["title": "Verify"]],
             "lastRun": ["id": "wfr_parity", "status": "running", "createdAt": boardAgo(19)]],
            ["id": "nightly-notes", "name": "nightly-notes", "description": "Turn the day's sessions into notes.", "source": "user", "portable": true, "runnable": false,
             "phases": [[String: Any]](), "error": "SyntaxError: Unexpected token at line 14"],
        ]
    }

    private static func boardDetail(_ run: [String: Any]) -> [String: Any] {
        func call(_ seq: Int, _ label: String, _ phase: String, _ state: String, model: String = "anthropic/claude-sonnet-5-5",
                  tool: String? = nil, child: String? = nil, tokens: Int = 0, cost: Double = 0, error: String? = nil) -> [String: Any] {
            var c: [String: Any] = ["seq": seq, "kind": "agent", "label": label, "phase": phase, "model": model, "state": state, "attempt": 1,
                                    "inputTokens": tokens, "outputTokens": tokens / 12, "costUsd": cost]
            if let tool { c["lastTool"] = tool }
            if let child { c["childSessionId"] = child }
            if let error { c["error"] = error }
            return c
        }
        switch run["id"] as? String {
        case "wfr_parity":
            return ["run": run, "calls": [
                call(1, "map the gaps", "Plan", "done", model: "anthropic/claude-opus-5-5", tokens: 42_000, cost: 0.61),
                call(2, "port Usage page", "Port", "running", tool: "Editing UsageView.swift", child: "s2", tokens: 61_000, cost: 0.58),
                call(3, "port Tasks board", "Port", "running", tool: "Running swift test", tokens: 70_000, cost: 0.65),
                call(4, "check parity", "Verify", "queued"),
            ], "logs": [
                ["n": 1, "ts": boardAgo(18), "text": "Planning: 2 pages left to port."],
                ["n": 2, "ts": boardAgo(15), "text": "Plan done: Usage page, Tasks board."],
                ["n": 3, "ts": boardAgo(14), "text": "Porting 2 pages in parallel."],
                ["n": 4, "ts": boardAgo(2), "text": "Tasks board: tests running."],
            ]]
        case "wfr_review":
            return ["run": run, "calls": [
                call(1, "correctness", "Find", "done", tokens: 120_000, cost: 0.9),
                call(2, "verify findings", "Verify", "done", tokens: 90_000, cost: 0.7),
            ], "logs": [["n": 1, "ts": boardAgo(176), "text": "No blocking issues."]],
               "result": ["report": "No blocking issues. Two nits in TasksView."],
               "refutedRate": 0.25,
               "findings": [
                   ["id": "f1", "runId": "wfr_review", "workflow": "review-changes", "findingKey": "k1", "title": "Board drag drops the task when the column scrolls", "priority": "P1",
                    "file": "App/Sources/Pages/TasksView.swift", "line": 212, "proven": true, "createdAt": boardAgo(178),
                    "data": ["quote": "guard let target = columns.first(where: { $0.frame.contains(p) })", "scenario": "Drag a card to Done while the board is scrolled right."]],
                   ["id": "f2", "runId": "wfr_review", "workflow": "review-changes", "findingKey": "k2", "title": "Due word says tomorrow for a task due at midnight", "priority": "P2",
                    "file": "ConclaveKit/Sources/ConclaveKit/Logic/BoardWords.swift", "line": 48, "proven": false, "votes": ["confirmed", "confirmed", "refuted"], "createdAt": boardAgo(178)],
                   ["id": "f3", "runId": "wfr_review", "workflow": "review-changes", "findingKey": "k3", "title": "Unused import in TasksView", "priority": "P3",
                    "file": "App/Sources/Pages/TasksView.swift", "line": 3, "proven": false, "verdict": "dismissed", "reason": "SwiftUI needs it for previews.", "createdAt": boardAgo(178)],
               ]]
        default:
            return ["run": run, "calls": [
                call(1, "search 1", "Search", "done", tokens: 30_000, cost: 0.2),
                call(2, "search 2", "Search", "failed", error: "usage limit reached"),
                call(3, "search 3", "Search", "failed", error: "usage limit reached"),
            ], "logs": [["n": 1, "ts": boardAgo(1492), "text": "Stopped: every search agent hit the usage limit."]]]
        }
    }
}
#endif
