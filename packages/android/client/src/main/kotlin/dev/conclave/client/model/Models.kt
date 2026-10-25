package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Mirrors packages/core/src/types.ts. Enum fields have defaults so values added
// by a newer hub fall back instead of failing (ConclaveJson uses coerceInputValues).

// ---------------------------------------------------------------------------
// Messages and sessions
// ---------------------------------------------------------------------------

@Serializable
enum class Role {
    @SerialName("user") USER,
    @SerialName("assistant") ASSISTANT,
}

@Serializable
enum class MessageKind {
    @SerialName("normal") NORMAL,
    @SerialName("aside") ASIDE,
    @SerialName("summary") SUMMARY,
    @SerialName("notice") NOTICE,
}

@Serializable
data class Usage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long? = null,
    val cacheWriteTokens: Long? = null,
    val reasoningTokens: Long? = null,
    val costUsd: Double? = null,
    /** What the call is worth at the model's API prices; more than [costUsd] when a plan served it. */
    val apiValueUsd: Double? = null,
)

@Serializable
data class Message(
    val id: String,
    val sessionId: String = "",
    val seq: Long = 0,
    val role: Role = Role.ASSISTANT,
    val kind: MessageKind = MessageKind.NORMAL,
    val content: List<ContentBlock> = emptyList(),
    /** "provider/model" that produced an assistant message. */
    val model: String? = null,
    val agent: String? = null,
    /** Display label for asides, e.g. "Juror 2" or "Second opinion". */
    val author: String? = null,
    /** Groups messages that belong to one jury/debate/review run. */
    val group: String? = null,
    val usage: Usage? = null,
    val stopReason: String? = null,
    val createdAt: Long = 0,
    val meta: JsonObject? = null,
)

@Serializable
enum class SessionStatus {
    @SerialName("idle") IDLE,
    @SerialName("running") RUNNING,
    @SerialName("waiting_approval") WAITING_APPROVAL,
    @SerialName("waiting_input") WAITING_INPUT,
    @SerialName("waiting_reset") WAITING_RESET,
    /** The owner paused it; it waits for Resume, also across hub restarts. */
    @SerialName("paused") PAUSED,
    @SerialName("error") ERROR,
}

@Serializable
enum class SessionMode(val wire: String) {
    @SerialName("agent") AGENT("agent"),
    @SerialName("chat") CHAT("chat"),
    @SerialName("plan") PLAN("plan"),
    @SerialName("jury") JURY("jury"),
    @SerialName("debate") DEBATE("debate"),
    @SerialName("loop") LOOP("loop"),
}

@Serializable
enum class PermissionMode(val wire: String) {
    @SerialName("default") DEFAULT("default"),
    @SerialName("acceptEdits") ACCEPT_EDITS("acceptEdits"),
    @SerialName("plan") PLAN("plan"),
    @SerialName("bypass") BYPASS("bypass"),
}

@Serializable
data class SessionStats(
    val messages: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    /** Cache writes; 0 from a hub that does not count them. */
    val cacheWriteTokens: Long = 0,
    val costUsd: Double = 0.0,
    /** The same tokens at API prices; null from a hub before it was kept. */
    val apiValueUsd: Double? = null,
)

@Serializable
data class JuryConfig(
    val jurors: List<String> = emptyList(),
    val judge: String? = null,
    /** synthesize, vote or rank */
    val strategy: String = "synthesize",
    val anonymize: Boolean = false,
    /** none or readonly */
    val jurorTools: String = "none",
)

@Serializable
data class DebateConfig(
    val a: String = "",
    val b: String = "",
    val rounds: Int = 2,
    val judge: String? = null,
    val stanceA: String? = null,
    val stanceB: String? = null,
)

@Serializable
data class LoopConfig(
    val untilCommand: String? = null,
    val untilText: String? = null,
    val maxIterations: Int = 5,
)

@Serializable
data class ModeConfig(
    val jury: JuryConfig? = null,
    val debate: DebateConfig? = null,
    val loop: LoopConfig? = null,
)

