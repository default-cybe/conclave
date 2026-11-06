package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Canvas mode DTOs (docs/design/CANVAS-MODE.md): the parts of
// packages/core/src/client/graph.ts and flows.ts the phone reads. Only what
// the read-only canvas shows; unknown keys are ignored.

@Serializable
data class GraphSpan(val start: Int = 0, val end: Int = 0)

/** A call found inside a node's text (a loop or a helper). */
@Serializable
data class GraphInnerCall(val name: String = "", val line: Int = 0, val label: String? = null)

/** A literal option of an agent node; only the label is read here. */
@Serializable
data class GraphLiteral(val value: JsonElement? = null)

@Serializable
data class GraphNode(
    /** Kind plus its ordinal among nodes of that kind ("agent-2"). */
    val id: String,
    /** agent, parallel, pipeline, check, approve, ask, workflow, return, log, code or block. */
    val kind: String = "code",
    val label: String = "",
    val span: GraphSpan = GraphSpan(),
    /** The last phase('...') above it at the top level. */
    val phase: String? = null,
    /** The statement declares a function (a helper): its calls run from other nodes. */
    val fn: Boolean? = null,
    val calls: List<GraphInnerCall> = emptyList(),
    val opts: Map<String, GraphLiteral>? = null,
    /** Flow block: the catalog entry, e.g. fetchUrl. */
    val block: String? = null,
)

@Serializable
data class WorkflowGraph(
    val name: String = "",
    val phases: List<String> = emptyList(),
    val nodes: List<GraphNode> = emptyList(),
    /** A program that does not parse says why. */
    val error: String? = null,
)

/** GET /api/workflows/:id/graph and GET /api/workflows/runs/:id/graph. */
@Serializable
data class WorkflowGraphView(
    val graph: WorkflowGraph = WorkflowGraph(),
    val source: WorkflowSource = WorkflowSource.USER,
    val editable: Boolean = false,
    val readOnly: String? = null,
    val stale: List<String> = emptyList(),
    val workflowId: String? = null,
)

/** The last value or error a program block had in a run. */
@Serializable
data class FlowNodeLive(
    val ok: Boolean = false,
    val ms: Long? = null,
    /** "30 items", "200 chars", the value itself when short. */
    val summary: String? = null,
    val value: String? = null,
    val error: String? = null,
)

@Serializable
enum class FlowRunStatus(val wire: String) {
    @SerialName("approval") APPROVAL("approval"),
    @SerialName("running") RUNNING("running"),
    @SerialName("done") DONE("done"),
    @SerialName("failed") FAILED("failed"),
    @SerialName("stopped") STOPPED("stopped"),
    @SerialName("refused") REFUSED("refused"),
}

@Serializable
data class FlowRunView(
    val runId: String = "",
    val flow: String = "",
    val status: FlowRunStatus = FlowRunStatus.DONE,
    val startedAt: Long = 0,
    val finishedAt: Long? = null,
    val output: String = "",
    /** By node id: present once the block ended. */
    val nodes: Map<String, FlowNodeLive> = emptyMap(),
    val error: String? = null,
)

/** GET /api/sessions/:id/flows/:name/graph */
@Serializable
data class FlowView(
    val name: String = "",
    val path: String = "",
    val graph: WorkflowGraph = WorkflowGraph(),
    val lastRun: FlowRunView? = null,
)

/** POST /api/canvas/programs (Canvas's New): the blank program and the folder's session it is read through. */
@Serializable
data class NewCanvasProgram(
    val sessionId: String = "",
    val device: String = "",
    val cwd: String = "",
    val view: FlowView = FlowView(),
)

/**
 * A run waiting in Canvas's queue on the hub (GET /api/canvas/queue): one file
 * runs at a time and the hub starts the next when the last ends. [file] is
 * workflow:<id> or program:<sessionId>:<name>.
 */
@Serializable
data class CanvasQueuedRun(
    val id: String,
    val file: String = "",
    /** workflow or program. */
    val kind: String = "workflow",
    val workflow: String? = null,
    val sessionId: String? = null,
    val flow: String? = null,
    val args: JsonElement? = null,
    val createdAt: Long = 0,
)

/** GET /api/sessions/:id/flows: one program in the session's folder. */
@Serializable
data class FlowSummary(val name: String, val path: String = "")
