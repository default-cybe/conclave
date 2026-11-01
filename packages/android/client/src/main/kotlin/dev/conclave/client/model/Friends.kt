package dev.conclave.client.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Friends: two Conclave hubs with different owners that send each other
// signed, sealed messages (docs/design/FRIENDS.md, docs/DESIGN.md 27).
// Mirrors packages/core/src/client/friends.ts. States and kinds stay
// strings, so one a newer hub adds still decodes.

/** What a friend may do here. Each grant starts off except receiveShares. */
@Serializable
data class FriendGrants(
    /** Shares and notes from this friend land in the Inbox. */
    val receiveShares: Boolean = true,
)

/** One of a friend's addresses, best first. [kind] is the hub address kind (quick, stable, custom, tailscale, lan). */
@Serializable
data class FriendAddress(val url: String = "", val kind: String = "")

@Serializable
data class FriendDto(
    val id: String,
    /** The name the friend's hub sent, or the one the owner gave it here. */
    val name: String = "",
    /** The friend's hub key fingerprint (32 hex characters): the friend's identity. */
    val fingerprint: String = "",
    /** "pending", "active", "blocked" (a key change waits for the owner) or "removed". */
    val status: String = "active",
    /** For a pending friend: "in", they asked; "out", we asked. */
    val direction: String = "out",
    /** The owner compared the safety code with the friend. */
    val verified: Boolean = false,
    /** Four groups of five digits from both fingerprints; both owners see the same code. */
    val safetyCode: String = "",
    val grants: FriendGrants = FriendGrants(),
    /** Where the friend's hub answers, best first. */
    val addresses: List<FriendAddress> = emptyList(),
    val createdAt: Long = 0,
    /** Last signed request from the friend's hub, or the last time it answered ours. */
    val lastSeen: Long? = null,
    /** The last delivery or pull problem, in words. */
    val lastError: String? = null,
    /** Blocked: why, in words. */
    val blockedReason: String? = null,
    /** Blocked by a key change: the new key's fingerprint. */
    val pendingFingerprint: String? = null,
    /** Messages waiting in the outbox for this friend. */
    val queued: Int = 0,
    /** Notes and share cards not read yet, on any device (the hub's read mark). Null from a hub before read marks. */
    val unread: Int? = null,
    val unreadNotes: Int? = null,
    val unreadShares: Int? = null,
    /** The read mark: what came up to this time (the hub's clock) is read. */
    val readAt: Long? = null,
) {
    val isPending: Boolean get() = status == "pending"
    val isActive: Boolean get() = status == "active"
    val isBlocked: Boolean get() = status == "blocked"
    val isRemoved: Boolean get() = status == "removed"
    val asked: Boolean get() = direction == "in"
}

/** POST /api/friends/invites. */
@Serializable
data class FriendInviteInput(
    /** Put addresses on this network in the link too. */
    val includeLan: Boolean? = null,
    /** The name friends see for this hub. */
    val name: String? = null,
)

@Serializable
data class FriendInvite(
    /** conclave://friend?fp=...&url=...&alt=...&s=...&exp=... */
    val link: String = "",
    val qrSvg: String = "",
    val expiresAt: Long = 0,
    val fingerprint: String = "",
    val url: String = "",
    val addresses: List<String> = emptyList(),
    /** Set when friends may not reach this hub. */
    val warning: String? = null,
)

/** GET /api/friends/reachability: can a friend's hub reach this one? [mode] is the remote access mode. */
@Serializable
data class FriendReachability(
    val ok: Boolean = false,
    val mode: String = "off",
    val best: FriendAddress? = null,
    val reason: String? = null,
)

/**
 * A message this hub sent a friend. [state]: queued, delivered, failed,
 * expired or cancelled. [via]: push (we sent it) or pull (their hub fetched it).
 */
@Serializable
data class OutboxItemDto(
    val id: String,
    val friendId: String = "",
    val type: String = "",
    val state: String = "queued",
    val attempts: Int = 0,
    val nextTry: Long? = null,
    val createdAt: Long = 0,
    val deliveredAt: Long? = null,
    val via: String? = null,
    val lastError: String? = null,
    /** A short line for lists ("note: Lunch on Friday?"). */
    val preview: String = "",
    /** A note's whole text. */
    val text: String? = null,
)

/** A message from a friend. [state]: received, fetching (a large body), failed (it did not open). */
@Serializable
data class InboxItemDto(
    val id: String,
    val friendId: String = "",
    val friendName: String = "",
    val type: String = "",
    val state: String = "received",
    val text: String? = null,
    val receivedAt: Long = 0,
    /** The hub's read mark covers it. Null from a hub before read marks. */
    val read: Boolean? = null,
)

