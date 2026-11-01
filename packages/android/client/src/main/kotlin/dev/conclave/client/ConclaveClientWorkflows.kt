package dev.conclave.client

import dev.conclave.client.model.FindingVerdict
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionPatch
import dev.conclave.client.model.StartWorkflowInput
import dev.conclave.client.model.WorkflowFinding
import dev.conclave.client.model.WorkflowPreset
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowRunDetail
import dev.conclave.client.model.WorkflowRunStatus
import dev.conclave.client.model.WorkflowSummary
import dev.conclave.client.model.WorktreeActionResult
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Workflows (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.17), the same
// calls as workflows ... judgeFinding in packages/core/src/client/index.ts.

suspend fun ConclaveClient.workflows(): List<WorkflowSummary> = get(p("api", "workflows"), ListSerializer(WorkflowSummary.serializer()))

/** Saved args presets for one workflow, for the launch form. */
suspend fun ConclaveClient.workflowPresets(id: String): List<WorkflowPreset> =
    get(p("api", "workflows", id, "presets"), ListSerializer(WorkflowPreset.serializer()))

suspend fun ConclaveClient.saveWorkflowPreset(id: String, name: String, args: JsonElement?): WorkflowPreset =
    sendJson(
        "POST", p("api", "workflows", id, "presets"),
        buildJsonObject {
            put("name", name)
            put("args", args ?: JsonNull)
        },
        WorkflowPreset.serializer(),
    )

suspend fun ConclaveClient.deleteWorkflowPreset(id: String, presetId: String) = sendUnit("DELETE", p("api", "workflows", id, "presets", presetId))

suspend fun ConclaveClient.startWorkflow(input: StartWorkflowInput): WorkflowRun =
    send("POST", p("api", "workflows", "runs"), StartWorkflowInput.serializer(), input, WorkflowRun.serializer())

/** Runs, newest first. */
suspend fun ConclaveClient.workflowRuns(
    sessionId: String? = null,
    status: WorkflowRunStatus? = null,
    name: String? = null,
    limit: Int? = null,
): List<WorkflowRun> = get(
    p("api", "workflows", "runs"),
    ListSerializer(WorkflowRun.serializer()),
    mapOf("sessionId" to sessionId, "status" to status?.wire, "name" to name, "limit" to limit),
)

suspend fun ConclaveClient.workflowRun(id: String): WorkflowRunDetail = get(p("api", "workflows", "runs", id), WorkflowRunDetail.serializer())

/** Stops launching calls; the ones in flight finish. */
suspend fun ConclaveClient.pauseWorkflow(id: String): WorkflowRun = sendJson("POST", p("api", "workflows", "runs", id, "pause"), null, WorkflowRun.serializer())

suspend fun ConclaveClient.resumeWorkflow(id: String): WorkflowRun = sendJson("POST", p("api", "workflows", "runs", id, "resume"), null, WorkflowRun.serializer())

/** Aborts the calls in flight and ends the script. Finished calls stay in the journal. */
suspend fun ConclaveClient.stopWorkflow(id: String): WorkflowRun = sendJson("POST", p("api", "workflows", "runs", id, "stop"), null, WorkflowRun.serializer())

/** Run again from one call: earlier calls replay from the journal. */
suspend fun ConclaveClient.rerunWorkflow(id: String, fromSeq: Int): WorkflowRun =
    sendJson("POST", p("api", "workflows", "runs", id, "rerun"), buildJsonObject { put("fromSeq", fromSeq) }, WorkflowRun.serializer())

/** The call returns null to the script. */
suspend fun ConclaveClient.skipWorkflowCall(id: String, seq: Int): WorkflowRun =
    sendJson("POST", p("api", "workflows", "runs", id, "calls", seq.toString(), "skip"), null, WorkflowRun.serializer())

/** [action] is diff, merge, cherry-pick or discard. */
suspend fun ConclaveClient.workflowWorktree(id: String, seq: Int, action: String): WorktreeActionResult =
    sendJson(
        "POST", p("api", "workflows", "runs", id, "calls", seq.toString(), "worktree"),
        buildJsonObject { put("action", action) },
        WorktreeActionResult.serializer(),
    )

suspend fun ConclaveClient.judgeFinding(id: String, findingId: String, verdict: FindingVerdict, reason: String? = null): WorkflowFinding =
    sendJson(
        "POST", p("api", "workflows", "runs", id, "findings", findingId),
        buildJsonObject {
            put("verdict", verdict.wire)
            if (reason != null) put("reason", reason)
        },
        WorkflowFinding.serializer(),
    )

/** The Ultra switch: PATCH /api/sessions/:id with ultra. The hub refuses it on chats. */
suspend fun ConclaveClient.setUltra(sessionId: String, on: Boolean): Session = updateSession(sessionId, SessionPatch(ultra = on))
