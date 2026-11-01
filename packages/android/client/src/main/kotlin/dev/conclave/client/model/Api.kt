package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Request and response shapes from packages/core/src/client/index.ts,
// plus ModelInfo (providers/types.ts) and AgentDef & co (extensions/types.ts).

@Serializable
data class ModelInfo(
    /** Provider-local id, e.g. "claude-sonnet-5-5". */
    val id: String,
    /** Full ref "provider/id". */
    val ref: String = "",
    val provider: String = "",
    val name: String = "",
    val contextWindow: Long = 0,
    val maxOutput: Long = 0,
    val vision: Boolean = false,
    val tools: Boolean = false,
    val thinking: Boolean = false,
    /** explicit, automatic or none */
    val caching: String = "none",
    val inputPrice: Double = 0.0,
    val outputPrice: Double = 0.0,
    val cacheReadPrice: Double = 0.0,
    val cacheWritePrice: Double = 0.0,
    /** A 1 hour cache write on Claude models (2x input); null elsewhere. */
    val cacheWrite1hPrice: Double? = null,
    /** fast, smart or deep */
    val tier: String? = null,
    /** The Effort levels it offers; null when it has no Effort control. */
    val effort: ModelEffort? = null,
    /** The ref pickers show instead: the same model on the owner's first route (core providers/merge.ts). */
    val sameAs: String? = null,
    /** On the entry pickers show: the route in words, "your Claude plan, then API key". */
    val via: String? = null,
    /** On the entry pickers show: every ref that names this model, its own first. */
    val refs: List<String>? = null,
    /** On the entry pickers show: the other refs that name a route of their own (a plan's prefix, a provider outside the order). */
    val choices: List<String>? = null,
    /** The vendor of a model whose id no name places: the vendor of the plan that lists it. */
    val vendor: String? = null,
    /** Cyber access programs a ChatGPT plan model takes (core providers/access-programs.ts). */
    val cyber: List<String>? = null,
) {
    val fullRef: String get() = ref.ifBlank { if (provider.isBlank()) id else "$provider/$id" }
}

/** What a model offers for Effort (providers/effort.ts ModelEffort): its levels lowest first, whether Off exists, its default. */
@Serializable
data class ModelEffort(
    val levels: List<String> = emptyList(),
    val off: Boolean = false,
    @SerialName("default") val defaultLevel: String? = null,
)

@Serializable
data class ModelGroup(
    val provider: String,
    val name: String = "",
    val type: String = "",
    val configured: Boolean = false,
    val enabled: Boolean = false,
    val models: List<ModelInfo> = emptyList(),
    val error: String? = null,
)

@Serializable
data class AgentDef(
    val name: String,
    val description: String = "",
    /** System prompt body. */
    val prompt: String = "",
    val model: String? = null,
    val tools: List<String>? = null,
    val disallowedTools: List<String>? = null,
    val mode: SessionMode? = null,
    val permissionMode: PermissionMode? = null,
    val color: String? = null,
    val icon: String? = null,
    val skills: List<String>? = null,
    val mcpServers: List<String>? = null,
    /** global, agent or none */
    val memory: String? = null,
    val subagent: Boolean? = null,
    val primary: Boolean? = null,
    val untrusted: Boolean? = null,
    val device: String? = null,
    val temperature: Double? = null,
    /** Effort: off, low, medium, high, xhigh or max */
    val thinking: String? = null,
    val jury: JsonObject? = null,
    /** builtin, user, project, plugin or claude */
    val source: String = "user",
    val path: String? = null,
    val plugin: String? = null,
)

@Serializable
data class SkillDef(
    val name: String,
    val description: String = "",
    val dir: String = "",
    val path: String = "",
    val allowedTools: List<String>? = null,
    val source: String = "user",
    val plugin: String? = null,
)

@Serializable
data class CommandDef(
    val name: String,
    val description: String? = null,
    val argumentHint: String? = null,
    val allowedTools: List<String>? = null,
    val model: String? = null,
    val agent: String? = null,
    val body: String = "",
    val source: String = "user",
    val path: String? = null,
    val plugin: String? = null,
)

@Serializable
data class ToolInfo(
    val name: String,
    val description: String = "",
    val readOnly: Boolean = false,
    /** builtin or mcp */
    val source: String = "builtin",
    val server: String? = null,
)

@Serializable
data class McpStatus(
    val name: String,
    /** connected, connecting, failed or disabled */
    val status: String = "disabled",
    val tools: Int = 0,
    val error: String? = null,
    val source: String = "",
)

