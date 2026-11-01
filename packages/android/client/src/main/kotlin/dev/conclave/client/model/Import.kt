package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Chat import: mirrors packages/core/src/client/import.ts
// (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.13). The hub reads past
// Claude Code, Codex and Gemini CLI chats on a device, copies them into
// sessions, and can learn memory from them. Uploading claude.ai and ChatGPT
// exports stays on the web.

@Serializable
enum class ImportMode(val wire: String) {
    /** Sessions only. Nothing goes to a model. */
    @SerialName("chats") CHATS("chats"),
    /** Sessions, then the learning job. */
    @SerialName("chats-learn") CHATS_LEARN("chats-learn"),
    /** Memory only, no sessions. */
    @SerialName("learn") LEARN("learn"),
}

@Serializable
enum class ImportSessionKind(val wire: String) {
    @SerialName("main") MAIN("main"),
    @SerialName("subagent") SUBAGENT("subagent"),
    @SerialName("automation") AUTOMATION("automation"),
    @SerialName("internal") INTERNAL("internal"),
}

/** Why a row is skipped by default. */
@Serializable
enum class ImportSkip(val wire: String) {
    @SerialName("automation") AUTOMATION("automation"),
    @SerialName("subagent") SUBAGENT("subagent"),
    @SerialName("internal") INTERNAL("internal"),
    @SerialName("too-short") TOO_SHORT("too-short"),
}

/** How an imported session compares with its source now. */
@Serializable
enum class ImportedState {
    @SerialName("current") CURRENT,
    @SerialName("behind") BEHIND,
    @SerialName("diverged") DIVERGED,
}

@Serializable
data class ImportedInfo(
    /** Null when it was only learned from ("Learn memory only"): there is no session yet. */
    val sessionId: String? = null,
    val state: ImportedState = ImportedState.CURRENT,
    val batchId: String = "",
    val learned: Boolean = false,
    /** Messages in the source that are not here yet. */
    val newThere: Int? = null,
)

/**
 * One past chat on a device. [source] stays a plain string ("claude-code",
 * "codex", "gemini", "opencode", "claude-ai", "chatgpt") so a reader the hub
 * adds later still lists. The fields after [device] came with the scan.
 */
@Serializable
data class ExternalSessionInfo(
    val source: String,
    val id: String,
    val title: String = "",
    val cwd: String? = null,
    val updatedAt: Long = 0,
    val messages: Long = 0,
    val device: String = "local",
    /** Stable key of this chat on this device. Selections use it. */
    val key: String = "",
    val path: String = "",
    val fingerprint: String = "",
    val createdAt: Long = 0,
    val gitBranch: String? = null,
    val repo: String? = null,
    val kind: ImportSessionKind = ImportSessionKind.MAIN,
    /** Key of the parent chat, for subagent and internal threads. */
    val parentKey: String? = null,
    /** Prompts the owner typed. */
    val humanPrompts: Int = 0,
    val humanChars: Long = 0,
    val bytes: Long = 0,
    val estTokens: Long = 0,
    val skip: ImportSkip? = null,
    val imported: ImportedInfo? = null,
    val model: String? = null,
)

/** One project in the scan: chats grouped by repo when known, else by folder. */
@Serializable
data class ImportProjectGroup(
    val key: String,
    val name: String = "",
    val repo: String? = null,
    val cwd: String? = null,
    val sources: List<String> = emptyList(),
    val sessions: Int = 0,
    val imported: Int = 0,
    val skipped: Int = 0,
    val first: Long = 0,
    val last: Long = 0,
)

@Serializable
data class ImportFailure(val source: String = "", val error: String = "")

@Serializable
data class ImportScanCounts(val new: Int = 0, val imported: Int = 0, val behind: Int = 0, val diverged: Int = 0, val skipped: Int = 0)

/** A vendor setting that deletes old chats, read on a device. */
@Serializable
data class ImportRetention(
    val device: String = "",
    /** claude-code or gemini */
    val tool: String = "",
    val file: String = "",
    val setting: String = "",
    val value: JsonElement? = null,
    /** high: chats older than about a month are deleted. */
    val risk: String = "none",
    /** One plain sentence for the warning. */
    val text: String = "",
    val fixable: Boolean = false,
)

/** GET /api/import/scan: one page. [groups] comes on the first page only. */
@Serializable
data class ImportScanPage(
    val items: List<ExternalSessionInfo> = emptyList(),
    val next: String? = null,
    val total: Int = 0,
    /** When the device was last read. */
    val scannedAt: Long? = null,
    /** The device is offline and the rows come from the last scan. */
    val offline: Boolean? = null,
    val failed: List<ImportFailure> = emptyList(),
    val retention: List<ImportRetention> = emptyList(),
    val counts: ImportScanCounts = ImportScanCounts(),
    val groups: List<ImportProjectGroup>? = null,
    val unknown: Map<String, Int>? = null,
)

