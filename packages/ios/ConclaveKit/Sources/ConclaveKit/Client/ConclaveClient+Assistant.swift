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

    public func previewSchedule(_ schedule: String) async throws -> SchedulePreview { try await get(["api", "routines", "preview"], query: [("schedule", schedule)]) }
}
