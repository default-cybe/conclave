package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// The Map: mirrors packages/core/src/client/map.ts (docs/DESIGN.md 29).
// GET /api/map is the snapshot, ?at= the same view rebuilt from stored rows,
// and map.delta events move a live one on (map/MapModel.kt applies them).
// Enums have defaults, so a value a newer hub adds falls back instead of failing.

/**
 * RUNNING: a turn is going. WAITING: it waits on you. PAUSED: a usage limit.
 * IDLE: between turns. DONE: a subagent, workflow agent or run that
 * finished. FAILED: the last turn or run ended in an error.
 */
@Serializable
enum class MapState(val wire: String) {
    @SerialName("running") RUNNING("running"),
    @SerialName("waiting") WAITING("waiting"),
    @SerialName("idle") IDLE("idle"),
    @SerialName("done") DONE("done"),
    @SerialName("failed") FAILED("failed"),
    @SerialName("paused") PAUSED("paused");

    companion object {
        fun of(wire: String?): MapState? = entries.firstOrNull { it.wire == wire }
    }
}

/** CHAT: the Chat page. SESSION: a workbench session. SUBAGENT: started by another. WORKFLOW: a run. AGENT: a run's agent. */
@Serializable
enum class MapNodeKind(val wire: String) {
    @SerialName("chat") CHAT("chat"),
    @SerialName("session") SESSION("session"),
    @SerialName("subagent") SUBAGENT("subagent"),
    @SerialName("workflow") WORKFLOW("workflow"),
    @SerialName("agent") AGENT("agent"),
}

@Serializable
data class MapTool(
    /** The tool_use id. */
    val id: String? = null,
    val name: String = "",
    /** What it works on: a file name, a command, a pattern, a host. */
    val target: String? = null,
    val startedAt: Long = 0,
    /** Null while it runs. */
    val durationMs: Long? = null,
    val error: Boolean = false,
)

@Serializable
data class MapUsage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val costUsd: Double = 0.0,
)

@Serializable
data class MapNode(
    /** The session id; a workflow run is "wf:<run id>". */
    val id: String,
    val kind: MapNodeKind = MapNodeKind.SESSION,
    val title: String = "",
    val state: MapState = MapState.IDLE,
    /** What a waiting node waits on: "approval" or "question". */
    val waitingOn: String? = null,
    val agent: String? = null,
    /** "provider/model". */
    val model: String? = null,
    val device: String = "local",
    /** The folder it works in. Chats have none. */
    val cwd: String? = null,
    /** The group it hangs off (MapGroup.id). */
    val group: String = "",
    /** The node it hangs off: a subagent's session, a workflow agent's run. */
    val parentId: String? = null,
    /** Workflow run id, for runs and their agents. */
    val runId: String? = null,
    val startedAt: Long = 0,
    val lastActivityAt: Long = 0,
    val endedAt: Long? = null,
    /** The tool running now. */
    val tool: MapTool? = null,
    /** The last tools, newest first, at most 5. */
    val tools: List<MapTool> = emptyList(),
    val usage: MapUsage = MapUsage(),
    /** Output tokens in the last minute. */
    val tokensPerMin: Double = 0.0,
    /** Output tokens per second now, smoothed (the streams follow it). */
    val rate: Double = 0.0,
    val error: String? = null,
    /** Paused: when the limit resets. */
    val resumeAt: Long? = null,
    /** When the node stopped making progress (the stuck alert, docs/DESIGN.md 28). */
    val stuckSince: Long? = null,
)

/** A project, a folder without one, or the chats. [kind] is "project", "folder" or "chats". */
@Serializable
data class MapGroup(
    val id: String,
    val kind: String = "folder",
    val name: String = "",
    /** "local" for the hub itself. */
    val device: String = "local",
    val projectId: String? = null,
    val path: String? = null,
) {
    val isChats: Boolean get() = kind == "chats"
}

@Serializable
data class MapDevice(
    val id: String,
    val name: String = "",
    /** Unknown in a replay. */
    val online: Boolean? = null,
)

/** Two agents changing the same file (the file conflict alert). */
@Serializable
data class MapConflict(
    val a: String,
    val b: String,
    val file: String = "",
    val since: Long = 0,
)

@Serializable
data class MapToday(val from: Long = 0, val tokens: Long = 0, val costUsd: Double = 0.0)

@Serializable
data class MapTotals(
    val running: Int = 0,
    val waiting: Int = 0,
    /** Since local midnight of the day shown. */
    val today: MapToday = MapToday(),
)

@Serializable
data class MapHub(val name: String = "", val state: MapState = MapState.IDLE)

@Serializable
data class MapSnapshot(
    /** The time it shows. */
    val at: Long = 0,
    /** False for a replay. */
    val live: Boolean = true,
    /** The earliest time a replay reaches. */
    val from: Long = 0,
    val hub: MapHub = MapHub(),
    val devices: List<MapDevice> = emptyList(),
    val groups: List<MapGroup> = emptyList(),
    val nodes: List<MapNode> = emptyList(),
    val totals: MapTotals = MapTotals(),
    val conflicts: List<MapConflict> = emptyList(),
)

/**
 * Part of a node that changed: only what changed is set. [clearTool] and
 * [clearWaitingOn] are the hub's null ("none runs now", "waits on nothing").
 * Read from the event's JSON by MapDeltas.parse, which tells a null from a
 * field that is not there.
 */
data class MapNodePatch(
    val id: String,
    /** A node the client may not have yet: the whole of it. */
    val node: MapNode? = null,
    val removed: Boolean = false,
    val state: MapState? = null,
    val waitingOn: String? = null,
    val clearWaitingOn: Boolean = false,
    val title: String? = null,
    val tool: MapTool? = null,
    val clearTool: Boolean = false,
    /** Tools that finished since the last delta, oldest first. */
    val done: List<MapTool> = emptyList(),
    val usage: MapUsage? = null,
    val tokensPerMin: Double? = null,
    val rate: Double? = null,
    val lastActivityAt: Long? = null,
    val endedAt: Long? = null,
    val error: String? = null,
)

/** The map.delta event. */
data class MapDelta(
    val at: Long,
    val nodes: List<MapNodePatch>,
    val groups: List<MapGroup> = emptyList(),
    val devices: List<MapDevice> = emptyList(),
    val hubState: MapState? = null,
)
