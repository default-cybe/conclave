package dev.conclave.client.model

import kotlinx.serialization.Serializable

// Reflect's Learnings: mirrors packages/core/src/client/learnings.ts
// (GET /api/reflect/learnings, POST /api/reflect/learnings/:id/save and /skip).
// The phone saves to memory only; agent, project and skill files are saved on the web, where the diff shows.

@Serializable
data class LearningTargetOption(val target: String = "", val label: String = "", val ref: String? = null, val refused: String? = null)

@Serializable
data class Learning(
    val id: String = "",
    /** correction, preference, remember or positive */
    val kind: String = "",
    /** The memory text, a fact in third person. */
    val fact: String = "",
    val rule: String = "",
    /** What you typed. */
    val quote: String = "",
    val confidence: Double = 0.0,
    val count: Int = 1,
    val sessionId: String = "",
    val sessionTitle: String? = null,
    val status: String = "pending",
    val targets: List<LearningTargetOption> = emptyList(),
)

@Serializable
data class LearningsInfo(
    val items: List<Learning> = emptyList(),
    val pending: Int = 0,
    /** Messages that wait for the model check. */
    val queued: Int = 0,
)

/** POST .../save: the phone sends memory and, after Edit, the text. */
@Serializable
data class LearningSave(val target: String = "memory", val text: String? = null)
