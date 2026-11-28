import Foundation

// The board's tasks and workflow runs (server routes.ts /api/tasks, routes-workflows.ts
// /api/workflows/runs; Android ConclaveClient.kt tasks() and ConclaveClientWorkflows.kt).
extension ConclaveClient {
    public func tasks(status: TaskStatus? = nil, agent: String? = nil, project: String? = nil) async throws -> [BoardTask] {
        try await get(["api", "tasks"], query: [("status", status?.rawValue), ("agent", agent), ("project", project)])
    }

    /// The hub needs a title.
    public func createTask(_ input: TaskInput) async throws -> BoardTask { try await send("POST", ["api", "tasks"], input) }

    public func updateTask(_ id: String, _ patch: TaskInput) async throws -> BoardTask { try await send("PATCH", ["api", "tasks", id], patch) }

    public func deleteTask(_ id: String) async throws { try await sendUnit("DELETE", ["api", "tasks", id]) }

    /// Starts a session on the task; open the session it returns.
    public func startTask(_ id: String, _ opts: StartTaskInput = StartTaskInput()) async throws -> Session {
        try await send("POST", ["api", "tasks", id, "start"], opts)
    }

    /// Runs, newest first.
    public func workflowRuns(sessionId: String? = nil, status: WorkflowRunStatus? = nil, name: String? = nil, limit: Int? = nil) async throws -> [WorkflowRun] {
        try await get(["api", "workflows", "runs"], query: [
            ("sessionId", sessionId), ("status", status?.rawValue), ("name", name), ("limit", limit.map { "\($0)" }),
        ])
    }

    public func workflowRun(_ id: String) async throws -> WorkflowRunDetail { try await get(["api", "workflows", "runs", id]) }

    /// Stops launching calls; the ones in flight finish.
    public func pauseWorkflow(_ id: String) async throws -> WorkflowRun { try await call("POST", ["api", "workflows", "runs", id, "pause"]) }

    public func resumeWorkflow(_ id: String) async throws -> WorkflowRun { try await call("POST", ["api", "workflows", "runs", id, "resume"]) }

    /// Aborts the calls in flight and ends the script. Finished calls stay in the journal.
    public func stopWorkflow(_ id: String) async throws -> WorkflowRun { try await call("POST", ["api", "workflows", "runs", id, "stop"]) }
}
