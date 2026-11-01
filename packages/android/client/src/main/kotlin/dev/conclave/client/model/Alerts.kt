package dev.conclave.client.model

import kotlinx.serialization.Serializable

// Alerts: mirrors packages/core/src/client/alerts.ts (docs/DESIGN.md 28).
// Two live chats editing one file, and a turn that stopped making progress.
// They wait in the Inbox next to approvals and questions. Kinds and reasons
// stay strings, so one a newer hub adds still decodes.

/** A session an alert names. */
@Serializable
data class AlertSessionRef(val id: String, val title: String = "")

@Serializable
data class AlertItem(
    val id: String,
    /** "fileConflict" or "stuck". */
    val kind: String = "",
    /** The session it is about: the one that wrote second, or the stuck one. */
    val sessionId: String = "",
    /** The hub's sentence, as of when it was raised. */
    val text: String = "",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    /** A conflict's two sessions, the one that wrote first first; a stuck turn's one session. */
    val sessions: List<AlertSessionRef> = emptyList(),
    /** fileConflict: the device, the absolute path, and the path as the Inbox shows it. */
    val device: String? = null,
    val path: String? = null,
    val file: String? = null,
    /** stuck: "idle" (no progress) or "loop" (the same failure several times in a row). */
    val reason: String? = null,
    /** idle: when the last progress came. loop: when the first failure came. */
    val since: Long? = null,
    /** idle: the threshold in force; Keep waiting doubles it. */
    val thresholdMs: Long? = null,
    /** loop: the tool, the failures in a row, and the error. */
    val tool: String? = null,
    val count: Int? = null,
    val error: String? = null,
) {
    val isConflict: Boolean get() = kind == "fileConflict"
    val isLoop: Boolean get() = kind == "stuck" && reason == "loop"
}

/** What the owner can do with an alert: Stop and Keep waiting for a stuck turn, Dismiss for a file conflict. */
enum class AlertAction(val wire: String, val label: String) {
    STOP("stop", "Stop"),
    WAIT("wait", "Keep waiting"),
    DISMISS("dismiss", "Dismiss"),
}