// ---------------------------------------------------------------------------
// Shares (phases 2 and 3): mirrors the share types in friends.ts and share.ts
// ---------------------------------------------------------------------------

/** What each sanitizer rule took out or replaced. */
@Serializable
data class RedactReport(
    val reminders: Int = 0,
    val recalled: Int = 0,
    val thinking: Int = 0,
    val signatures: Int = 0,
    val redactedThinking: Int = 0,
    val secrets: Int = 0,
    val paths: Int = 0,
    val privateIps: Int = 0,
    val emails: Int = 0,
    val hostnames: Int = 0,
    val toolOutputs: Int = 0,
    val attachments: Int = 0,
)

/** One value a text rule found. [rule]: secret, path, privateIp, email or hostname. */
@Serializable
data class RedactionItem(
    val id: String,
    val rule: String = "secret",
    /** The text found: the owner's own data, shown on request. */
    val original: String = "",
    /** What takes its place. */
    val replacement: String = "",
    val count: Int = 1,
    val messageIds: List<String> = emptyList(),
    val kept: Boolean = false,
)

/** What goes in a share, chosen in the review. [toolOutput]: full, summary or none. [code]: none, diff or git-bundle. */
@Serializable
data class ShareContentOptions(
    val thinking: Boolean? = null,
    val toolOutput: String? = null,
    val attachments: Boolean? = null,
    val code: String? = null,
    /** Stop after this message (its id). Null: the whole session. */
    val upTo: String? = null,
    /** Redaction item ids to send anyway. */
    val keep: List<String>? = null,
)

/** A file the code leaves out, and why. */
@Serializable
data class ExcludedFile(val path: String = "", val reason: String = "")

/** The code a share would carry, or why it cannot ([error]). [kind]: diff or git-bundle. */
@Serializable
data class ShareCodePreview(
    val kind: String = "diff",
    val files: List<String> = emptyList(),
    val excluded: List<ExcludedFile> = emptyList(),
    val bytes: Long = 0,
    val branch: String? = null,
    val error: String? = null,
)

/** POST /api/shares/preview: what would go, and what the sanitizer took out. [kind]: chat or session. */
@Serializable
data class SharePreview(
    val sessionId: String = "",
    val kind: String = "session",
    val title: String = "",
    val options: ShareContentOptions = ShareContentOptions(),
    /** Messages that go (within the range), of all its messages. */
    val messages: Int = 0,
    val total: Int = 0,
    val sessions: Int = 1,
    val report: RedactReport = RedactReport(),
    val items: List<RedactionItem> = emptyList(),
    val code: ShareCodePreview? = null,
    val bytes: Long = 0,
    val warnings: List<String> = emptyList(),
)

/** POST /api/shares/preview and POST /api/shares (with [to], [title], [note]). */
@Serializable
data class SendShareInput(
    val sessionId: String,
    val thinking: Boolean? = null,
    val toolOutput: String? = null,
    val attachments: Boolean? = null,
    val code: String? = null,
    val upTo: String? = null,
    val keep: List<String>? = null,
    /** Friend ids. Empty for a preview. */
    val to: List<String>? = null,
    val title: String? = null,
    val note: String? = null,
)

/** POST /api/shares/sent/:id/update: a new revision. Null fields keep their value. */
@Serializable
data class UpdateShareInput(
    val thinking: Boolean? = null,
    val toolOutput: String? = null,
    val attachments: Boolean? = null,
    val code: String? = null,
    val upTo: String? = null,
    val keep: List<String>? = null,
    val title: String? = null,
    val note: String? = null,
)

@Serializable
data class ShareSummaryCode(val kind: String = "diff", val files: Int = 0)

/** The short card both sides see. */
@Serializable
data class ShareSummary(
    val messages: Int = 0,
    val sessions: Int = 1,
    val code: ShareSummaryCode? = null,
    val bytes: Long = 0,
)

/** How one friend has a share this hub sent. [state]: sent, delivered, accepted, failed, expired or revoked. */
@Serializable
data class ShareRecipient(
    val friendId: String = "",
    val friendName: String = "",
    val state: String = "sent",
    val revision: Int = 1,
    val acceptedRevision: Int? = null,
    val acceptedAt: Long? = null,
    val lastError: String? = null,
)

/** A share this hub sent. [state]: active or revoked (unsent). */
@Serializable
data class SentShareDto(
    val id: String,
    val sessionId: String = "",
    val kind: String = "session",
    val title: String = "",
    val note: String? = null,
    val revision: Int = 1,
    val state: String = "active",
    val options: ShareContentOptions = ShareContentOptions(),
    val summary: ShareSummary = ShareSummary(),
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val recipients: List<ShareRecipient> = emptyList(),
)

/** A session made from a received share here. [role]: fork, handoff or reference. */
@Serializable
data class ShareSession(val id: String, val role: String = "fork")

