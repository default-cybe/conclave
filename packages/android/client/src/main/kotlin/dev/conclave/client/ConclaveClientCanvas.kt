package dev.conclave.client

import dev.conclave.client.model.FlowRunView
import dev.conclave.client.model.FlowSummary
import dev.conclave.client.model.FlowView
import dev.conclave.client.model.WorkflowGraphView
import dev.conclave.client.model.WorkflowSummary
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.nullable

// Canvas (docs/design/CANVAS-MODE.md): the same calls as flows ... stopFlow,
// workflowGraph and workflowRunGraph in packages/core/src/client/index.ts.

/** The programs (flows/<name>.flow.ts) in a Code session's folder. */
suspend fun ConclaveClient.flows(sessionId: String): List<FlowSummary> =
    get(p("api", "sessions", sessionId, "flows"), ListSerializer(FlowSummary.serializer()))

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

/** One workflow (GET /api/workflows/:id): its args schema and last run; the script is not read here. */
suspend fun ConclaveClient.workflow(id: String): WorkflowSummary = get(p("api", "workflows", id), WorkflowSummary.serializer())