@Serializable
data class Session(
    val id: String,
    val title: String = "",
    val agent: String = "",
    /** Current "provider/model" for normal turns. */
    val model: String = "",
    val mode: SessionMode = SessionMode.AGENT,
    val permissionMode: PermissionMode = PermissionMode.DEFAULT,
    val cwd: String = "",
    /** Device that runs tools for this session. "local" is the hub itself. */
    val device: String = "local",
    val status: SessionStatus = SessionStatus.IDLE,
    val parentId: String? = null,
    val taskId: String? = null,
    val routineId: String? = null,
    val tags: List<String> = emptyList(),
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val external: Map<String, String>? = null,
    val modeConfig: ModeConfig? = null,
    val stats: SessionStats = SessionStats(),
    /** When status is waiting_reset: epoch ms when the limit resets. */
    val resumeAt: Long? = null,
    val error: String? = null,
    val meta: JsonObject? = null,
    /** "chat" for a plain chat (the Chat tab). Null means an agent session, as all sessions were before chats. */
    val kind: SessionKind? = null,
    /** The chat's switches. Read only when [kind] is chat. */
    val chat: ChatSettings? = null,
    /** The project this session's folder belongs to (folders across devices). */
    val projectId: String? = null,
    /** Ultra: the agent plans and runs workflows for real tasks. Never on for chats. */
    val ultra: Boolean? = null,
) {
    val isChat: Boolean get() = kind == SessionKind.CHAT

    /** The switches in force: a switch the owner never touched is on. Null when this is not a chat. */
    val chatSettings: ChatSettings? get() = if (isChat) chat ?: ChatSettings() else null
}

@Serializable
enum class SessionKind(val wire: String) {
    @SerialName("agent") AGENT("agent"),
    @SerialName("chat") CHAT("chat"),
}

/** Effort for a chat or session (ChatSettings.thinking): off or a level (logic/Effort.kt says which a model has). */
@Serializable
enum class ThinkingLevel(val wire: String, val label: String) {
    @SerialName("off") OFF("off", "Off"),
    @SerialName("low") LOW("low", "Low"),
    @SerialName("medium") MEDIUM("medium", "Medium"),
    @SerialName("high") HIGH("high", "High"),
    @SerialName("xhigh") XHIGH("xhigh", "Extra high"),
    @SerialName("max") MAX("max", "Max"),
    /** A ChatGPT plan's top level (its own model list names it). */
    @SerialName("ultra") ULTRA("ultra", "Ultra"),
    ;