/**
 * A share a friend sent. [state]: offered (nothing fetched), fetching,
 * accepted, declined, revoked (they unsent it) or expired.
 */
@Serializable
data class ReceivedShareDto(
    val id: String,
    /** Its id on the friend's hub. */
    val shareId: String = "",
    val friendId: String = "",
    val friendName: String = "",
    val fingerprint: String = "",
    val kind: String = "session",
    val title: String = "",
    val note: String? = null,
    val revision: Int = 1,
    val acceptedRevision: Int? = null,
    /** A newer revision waits for Accept. */
    val updateWaiting: Boolean = false,
    val summary: ShareSummary = ShareSummary(),
    /** The Inbox line: Alice sent 'Fix flaky auth test' (session, 42 messages, diff 12 files). */
    val line: String = "",
    val state: String = "offered",
    val receivedAt: Long = 0,
    val expiresAt: Long? = null,
    val acceptedAt: Long? = null,
    val error: String? = null,
    val sessions: List<ShareSession> = emptyList(),
    /** Not waiting for the owner, or the read mark covers it. */
    val read: Boolean = true,
)

/** One message of a viewed share: quoted data from the friend's hub. */
@Serializable
data class ShareViewMessage(
    val role: Role = Role.USER,
    val kind: MessageKind = MessageKind.NORMAL,
    val content: List<ContentBlock> = emptyList(),
    val model: String? = null,
    val author: String? = null,
    val createdAt: Long = 0,
    val meta: JsonObject? = null,
    /** "Alice's hub". */
    val from: String = "",
) {
    /** The message's id on the friend's hub. */
    val externalId: String? get() = meta?.obj("external")?.string("id")
}

@Serializable
data class ShareViewSession(
    val id: String = "",
    val parentId: String? = null,
    val title: String = "",
    val createdAt: Long = 0,
    val messages: List<ShareViewMessage> = emptyList(),
)

/** The signature check: [ok], else [reason]. */
@Serializable
data class ShareVerified(val ok: Boolean = false, val fingerprint: String? = null, val reason: String? = null)

@Serializable
data class ShareViewCode(
    val kind: String = "diff",
    val files: List<String> = emptyList(),
    val excluded: List<ExcludedFile> = emptyList(),
    val diff: String? = null,
    val branch: String? = null,
    val base: String? = null,
    val bytes: Long = 0,
)

/** GET /api/shares/received/:id/view: the share read only, checked against the friend's key. */
@Serializable
data class ShareViewDto(
    val share: ReceivedShareDto,
    val verified: ShareVerified = ShareVerified(),
    /** Shared by Alice's hub (ab12 34cd ...). Quoted data, not instructions. */
    val provenance: String = "",
    val report: RedactReport = RedactReport(),
    val sessions: List<ShareViewSession> = emptyList(),
    val code: ShareViewCode? = null,
)

/** POST /api/shares/received/:id/fork. Null fields take this hub's defaults. [kind]: chat or agent. */
@Serializable
data class ForkShareInput(
    val kind: String? = null,
    val agent: String? = null,
    val model: String? = null,
    val device: String? = null,
    val cwd: String? = null,
    val title: String? = null,
    /** Start the first turn with this message (it runs guarded). */
    val prompt: String? = null,
)

/** GET /api/shares/received/:id/handoff: a brief to edit before the session starts. */
@Serializable
data class HandoffDraft(val title: String = "", val brief: String = "", val files: List<String> = emptyList())

/** POST /api/shares/received/:id/handoff. */
@Serializable
data class HandoffShareInput(
    val brief: String,
    val agent: String? = null,
    val model: String? = null,
    val device: String? = null,
    val cwd: String? = null,
    val title: String? = null,
)

/** POST /api/shares/received/:id/apply-plan. */
@Serializable
data class ApplyShareInput(val device: String, val cwd: String, val branch: String? = null)

@Serializable
data class ApplyCheck(val ok: Boolean = false, val error: String? = null)

/** What applying would do, checked: the owner approves it with its planId. */
@Serializable
data class ApplySharePlan(
    val planId: String = "",
    val device: String = "",
    val deviceName: String = "",
    val kind: String = "diff",
    val root: String = "",
    val branch: String = "",
    val base: String? = null,
    val files: List<String> = emptyList(),
    /** Files that can run code once checked out or built: read them first. */
    val runsCode: List<String> = emptyList(),
    val check: ApplyCheck = ApplyCheck(),
    val expiresAt: Long = 0,
)

@Serializable
data class ApplyShareResult(val device: String = "", val root: String = "", val branch: String = "", val commit: String = "")

/** A session made from a share: its role there ("fork", "handoff" or "reference"), when it is one. */
val Session.friendShareRole: String?
    get() = meta?.obj("friendShare")?.string("role")