/** The filter part of a scan, as a batch or an estimate takes it. Null fields are not sent. */
@Serializable
data class ImportQuery(
    val sources: List<String>? = null,
    /** Epoch ms. Chats last active before it are left out. */
    val since: Long? = null,
    val until: Long? = null,
    val project: String? = null,
    val kinds: List<String>? = null,
    val includeImported: Boolean? = null,
    val includeSkipped: Boolean? = null,
    val q: String? = null,
)

/**
 * The body of POST /api/import/estimate and /api/import/batches: what to
 * import ([keys], or [query] minus [exclude], or Conclave [sessionIds] or
 * [notLearned] for mode learn) and how. Null fields are not sent.
 */
@Serializable
data class ImportRequest(
    val device: String,
    val mode: ImportMode,
    val keys: List<String>? = null,
    val query: ImportQuery? = null,
    val exclude: List<String>? = null,
    val sessionIds: List<String>? = null,
    val notLearned: Boolean? = null,
    val model: String? = null,
    val includeSkipped: Boolean? = null,
    val episodeNotes: Boolean? = null,
)

@Serializable
data class ImportCostOption(
    val model: String = "",
    val costUsd: Double = 0.0,
    val configured: Boolean? = null,
    /** Billed by a plan, not per token. */
    val free: Boolean? = null,
    val usable: Boolean = true,
)

@Serializable
data class ImportEstimate(
    val sessions: Int = 0,
    /** Chats the selection matched that the batch skips, by reason (too-short, automation...). */
    val skipped: Map<String, Int> = emptyMap(),
    val alreadyImported: Int = 0,
    val windows: Int = 0,
    val tokensIn: Long = 0,
    val tokensOut: Long = 0,
    val consolidationCalls: Int = 0,
    /** The configured model first, then up to two others and the free one. */
    val options: List<ImportCostOption> = emptyList(),
    val model: String = "",
)

@Serializable
enum class ImportBatchStatus(val wire: String) {
    @SerialName("scanning") SCANNING("scanning"),
    @SerialName("importing") IMPORTING("importing"),
    @SerialName("learning") LEARNING("learning"),
    @SerialName("consolidating") CONSOLIDATING("consolidating"),
    @SerialName("paused") PAUSED("paused"),
    @SerialName("waiting_reset") WAITING_RESET("waiting_reset"),
    @SerialName("done") DONE("done"),
    @SerialName("failed") FAILED("failed"),
    @SerialName("cancelled") CANCELLED("cancelled"),
    @SerialName("undone") UNDONE("undone"),
}

@Serializable
data class ImportBatch(
    val id: String,
    val device: String = "local",
    val mode: ImportMode = ImportMode.CHATS,
    val model: String? = null,
    val status: ImportBatchStatus = ImportBatchStatus.DONE,
    val total: Int = 0,
    val imported: Int = 0,
    val updated: Int = 0,
    val forked: Int = 0,
    val unchanged: Int = 0,
    val skipped: Int = 0,
    val failed: Int = 0,
    val learnedSessions: Int = 0,
    val memoriesAdded: Int = 0,
    val memoriesMerged: Int = 0,
    val memoriesReview: Int = 0,
    /** Learned items the checks dropped, by reason. */
    val dropped: Map<String, Int> = emptyMap(),
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val costUsd: Double = 0.0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val finishedAt: Long? = null,
    /** WAITING_RESET: when the model's limit resets and the job goes on. */
    val resumeAt: Long? = null,
    val error: String? = null,
    /** Undo is offered until then (30 days). */
    val undoUntil: Long? = null,
)

@Serializable
data class ImportBatchesResponse(
    val batches: List<ImportBatch> = emptyList(),
    /** Imported chats not learned from yet. */
    val notLearned: Int = 0,
)

@Serializable
data class KeptMemory(val id: String = "", val content: String = "")

@Serializable
data class KeptSession(val id: String = "", val title: String = "")

@Serializable
data class ImportUndoResult(
    val sessionsRemoved: Int = 0,
    val messagesRemoved: Int = 0,
    val memoriesRemoved: Int = 0,
    val supersedesCleared: Int = 0,
    /** Memories the owner edited since the batch, kept. */
    val kept: List<KeptMemory> = emptyList(),
    /** Sessions the owner kept going in after the import, kept whole. */
    val keptSessions: List<KeptSession> = emptyList(),
)

@Serializable
data class ImportSyncResult(
    /** unchanged, updated, forked or failed */
    val state: String = "unchanged",
    val added: Int = 0,
    val forkedSessionId: String? = null,
    val error: String? = null,
)