@Serializable
data class UsageBucket(
    val key: String = "",
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    /** What was billed: 0 for calls a signed in plan served. */
    val costUsd: Double = 0.0,
    /** The same tokens at the models' API prices; null from a hub before it was kept. */
    val apiValueUsd: Double? = null,
    /** The part of [apiValueUsd] priced on read for rows from before it was kept. */
    val estimatedUsd: Double? = null,
    val calls: Long = 0,
)

@Serializable
data class UsageSummary(
    val from: Long = 0,
    val to: Long = 0,
    val totals: UsageBucket = UsageBucket(),
    val byDay: List<UsageBucket> = emptyList(),
    val byModel: List<UsageBucket> = emptyList(),
    val bySource: List<UsageBucket> = emptyList(),
    val byPurpose: List<UsageBucket> = emptyList(),
    /** By account (models.accounts id); "" for calls no account served. */
    val byAccount: List<UsageBucket> = emptyList(),
    /** Fraction of input tokens served from cache. */
    val cacheHitRate: Double = 0.0,
    /** USD saved by cache reads vs full price. */
    val cacheSavingsUsd: Double = 0.0,
    /** What signed in plans saved in the range: the API value of their calls less what they billed. */
    val savedUsd: Double? = null,
)

@Serializable
data class GatewayKey(
    val id: String,
    val name: String = "",
    val prefix: String = "",
    val device: String? = null,
    val agent: String? = null,
    val createdAt: Long = 0,
    val lastUsedAt: Long? = null,
    val revoked: Boolean = false,
    /** Only set once, right after creation. */
    val key: String? = null,
)

@Serializable
data class HubInfo(
    val name: String = "",
    val version: String = "",
    val startedAt: Long = 0,
    val devices: Int = 0,
    val publicUrl: String? = null,
    val defaultModel: String = "",
    val features: List<String> = emptyList(),
    /** The hub's identity fingerprint (docs/design/HUB-LOGIN-AND-IDENTITY.md), shown to compare with a phone. */
    val fingerprint: String? = null,
)

/** The hub's Ed25519 public key (base64url, 32 raw bytes) and its fingerprint (first 16 bytes of SHA-256, hex). */
@Serializable
data class HubIdentity(val publicKey: String, val fingerprint: String = "")

/** GET /api/identity: the key, and its signature of `conclave-hub-identity-v1\n<nonce>`. */
@Serializable
data class IdentityProof(val publicKey: String, val fingerprint: String = "", val signature: String)

/** GET /api/auth/password (owner only). */
@Serializable
data class PasswordStatus(val set: Boolean = false, val setAt: Long? = null)

@Serializable
data class PairingInfo(
    val code: String,
    /** The best address for this hub (RemoteStatus.addresses). */
    val url: String = "",
    /** conclave://pair?url=...&code=...&fp=...&alt=...: each alt is another address, best first. */
    val deepLink: String = "",
    val qrSvg: String = "",
    val expiresAt: Long = 0,
    /** Every address in the deep link, [url] first. */
    val addresses: List<String> = emptyList(),
    /** The hub's identity fingerprint, the fp in [deepLink]. Null from hubs older than identity. */
    val fingerprint: String? = null,
)

/**
 * GET /api/clients and the app.updated event: an app paired with a code or
 * a password (a phone, the desktop app, a browser, the CLI). Phones are
 * apps, not devices. The list is the caller's own account's.
 */
@Serializable
data class AppDto(
    val id: String,
    /** The name the app paired as ("Pixel 8", "Safari on iOS"). */
    val name: String = "",
    /** android, ios, web, desktop, or the CLI's OS. */
    val platform: String? = null,
    val createdAt: Long = 0,
    val lastSeenAt: Long? = null,
    val revoked: Boolean = false,
    val accountId: String = "",
    /** It has a live connection to the hub now. */
    val online: Boolean = false,
)

/** GET /api/health. Needs no token: the app asks it to find out which address answers. */
@Serializable
data class HealthInfo(
    val ok: Boolean = false,
    val version: String = "",
    val uptimeMs: Long = 0,
    /** More than one person on this hub: the password login asks for a name (docs/design/ACCOUNTS.md). */
    val people: Boolean = false,
)

// ----- remote access (Settings, Remote access) -----

