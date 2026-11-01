package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Workflow engine DTOs: mirrors packages/core/src/client/workflows.ts
// (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.17, docs/WORKFLOWS.md).
// Enum fields have defaults, so a state a newer hub adds falls back.

@Serializable
enum class WorkflowRunStatus(val wire: String) {
    @SerialName("queued") QUEUED("queued"),
    @SerialName("running") RUNNING("running"),
    @SerialName("paused") PAUSED("paused"),
    /** A usage limit: the parked calls run again at [WorkflowRun.resumeAt]. */
    @SerialName("waiting_reset") WAITING_RESET("waiting_reset"),
    /** The hub went down while it ran. Resume picks it up from the journal. */
    @SerialName("interrupted") INTERRUPTED("interrupted"),
    @SerialName("done") DONE("done"),
    @SerialName("failed") FAILED("failed"),
    @SerialName("stopped") STOPPED("stopped"),
    /** Stopped at its budget. */
    @SerialName("budget") BUDGET("budget"),
}

@Serializable
enum class WorkflowCallState(val wire: String) {
    @SerialName("queued") QUEUED("queued"),
    @SerialName("running") RUNNING("running"),
    @SerialName("done") DONE("done"),
    @SerialName("failed") FAILED("failed"),
    @SerialName("skipped") SKIPPED("skipped"),
    /** Replayed from the journal on a resume: not paid for again. */
    @SerialName("cached") CACHED("cached"),
    /** Waiting for a usage limit to reset. */
    @SerialName("parked") PARKED("parked"),
}

@Serializable
enum class WorkflowCallKind(val wire: String) {
    @SerialName("agent") AGENT("agent"),
    @SerialName("check") CHECK("check"),
    @SerialName("citation") CITATION("citation"),
    @SerialName("workflow") WORKFLOW("workflow"),
    @SerialName("ask") ASK("ask"),
}

/** Where a workflow came from. INLINE: a script the Workflow tool or the API sent. */
@Serializable
enum class WorkflowSource(val wire: String) {
    @SerialName("builtin") BUILTIN("builtin"),
    @SerialName("plugin") PLUGIN("plugin"),
    @SerialName("user") USER("user"),
    @SerialName("project") PROJECT("project"),
    @SerialName("claude-code") CLAUDE_CODE("claude-code"),
    @SerialName("inline") INLINE("inline"),
}

@Serializable
enum class WorktreeState(val wire: String) {
    @SerialName("live") LIVE("live"),
    @SerialName("kept") KEPT("kept"),
    @SerialName("removed") REMOVED("removed"),
    @SerialName("merged") MERGED("merged"),
    @SerialName("discarded") DISCARDED("discarded"),
}

@Serializable
data class WorkflowPhase(val title: String = "", val detail: String? = null, val model: String? = null)

@Serializable
data class WorkflowLastRun(
    val id: String,
    val status: WorkflowRunStatus = WorkflowRunStatus.DONE,
    val createdAt: Long = 0,
    val finishedAt: Long? = null,
)

/** One declared arg of a workflow's meta.args; drives the typed launch form. */
@Serializable
data class WorkflowArgField(
    val type: String = "string",
    val description: String? = null,
)

/** GET /api/workflows: one row of the library. */
@Serializable
data class WorkflowSummary(
    /** The name, or plugin:name for plugin workflows. */
    val id: String,
    val name: String = "",
    val description: String = "",
    val whenToUse: String? = null,
    val phases: List<WorkflowPhase> = emptyList(),
    /** The declared args of meta, when the script has any: the launch form is built from it. */
    val argsSchema: Map<String, WorkflowArgField>? = null,
    val source: WorkflowSource = WorkflowSource.USER,
    val path: String? = null,
    /** False when the script uses the Conclave layer. */
    val portable: Boolean = true,
    /** False when the script cannot load here; [error] says why. */
    val runnable: Boolean = true,
    val error: String? = null,
    val lastRun: WorkflowLastRun? = null,
)

/** A saved args preset for one workflow (GET /api/workflows/:id/presets). */
@Serializable
data class WorkflowPreset(
    val id: String,
    val workflow: String = "",
    val name: String = "",
    val args: JsonElement? = null,
    val createdAt: Long = 0,
)

@Serializable
data class WorkflowWorktree(
    val branch: String = "",
    val path: String? = null,
    val commit: String? = null,
    val state: WorktreeState = WorktreeState.KEPT,
    val files: Int? = null,
)