    companion object {
        fun from(wire: String?): ThinkingLevel? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * The switches under the chat composer (docs/design/CHAT-AND-MOTION.md 3.1).
 * A missing switch is on; a null [thinking] uses the agent's setting.
 */
@Serializable
data class ChatSettings(
    /** Offer WebSearch and WebFetch. */
    val webSearch: Boolean = true,
    /** Read memory and let the model save and forget notes. Off leaves no trace in memory. */
    val memory: Boolean = true,
    val thinking: ThinkingLevel? = null,
    /** Cyber access program for a ChatGPT plan model (standard, daybreak_blue, daybreak_red); null sends nothing. */
    val cyber: String? = null,
)

// ---------------------------------------------------------------------------
// Tasks, routines, memory
// ---------------------------------------------------------------------------

@Serializable
enum class TaskStatus(val wire: String, val label: String) {
    @SerialName("inbox") INBOX("inbox", "Inbox"),
    @SerialName("todo") TODO("todo", "To do"),
    @SerialName("doing") DOING("doing", "Doing"),
    @SerialName("review") REVIEW("review", "Review"),
    @SerialName("done") DONE("done", "Done"),
}

@Serializable
data class Task(
    val id: String,
    val title: String = "",
    val description: String = "",
    val status: TaskStatus = TaskStatus.INBOX,
    /** 0..3 */
    val priority: Int = 0,
    val agent: String? = null,
    val project: String? = null,
    val due: Long? = null,
    val labels: List<String> = emptyList(),
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val meta: JsonObject? = null,
)

@Serializable
data class Routine(
    val id: String,
    val name: String = "",
    /** Cron expression or "@every 30m" / "@once 2026-10-20T09:00". */
    val schedule: String = "",
    val timezone: String? = null,
    val agent: String = "",
    val model: String? = null,
    val mode: SessionMode = SessionMode.AGENT,
    val prompt: String = "",
    val cwd: String? = null,
    val device: String? = null,
    val enabled: Boolean = true,
    /** new or reuse */
    val sessionPolicy: String = "new",
    val sessionId: String? = null,
    /** always, on_error or never */
    val notify: String = "always",
    val webhookSecret: String? = null,
    val lastRunAt: Long? = null,
    val nextRunAt: Long? = null,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class RoutineRun(
    val id: String,
    val routineId: String = "",
    val sessionId: String? = null,
    /** running, ok, error or skipped */
    val status: String = "running",
    /** schedule, manual or webhook */
    val trigger: String = "manual",
    val startedAt: Long = 0,
    val finishedAt: Long? = null,
    val error: String? = null,
    val summary: String? = null,
)

@Serializable
enum class MemoryScope(val wire: String) {
    @SerialName("global") GLOBAL("global"),
    @SerialName("project") PROJECT("project"),
    @SerialName("agent") AGENT("agent"),
}

@Serializable
enum class MemoryKind(val wire: String) {
    @SerialName("profile") PROFILE("profile"),
    @SerialName("fact") FACT("fact"),
    @SerialName("episode") EPISODE("episode"),
    @SerialName("procedure") PROCEDURE("procedure"),
}

/** MemoryEntry and MemoryHit in one shape: [score] is set for search hits. */
@Serializable
data class MemoryEntry(
    val id: String,
    val scope: MemoryScope = MemoryScope.GLOBAL,
    val scopeKey: String? = null,
    val kind: MemoryKind = MemoryKind.FACT,
    val content: String = "",
    val tags: List<String> = emptyList(),
    val sourceSessionId: String? = null,
    val importance: Double = 0.0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val lastUsedAt: Long? = null,
    val useCount: Long = 0,
    val score: Double? = null,
)

// ---------------------------------------------------------------------------
// Usage, limits
// ---------------------------------------------------------------------------

@Serializable
data class UsageRecord(
    val id: String,
    val ts: Long = 0,
    val sessionId: String? = null,
    val source: String = "",
    val provider: String = "",
    val model: String = "",
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val reasoningTokens: Long = 0,
    /** What was billed: 0 for a signed in plan. */
    val costUsd: Double = 0.0,
    /** The same tokens at the model's API prices; equal to [costUsd] for an API key. */
    val apiValueUsd: Double? = null,
    /** [apiValueUsd] was priced on read: the row is from before the hub kept it. */
    val apiValueEstimated: Boolean = false,
    val latencyMs: Long? = null,
    val purpose: String? = null,
    /** The account (models.accounts id) that served it. */
    val account: String? = null,
)

@Serializable
data class LimitWindow(
    /** e.g. "5h", "7d", "requests-per-minute", "tokens". */
    val name: String = "",
    /** 0..100 */
    val usedPercent: Double? = null,
    val remaining: Double? = null,
    val limit: Double? = null,
    val resetsAt: Long? = null,
)

@Serializable
data class LimitState(
    val provider: String,
    /** The account (models.accounts id) these windows belong to; a provider has one state per account. */
    val account: String? = null,
    val label: String = "",
    val windows: List<LimitWindow> = emptyList(),
    val updatedAt: Long = 0,
    val blocked: Boolean? = null,
    /** headers, oauth, logs, api, ledger or error */
    val source: String = "api",
    /** A plan whose window starter is on: what it is doing (logic/StarterWords.kt). */
    val starter: StarterLine? = null,
) {
    /** Where the hub keeps this state: provider, or provider:account (core accounts/windows.ts limitKey). */
    val key: String get() = if (account.isNullOrEmpty()) provider else "$provider:$account"
}

/**
 * A plan's window starter, as the hub's limit state carries it: right after
 * the 5-hour window resets, one tiny request starts the next. Read only here;
 * it is turned on in the web app's Settings > Models > Accounts.
 */
@Serializable
data class StarterLine(
    /** scheduled, checking, stopped, paused, waiting, never or setup */
    val state: String = "",
    val nextAt: Long? = null,
    val startedAt: Long? = null,
    val until: Long? = null,
    /** Why it waits, stopped or retries: "429", "Sign-in failed". */
    val reason: String? = null,
)

// ---------------------------------------------------------------------------
// Permissions and questions
// ---------------------------------------------------------------------------

/**
 * Who asks, when a subagent or a workflow agent asks (the hub's AskFrom):
 * the line above its card in the chat the owner is in (logic/Asks.kt).
 */
@Serializable
data class AskFrom(
    /** The session that asks. */
    val sessionId: String = "",
    /** Its agent, "email". */
    val agent: String = "",
    /** The subagent's description, or the workflow agent's label. */
    val label: String = "",
    /** Set when a workflow agent asks. */
    val workflow: AskWorkflow? = null,
    /** The sessions under the top one, down to the one that asks (the asker last). */
    val chain: List<String> = emptyList(),
)

@Serializable
data class AskWorkflow(
    val runId: String = "",
    /** The workflow's name, "deep-research". */
    val name: String = "",
)

/** What an approval and a question share about where they show (logic/Asks.kt). */
interface Ask {
    /** The session that asks: answering resolves it there. */
    val sessionId: String
    /** Its top session through subagents and workflow runs, the chat the owner is in. Null from an older hub. */
    val rootSessionId: String?
    /** Set when a subagent or a workflow agent asks. */
    val from: AskFrom?
}

@Serializable
data class ApprovalRequest(
    val id: String,
    override val sessionId: String = "",
    val toolUseId: String = "",
    val tool: String = "",
    val input: JsonObject = JsonObject(emptyMap()),
    /** Human readable one-liner, e.g. "Run: rm -rf build". */
    val summary: String = "",
    /** Suggested rule for "always allow", e.g. "Bash(npm test:*)". */
    val suggestedRule: String? = null,
    val createdAt: Long = 0,
    val harness: String? = null,
    /** Do not offer "always" or "for this chat": the hub counts such an answer as once (an untrusted session, a push). */
    val noAlways: Boolean = false,
    override val rootSessionId: String? = null,
    override val from: AskFrom? = null,
) : Ask

/**
 * { decision: 'allow', scope?, rule? } | { decision: 'deny', message? }
 * Null fields are not sent.
 */
@Serializable
data class ApprovalResponse(
    val decision: String,
    val scope: String? = null,
    val rule: String? = null,
    val message: String? = null,
) {
    companion object {
        fun allowOnce() = ApprovalResponse(decision = "allow", scope = "once")
        fun allowSession() = ApprovalResponse(decision = "allow", scope = "session")
        fun allowAlways(rule: String?) = ApprovalResponse(decision = "allow", scope = "always", rule = rule)
        fun deny(message: String? = null) = ApprovalResponse(decision = "deny", message = message)
    }
}

@Serializable
data class QuestionOption(
    val label: String,
    val description: String? = null,
)

@Serializable
data class Question(
    val question: String,
    val header: String? = null,
    val multiSelect: Boolean = false,
    val options: List<QuestionOption> = emptyList(),
)

@Serializable
data class QuestionRequest(
    val id: String,
    override val sessionId: String = "",
    val questions: List<Question> = emptyList(),
    val createdAt: Long = 0,
    override val rootSessionId: String? = null,
    override val from: AskFrom? = null,
) : Ask

@Serializable
data class Checkpoint(
    val id: String,
    val sessionId: String = "",
    val seq: Long = 0,
    val commit: String = "",
    val files: Int = 0,
    val createdAt: Long = 0,
)

@Serializable
enum class TodoStatus {
    @SerialName("pending") PENDING,
    @SerialName("in_progress") IN_PROGRESS,
    @SerialName("completed") COMPLETED,
}

@Serializable
data class Todo(
    val content: String,
    val activeForm: String? = null,
    val status: TodoStatus = TodoStatus.PENDING,
)

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

@Serializable
data class Notice(
    val id: String = "",
    val title: String = "",
    val body: String = "",
    /** info, success, warning or error */
    val level: String = "info",
    val sessionId: String? = null,
    /** Deep link path inside the app, e.g. "/s/<id>". */
    val link: String? = null,
    /** Approval id so phone notifications can approve directly. */
    val approvalId: String? = null,
    val createdAt: Long = 0,
    /**
     * True when the notice passed the owner's rules (Settings, Notifications)
     * and was not held because someone is using Conclave. Only these become
     * system notifications; the rest are for open apps.
     */
    val alert: Boolean = false,
)

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

@Serializable
data class MachineInfo(
    val hostname: String = "",
    val platform: String = "",
    val arch: String = "",
    val home: String = "",
    val shell: String = "",
    /** Versions of useful CLIs found on PATH. */
    val clis: Map<String, String> = emptyMap(),
    val capabilities: List<String> = emptyList(),
)

@Serializable
data class Device(
    val id: String,
    val name: String = "",
    val online: Boolean = false,
    val lastSeenAt: Long? = null,
    val info: MachineInfo? = null,
    val roots: List<String> = emptyList(),
    val createdAt: Long = 0,
)

@Serializable
data class AuditEntry(
    val id: String,
    val ts: Long = 0,
    val sessionId: String? = null,
    val device: String? = null,
    val actor: String = "",
    val action: String = "",
    val detail: String = "",
)