/** How phones reach the hub from outside its network. */
@Serializable
enum class RemoteMode(val wire: String) {
    @SerialName("off") OFF("off"),
    @SerialName("quick") QUICK("quick"),
    @SerialName("stable") STABLE("stable"),
    @SerialName("tailscale") TAILSCALE("tailscale"),
    @SerialName("custom") CUSTOM("custom"),
}

@Serializable
enum class RemoteState {
    @SerialName("off") OFF,
    @SerialName("installing") INSTALLING,
    @SerialName("starting") STARTING,
    @SerialName("on") ON,
    @SerialName("error") ERROR,
}

/** One way to reach the hub. Named RemoteAddress so it does not clash with logic.HubAddress. */
@Serializable
data class RemoteAddress(
    val url: String,
    /** stable or quick: a Cloudflare tunnel. own: the hub's public URL. lan: the same network. */
    val kind: String = "lan",
    /** "Wi-Fi 192.168.1.20", "Cloudflare tunnel". */
    val label: String = "",
)

@Serializable
data class RemoteLan(
    /** The owner lets devices on this network connect. */
    val on: Boolean = true,
    /** The hub listens on every interface. */
    val listening: Boolean = false,
    /** Set when --host or server.host pins the address the hub listens on. */
    val fixedHost: String? = null,
)

@Serializable
data class StableTunnel(val hostname: String = "", val zone: String = "")

@Serializable
data class CloudflaredInfo(val path: String = "", val version: String? = null, val managed: Boolean = false, val verified: Boolean? = null)

/** GET /api/remote and the remote.updated event. */
@Serializable
data class RemoteStatus(
    val mode: RemoteMode = RemoteMode.OFF,
    val state: RemoteState = RemoteState.OFF,
    /** The outside address while it works. */
    val url: String? = null,
    /** Every address that reaches the hub, best first. */
    val addresses: List<RemoteAddress> = emptyList(),
    /** The tunnel address before the last change. An app still using it moves to [url]. */
    val previousUrl: String? = null,
    val since: Long = 0,
    val detail: String? = null,
    val error: String? = null,
    val lan: RemoteLan = RemoteLan(),
    val stable: StableTunnel? = null,
    val cloudflareToken: Boolean = false,
    val cloudflared: CloudflaredInfo? = null,
    /** DELETE /api/remote/stable only: what Cloudflare could not remove. */
    val warning: String? = null,
)

/** A Cloudflare zone the saved API token can edit. */
@Serializable
data class CloudflareZone(val id: String, val name: String = "", val accountId: String = "", val accountName: String? = null)

@Serializable
data class CloudflareZones(val zones: List<CloudflareZone> = emptyList())

/** GET /api/remote/tailscale. */
@Serializable
data class TailscaleInfo(
    val installed: Boolean = false,
    val running: Boolean = false,
    val dnsName: String? = null,
    val url: String? = null,
    val command: String = "",
)

@Serializable
data class FileEntry(
    val name: String,
    val path: String = "",
    /** file, dir, symlink or other */
    val type: String = "file",
    val size: Long? = null,
)

@Serializable
data class SearchHit(
    val sessionId: String,
    val messageId: String = "",
    val snippet: String = "",
    val title: String = "",
)

@Serializable
data class MemoryStats(
    val total: Long = 0,
    val byKind: Map<String, Long> = emptyMap(),
    val external: String? = null,
)

/**
 * The memory map (GET /api/memory/graph, owner only, core memory-graph.ts):
 * every item once, links as [from, to, label] indexes into [nodes] and
 * [labels]. Kinds and sources stay strings so a new one never breaks the read.
 */
@Serializable
data class MemoryGraph(
    val nodes: List<MemoryGraphNode> = emptyList(),
    val edges: List<List<Int>> = emptyList(),
    val labels: List<String> = emptyList(),
    val basicMemory: MemoryGraphStore = MemoryGraphStore(),
)

@Serializable
data class MemoryGraphNode(
    val id: String,
    /** fact, profile, procedure, episode, note, tag or session. */
    val kind: String = "note",
    /** conclave, basic-memory or both. */
    val source: String = "conclave",
    val title: String = "",
    val memoryId: String? = null,
    val sessionId: String? = null,
    val folder: String? = null,
    val area: String = "",
    val at: Long? = null,
    val degree: Int = 0,
)

/** none, ok or offline. */
@Serializable
data class MemoryGraphStore(val state: String = "none", val name: String? = null, val error: String? = null)

@Serializable
data class NotifyChannel(val id: String, val enabled: Boolean = false)

@Serializable
data class ProviderTestResult(val ok: Boolean = false, val detail: String = "", val latencyMs: Long? = null)