/** One agent, check or nested workflow of a run. */
@Serializable
data class WorkflowCall(
    val seq: Int,
    val kind: WorkflowCallKind = WorkflowCallKind.AGENT,
    val label: String? = null,
    val phase: String? = null,
    val agentType: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val state: WorkflowCallState = WorkflowCallState.QUEUED,
    val attempt: Int = 1,
    val childSessionId: String? = null,
    /** The workflow() call this call ran under. */
    val parentSeq: Int? = null,
    val lastTool: String? = null,
    /** "approval" while the agent waits on a tool approval. */
    val waiting: String? = null,
    val promptPreview: String? = null,
    val resultPreview: String? = null,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val costUsd: Double = 0.0,
    val worktree: WorkflowWorktree? = null,
    /** Why it failed or was skipped. */
    val error: String? = null,
    val queuedAt: Long? = null,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
) {
    val tokens: Long get() = inputTokens + outputTokens
    val waitingOnOwner: Boolean get() = state == WorkflowCallState.RUNNING && waiting == "approval"
}

@Serializable
data class WorkflowCounts(
    val agents: Int = 0,
    val queued: Int = 0,
    val running: Int = 0,
    val done: Int = 0,
    val cached: Int = 0,
    val failed: Int = 0,
    val skipped: Int = 0,
    val parked: Int = 0,
)

@Serializable
data class WorkflowBudget(val tokens: Long? = null, val costUsd: Double? = null)

@Serializable
data class WorkflowRun(
    val id: String,
    val name: String = "",
    val description: String? = null,
    val source: WorkflowSource = WorkflowSource.INLINE,
    val status: WorkflowRunStatus = WorkflowRunStatus.QUEUED,
    /** The session that started it, if any. */
    val sessionId: String? = null,
    val device: String = "local",
    val cwd: String = "",
    val phases: List<WorkflowPhase> = emptyList(),
    /** Index into [phases] of the current phase, -1 before the first phase() call. */
    val phaseIndex: Int = -1,
    val phaseTitle: String? = null,
    val budget: WorkflowBudget? = null,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val costUsd: Double = 0.0,
    val counts: WorkflowCounts = WorkflowCounts(),
    val scriptPath: String? = null,
    val portable: Boolean = true,
    val background: Boolean? = null,
    /** The Workflow tool call that started it, when an agent did: a session's row finds its run by it. */
    val toolUseId: String? = null,
    val parentRunId: String? = null,
    val resumedFrom: String? = null,
    /** WAITING_RESET: when the parked calls run again. */
    val resumeAt: Long? = null,
    val error: String? = null,
    val createdAt: Long = 0,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
)

@Serializable
data class WorkflowLogLine(val n: Int = 0, val ts: Long = 0, val text: String = "")

@Serializable
enum class FindingVerdict(val wire: String) {
    @SerialName("fixed") FIXED("fixed"),
    @SerialName("dismissed") DISMISSED("dismissed"),
    @SerialName("ignored") IGNORED("ignored"),
}

@Serializable
data class WorkflowFinding(
    val id: String,
    val runId: String = "",
    val workflow: String = "",
    val project: String? = null,
    val findingKey: String = "",
    val file: String? = null,
    val line: Int? = null,
    val title: String = "",
    val priority: String? = null,
    val proven: Boolean = false,
    val verdict: FindingVerdict? = null,
    val reason: String? = null,
    val createdAt: Long = 0,
    val decidedAt: Long? = null,
)

/** GET /api/workflows/runs/:id. [result] is whatever the script returned: text, an object, or nothing. */
@Serializable
data class WorkflowRunDetail(
    val run: WorkflowRun,
    val calls: List<WorkflowCall> = emptyList(),
    val logs: List<WorkflowLogLine> = emptyList(),
    val result: JsonElement? = null,
    val findings: List<WorkflowFinding> = emptyList(),
    /** Findings the verifiers refuted divided by findings checked, when the run had a panel. */
    val refutedRate: Double? = null,
)

/** POST /api/workflows/runs. One of [name], [script], [scriptPath] or [resumeFromRunId]. Null fields are not sent. */
@Serializable
data class StartWorkflowInput(
    val name: String? = null,
    val script: String? = null,
    val scriptPath: String? = null,
    val args: JsonElement? = null,
    val sessionId: String? = null,
    val device: String? = null,
    val cwd: String? = null,
    val budget: WorkflowBudget? = null,
    val resumeFromRunId: String? = null,
    val background: Boolean? = null,
)

@Serializable
data class WorktreeActionResult(val ok: Boolean = false, val state: WorktreeState = WorktreeState.KEPT, val output: String = "")
