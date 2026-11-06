package dev.conclave.client

import dev.conclave.client.model.CanvasQueuedRun
import dev.conclave.client.model.FlowRunView
import dev.conclave.client.model.FlowSummary
import dev.conclave.client.model.FlowView
import dev.conclave.client.model.NewCanvasProgram
import dev.conclave.client.model.WorkflowGraphView
import dev.conclave.client.model.WorkflowSummary
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Canvas (docs/design/CANVAS-MODE.md): the same calls as flows ... stopFlow,
// workflowGraph and workflowRunGraph in packages/core/src/client/index.ts.

/** The programs (flows/<name>.flow.ts) in a Code session's folder. */
suspend fun ConclaveClient.flows(sessionId: String): List<FlowSummary> =
    get(p("api", "sessions", sessionId, "flows"), ListSerializer(FlowSummary.serializer()))

/**
 * Canvas's New: a blank flows/untitled-N.flow.ts. With no folder the owner's goes to their Canvas
 * folder on the hub; a member gets 400 there and names a device and folder of their own.
 */
suspend fun ConclaveClient.newCanvasProgram(device: String? = null, cwd: String? = null): NewCanvasProgram =
    sendJson(
        "POST", p("api", "canvas", "programs"),
        buildJsonObject {
            if (device != null) put("device", device)
            if (cwd != null) put("cwd", cwd)
        },
        NewCanvasProgram.serializer(),
    )

suspend fun ConclaveClient.flowGraph(sessionId: String, name: String): FlowView =
    get(p("api", "sessions", sessionId, "flows", name, "graph"), FlowView.serializer())

/** The program's current run, or null when none was started since the hub started. */
suspend fun ConclaveClient.flowRun(sessionId: String, name: String): FlowRunView? =
    call("GET", p("api", "sessions", sessionId, "flows", name, "run"), emptyMap(), null, FlowRunView.serializer().nullable)

suspend fun ConclaveClient.runFlow(sessionId: String, name: String): FlowRunView =
    sendJson("POST", p("api", "sessions", sessionId, "flows", name, "run"), null, FlowRunView.serializer())

suspend fun ConclaveClient.stopFlow(sessionId: String, name: String): FlowRunView? =
    call("POST", p("api", "sessions", sessionId, "flows", name, "stop"), emptyMap(), null, FlowRunView.serializer().nullable)

suspend fun ConclaveClient.workflowGraph(id: String): WorkflowGraphView =
    get(p("api", "workflows", id, "graph"), WorkflowGraphView.serializer())

/** The graph of the script a run ran. */
suspend fun ConclaveClient.workflowRunGraph(runId: String): WorkflowGraphView =
    get(p("api", "workflows", "runs", runId, "graph"), WorkflowGraphView.serializer())

/** The caller's queued Canvas runs, oldest first; [file] (Canvas.queueFile) narrows to one file. */
suspend fun ConclaveClient.canvasQueue(file: String? = null): List<CanvasQueuedRun> =
    get(p("api", "canvas", "queue"), ListSerializer(CanvasQueuedRun.serializer()), mapOf("file" to file))

/** Queue a workflow run on the hub; it starts when the workflow's current run ends. */
suspend fun ConclaveClient.queueWorkflowRun(workflow: String, args: JsonElement? = null): CanvasQueuedRun =
    sendJson(
        "POST", p("api", "canvas", "queue"),
        buildJsonObject {
            put("workflow", workflow)
            if (args != null && args !is JsonNull) put("args", args)
        },
        CanvasQueuedRun.serializer(),
    )

/** Queue a program run (flows/<flow>.flow.ts in the session's folder). */
suspend fun ConclaveClient.queueFlowRun(sessionId: String, flow: String): CanvasQueuedRun =
    sendJson(
        "POST", p("api", "canvas", "queue"),
        buildJsonObject {
            put("sessionId", sessionId)
            put("flow", flow)
        },
        CanvasQueuedRun.serializer(),
    )

/** Take a queued run off the queue (204). */
suspend fun ConclaveClient.cancelCanvasRun(id: String) = sendUnit("DELETE", p("api", "canvas", "queue", id))

/** One workflow (GET /api/workflows/:id): its args schema and last run; the script is not read here. */
suspend fun ConclaveClient.workflow(id: String): WorkflowSummary = get(p("api", "workflows", id), WorkflowSummary.serializer())
