import Foundation

// Home's day and the routines (packages/server/src/routes-assistant.ts today and goals; routes.ts routines).
extension ConclaveClient {
    public func today() async throws -> Today { try await get(["api", "assistant", "today"]) }

    public func goals(status: String = "active") async throws -> [Goal] { try await get(["api", "goals"], query: [("status", status)]) }

    public func routines() async throws -> [Routine] { try await get(["api", "routines"]) }

    public func createRoutine(_ input: RoutineInput) async throws -> Routine { try await send("POST", ["api", "routines"], input) }

    public func updateRoutine(_ id: String, _ input: RoutineInput) async throws -> Routine { try await send("PATCH", ["api", "routines", id], input) }

    public func deleteRoutine(_ id: String) async throws { try await sendUnit("DELETE", ["api", "routines", id]) }

    /// Answers once the run has its session; updates come as routine.run events.
    public func runRoutine(_ id: String) async throws -> RoutineRun { try await send("POST", ["api", "routines", id, "run"], JSONValue.object([:])) }

    public func routineRuns(_ id: String, limit: Int = 20) async throws -> [RoutineRun] { try await get(["api", "routines", id, "runs"], query: [("limit", String(limit))]) }

    /// POST /api/workflows/runs/:id/calls/:seq/skip (routes-workflows.ts).
    public func skipWorkflowCall(_ runId: String, seq: Int) async throws -> WorkflowRun {
        try await call("POST", ["api", "workflows", "runs", runId, "calls", String(seq), "skip"])
    }

    /// POST /api/workflows/runs/:id/rerun: `seqs` runs only those calls (their dependents follow), `fromSeq` that one and every later one.
    public func rerunWorkflow(_ runId: String, seqs: [Int]? = nil, fromSeq: Int? = nil) async throws -> WorkflowRun {
        var body: JSONObject = [:]
        if let seqs { body["seqs"] = .array(seqs.map { .number(Double($0)) }) }
        if let fromSeq { body["fromSeq"] = .number(Double(fromSeq)) }
        return try await send("POST", ["api", "workflows", "runs", runId, "rerun"], JSONValue.object(body))
    }

    /// GET /api/workflows: the library (built in, project, yours, plugins). Each workflow's args keep the order the hub's JSON has them (the script's
    /// own), as the web's form lists them; JSONDecoder alone loses it.
    public func workflows() async throws -> [WorkflowSummary] {
        let (data, _) = try await request("GET", ["api", "workflows"])
        var list = try Wire.decoder().decode([WorkflowSummary].self, from: data)
        if let orders = JSONKeyOrder.keys(ofField: "argsSchema", inArray: data), orders.count == list.count {
            for (i, order) in orders.enumerated() {
                guard let order, let fields = list[i].argsSchema else { continue }
                list[i].argsSchema = fields.sorted { (order.firstIndex(of: $0.name) ?? .max) < (order.firstIndex(of: $1.name) ?? .max) }
            }
        }
        return list
    }

    public func workflowPresets(_ id: String) async throws -> [WorkflowPreset] { try await get(["api", "workflows", id, "presets"]) }

    public func saveWorkflowPreset(_ id: String, name: String, args: JSONValue?) async throws -> WorkflowPreset {
        var body: JSONObject = ["name": .string(name)]
        if let args, args != .null { body["args"] = args }
        return try await send("POST", ["api", "workflows", id, "presets"], JSONValue.object(body))
    }

    public func deleteWorkflowPreset(_ id: String, presetId: String) async throws { try await sendUnit("DELETE", ["api", "workflows", id, "presets", presetId]) }

    /// POST /api/workflows/runs {name, args}: the run starts in the background and answers at once.
    public func startWorkflow(_ name: String, args: JSONValue?, device: String? = nil, cwd: String? = nil, budgetTokens: Int? = nil) async throws -> WorkflowRun {
        var body: JSONObject = ["name": .string(name)]
        if let args { body["args"] = args }
        if let device, !device.isEmpty { body["device"] = .string(device) }
        if let cwd, !cwd.isEmpty { body["cwd"] = .string(cwd) }
        if let budgetTokens { body["budget"] = .object(["tokens": .number(Double(budgetTokens))]) }
        return try await send("POST", ["api", "workflows", "runs"], JSONValue.object(body))
    }

    /// POST /api/workflows/runs/:id/findings/:findingId: dismissed needs a reason (later runs learn from it).
    public func judgeFinding(_ runId: String, findingId: String, verdict: FindingVerdict, reason: String? = nil) async throws -> WorkflowFinding {
        var body: JSONObject = ["verdict": .string(verdict.rawValue)]
        if let reason { body["reason"] = .string(reason) }
        return try await send("POST", ["api", "workflows", "runs", runId, "findings", findingId], JSONValue.object(body))
    }

    public func previewSchedule(_ schedule: String) async throws -> SchedulePreview { try await get(["api", "routines", "preview"], query: [("schedule", schedule)]) }
}
