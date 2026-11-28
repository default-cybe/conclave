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
        guard p.count >= 3, p[0] == "api", p[1] == "workflows", p[2] == "runs" else { return nil }
        let runs = boardRuns()
        if p.count == 3, method == "GET" { return (200, boardJSON(runs)) }
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
               "result": ["report": "No blocking issues. Two nits in TasksView."]]
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