/** What a send did. [queued]: the session was busy and the message waits; session.queue lists it under [pendingId]. */
@Serializable
data class SendResult(val queued: Boolean = false, val messageId: String? = null, val pendingId: String? = null)

@Serializable
data class CommandResult(val ok: Boolean = true, val output: String? = null)

@Serializable
data class DiffResult(val diff: String = "", val files: List<String> = emptyList())

@Serializable
data class ExportResult(val content: String = "", val filename: String = "")

@Serializable
data class FileContent(val content: String = "", val truncated: Boolean = false)

@Serializable
data class SchedulePreview(val next: List<Long> = emptyList(), val error: String? = null)

@Serializable
data class SyncResult(val ok: Boolean = true, val written: List<String> = emptyList())

@Serializable
data class ConfigResponse(
    val config: JsonObject = JsonObject(emptyMap()),
    val user: JsonObject = JsonObject(emptyMap()),
    val secrets: JsonElement? = null,
)

// ----- inputs -----

@Serializable
data class PairRequest(val code: String, val name: String, val platform: String)

/**
 * POST /api/login: the hub's password, the backup to a pairing code. [account]
 * is the person's name on a hub with several people; left out, the owner's.
 */
@Serializable
data class LoginRequest(val password: String, val name: String, val platform: String, val account: String? = null)

/** POST /api/pair and POST /api/login. */
@Serializable
data class PairResponse(
    val token: String,
    val clientId: String = "",
    val hub: HubInfo = HubInfo(),
    /** Every way to reach the hub, best first. */
    val addresses: List<String> = emptyList(),
    /** Keep it with the token: every later connection checks that the hub holds this key. Absent from older hubs. */
    val identity: HubIdentity? = null,
    /** Whose token this is (docs/design/ACCOUNTS.md). Absent from hubs older than accounts: the owner's. */
    val account: AccountRef? = null,
)

@Serializable
data class CreateSessionInput(
    val agent: String? = null,
    val model: String? = null,
    val mode: SessionMode? = null,
    val permissionMode: PermissionMode? = null,
    val cwd: String? = null,
    val device: String? = null,
    val title: String? = null,
    val taskId: String? = null,
    val parentId: String? = null,
    val tags: List<String>? = null,
    val modeConfig: ModeConfig? = null,
    /** Send this as the first message right away. */
    val prompt: String? = null,
    /** CHAT makes a plain chat: the chat agent, the hub as device, and the switches in [chat] (a missing one is on). */
    val kind: SessionKind? = null,
    val chat: ChatSettingsPatch? = null,
)

@Serializable
data class SessionPatch(
    val title: String? = null,
    val tags: List<String>? = null,
    val pinned: Boolean? = null,
    val archived: Boolean? = null,
    val agent: String? = null,
    val model: String? = null,
    val mode: SessionMode? = null,
    val permissionMode: PermissionMode? = null,
    val cwd: String? = null,
    val device: String? = null,
    val taskId: String? = null,
    val modeConfig: ModeConfig? = null,
    /** AGENT moves a chat to Sessions (Continue as a session); send agent, device and cwd with it. */
    val kind: SessionKind? = null,
    /** Change some of a chat's switches; the others keep their value. */
    val chat: ChatSettingsPatch? = null,
    /** Ultra on or off. The hub refuses it on chats. */
    val ultra: Boolean? = null,
)

/**
 * Some of a chat's switches. Null fields are left out of the request.
 * [agentThinking] sends `"thinking": null`, which goes back to the agent's setting.
 */
@Serializable
data class ChatSettingsPatch(
    val webSearch: Boolean? = null,
    val memory: Boolean? = null,
    val thinking: ThinkingLevel? = null,
    @Transient val agentThinking: Boolean = false,
    /** A Cyber access program; [defaultCyber] sends `"cyber": null` (back to Default: nothing sent). */
    val cyber: String? = null,
    @Transient val defaultCyber: Boolean = false,
)

@Serializable
data class Attachment(
    /** image/png, application/pdf, text/plain... */
    val mediaType: String,
    /** base64 data */
    val data: String? = null,
    /** Path on the session's device (read by the hub). */
    val path: String? = null,
    val name: String? = null,
)

