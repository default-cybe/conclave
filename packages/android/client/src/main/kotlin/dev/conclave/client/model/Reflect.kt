package dev.conclave.client.model

import kotlinx.serialization.Serializable

// Settings > Reflect: mirrors ReflectDto in packages/core/src/assistant/types.ts
// (GET and PUT /api/assistant/reflect, POST /api/assistant/reflect/run).

/** The last reflection: "Last ran 02:40, saved 2 notes, retired 1". */
@Serializable
data class ReflectRun(
    val id: String = "",
    /** running, ok, error or skipped */
    val status: String = "",
    /** schedule: the night's run; manual: Reflect now. */
    val trigger: String = "schedule",
    val startedAt: Long = 0,
    val finishedAt: Long? = null,
    val sessionId: String? = null,
    val saved: Int = 0,
    val retired: Int = 0,
    /** Why it was skipped, or what failed. */
    val reason: String? = null,
)

/** The nightly reflection on one page; the switch is the same one as Settings > Assistant's on the hub. */
@Serializable
data class ReflectInfo(
    val enabled: Boolean = false,
    /** "02:40" in [timezone]; null when the schedule is not one daily time. */
    val time: String? = null,
    val schedule: String = "",
    val timezone: String = "",
    /** "fast" is the small model; null is the default model. */
    val model: String? = null,
    val routineId: String? = null,
    val nextRunAt: Long? = null,
    val last: ReflectRun? = null,
    /** The notes it keeps on how to work with you, newest first. */
    val notes: List<MemoryEntry> = emptyList(),
)

/** PUT /api/assistant/reflect: only what is set changes. */
@Serializable
data class ReflectPatch(
    val enabled: Boolean? = null,
    /** "HH:MM" */
    val time: String? = null,
    /** A model ref, "fast", or "" for the default model. */
    val model: String? = null,
)

/** POST /api/assistant/reflect/run: the run it started, or why no model was called. */
@Serializable
data class ReflectNow(
    val run: ReflectRun? = null,
    val skipped: String? = null,
    val reflect: ReflectInfo = ReflectInfo(),
)
