import Foundation

// The "/" menu, Compact, checkpoints, export and /btw (routes.ts; Android ConclaveClient).
extension ConclaveClient {
    public func commands() async throws -> [CommandDef] { try await get(["api", "commands"], query: [("builtins", "1")]) }

    public func runCommand(_ id: String, line: String) async throws -> CommandResult {
        try await send("POST", ["api", "sessions", id, "command"], JSONValue.object(["line": .string(line)]))
    }

    /// Summarize older messages; `instructions` say what the summary must keep.
    public func compact(_ id: String, instructions: String? = nil) async throws {
        var body: JSONObject = [:]
        if let instructions, !instructions.isEmpty { body["instructions"] = .string(instructions) }
        try await sendUnit("POST", ["api", "sessions", id, "compact"], JSONValue.object(body))
    }

    public func checkpoints(_ id: String) async throws -> [Checkpoint] { try await get(["api", "sessions", id, "checkpoints"]) }

    /// "Restore files only": the files go back to the checkpoint, every message stays.
    public func restoreCheckpoint(_ id: String, checkpointId: String) async throws {
        try await sendUnit("POST", ["api", "sessions", id, "checkpoints", checkpointId, "restore"])
    }

    public func exportSession(_ id: String, format: String = "md") async throws -> ExportResult {
        try await get(["api", "sessions", id, "export"], query: [("format", format)])
    }

    public func btw(_ id: String, text: String) async throws -> BtwAnswer {
        try await send("POST", ["api", "sessions", id, "btw"], JSONValue.object(["text": .string(text)]))
    }
}