@Serializable
data class SendInput(
    val text: String,
    val attachments: List<Attachment>? = null,
    val mode: SessionMode? = null,
    val model: String? = null,
    /** queue (default) or steer */
    val whenBusy: String? = null,
    /**
     * The id the message keeps while it waits (6 to 64 letters, digits, _ or -),
     * so the app shows it at once and matches the hub's session.queue to it.
     * The hub makes one when it is missing or taken.
     */
    val pendingId: String? = null,
    /** "drop": the sender chose to go without a file the hub could not read (the 409 named it). */
    val attachmentLoss: String? = null,
)

/**
 * A message sent while the session was busy, before it joins the transcript
 * (docs/design/CHAT-AND-MOTION.md 2.11). [whenBusy]: "queue" runs as its own
 * turn after the running one, "steer" joins the running turn at its next
 * step. The hub stores them: a restart keeps them, and Stop holds them
 * ([held]) until Send (sendQueued) or the x.
 */
@Serializable
data class QueuedMessage(
    val id: String,
    val text: String = "",
    /** What was attached, by name and type. The files stay on the hub. */
    val attachments: List<QueuedAttachment> = emptyList(),
    /** When it was sent. */
    val at: Long = 0,
    val whenBusy: String = "queue",
    /** Stop kept it: it waits until you send or remove it. */
    val held: Boolean = false,
)

@Serializable
data class BtwAnswer(val answer: String = "")

@Serializable
data class QueuedAttachment(val name: String? = null, val mediaType: String = "")

@Serializable
data class SecondOpinionInput(
    /** "provider/model" or "@agent". */
    val reviewer: String? = null,
    val messageId: String? = null,
    val instructions: String? = null,
    val includeDiff: Boolean? = null,
    /** Also send the conversation (a chat sends it by default). */
    val includeTranscript: Boolean? = null,
)

/** One way to switch, against staying (core modes/switch-math.ts). USD. */
@Serializable
data class SwitchMath(
    /** Tokens the new model reads on its first reply. */
    val tokens: Long = 0,
    /** That first reply's history, plus a summary when there is one. */
    val onceUsd: Double = 0.0,
    /** The same reply staying on the current model. */
    val stayUsd: Double = 0.0,
    val replyUsd: Double = 0.0,
    val stayReplyUsd: Double = 0.0,
    /** Replies until the switch has paid for itself: 0 at once, null never. */
    val paybackReplies: Int? = null,
    /** The summary model's part (a short handover only). */
    val summaryUsd: Double? = null,
)

/** GET /api/sessions/:id/switch-estimate?model=: what a switch costs before it happens. */
@Serializable
data class SwitchEstimate(
    val from: String = "",
    val to: String = "",
    /** Tokens of active context the new model would read. */
    val tokens: Long = 0,
    val threshold: Long = 0,
    val ttl: String? = null,
    /** With the whole history (the default). */
    val full: SwitchMath = SwitchMath(),
    /** With a short handover, when it is offered. */
    val brief: SwitchMath? = null,
    /** One second opinion from the target instead. */
    val askUsd: Double = 0.0,
    /** Show the price and the choices before switching. */
    val confirm: Boolean = false,
    /** The short handover saves enough to suggest it in a quiet line. */
    val suggestBrief: Boolean = false,
    val priced: Boolean = false,
)

/** POST /api/sessions/:id/next-model: the model "Try the next model" started, and its words ("Opus 5.5 (personal)"). */
@Serializable
data class NextModelResult(val model: String = "", val label: String = "")

@Serializable
data class TaskInput(
    val title: String? = null,
    val description: String? = null,
    val status: TaskStatus? = null,
    val priority: Int? = null,
    val agent: String? = null,
    val project: String? = null,
    val due: Long? = null,
    val labels: List<String>? = null,
)

@Serializable
data class StartTaskInput(
    val agent: String? = null,
    val model: String? = null,
    val device: String? = null,
    val cwd: String? = null,
)

@Serializable
data class RoutineInput(
    val name: String? = null,
    val schedule: String? = null,
    val prompt: String? = null,
    val agent: String? = null,
    val model: String? = null,
    val mode: SessionMode? = null,
    val cwd: String? = null,
    val device: String? = null,
    val timezone: String? = null,
    val enabled: Boolean? = null,
    val sessionPolicy: String? = null,
    val notify: String? = null,
)

@Serializable
data class MemoryInput(
    val content: String? = null,
    val kind: MemoryKind? = null,
    val scope: MemoryScope? = null,
    val scopeKey: String? = null,
    val tags: List<String>? = null,
    val importance: Double? = null,
)

@Serializable
data class DevicePatch(val name: String? = null, val roots: List<String>? = null)
