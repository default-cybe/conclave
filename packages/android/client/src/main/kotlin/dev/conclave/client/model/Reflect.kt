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

// The report: mirrors ReflectReport in packages/core/src/client/recap.ts
// (GET /api/reflect/report?range=, POST /api/reflect/report/refresh?range=).

@Serializable
data class ReflectNamed(val name: String = "", val count: Int = 0)

@Serializable
data class ReflectHabit(val key: String = "", val observation: String = "", val example: String? = null)

@Serializable
data class ReflectTotals(
    val chats: Int = 0,
    val sessions: Int = 0,
    val workflows: Int = 0,
    val hoursActive: Double = 0.0,
    val tokens: Long = 0,
    val costUsd: Double = 0.0,
    val projects: Int = 0,
)

@Serializable
data class ReflectTopic(val name: String = "", val example: String = "")

@Serializable
data class ReflectProject(val name: String = "", val sessions: Int = 0, val example: String = "")

@Serializable
data class ReflectWork(
    val topics: List<ReflectTopic> = emptyList(),
    val projects: List<ReflectProject> = emptyList(),
    val newThisPeriod: List<String> = emptyList(),
)

@Serializable
data class ReflectDay(val date: String = "", val count: Int = 0)

@Serializable
data class ReflectRhythm(
    /** heatmap[weekday][hour], Monday first, your messages in local time. */
    val heatmap: List<List<Int>> = emptyList(),
    val messages: Int = 0,
    val activeDays: Int = 0,
    val longestStreak: Int = 0,
    val busiestDay: ReflectDay? = null,
    val lateNightShare: Double = 0.0,
)

@Serializable
data class ReflectModelUse(val name: String = "", val calls: Int = 0, val tokens: Long = 0, val costUsd: Double = 0.0)

@Serializable
data class ReflectModels(
    val models: List<ReflectModelUse> = emptyList(),
    val agents: List<ReflectNamed> = emptyList(),
    val fallbacks: Int = 0,
    /** "provider/a to provider/b" */
    val topFallback: String? = null,
    val switches: Int = 0,
    val finishedTurns: Int = 0,
    val costPerResult: Double? = null,
)

@Serializable
data class ReflectChat(val title: String = "", val messages: Int = 0, val sessionId: String = "")

@Serializable
data class ReflectWorkflow(val name: String = "", val agents: Int = 0, val costUsd: Double = 0.0)

@Serializable
data class ReflectFun(
    val topTool: ReflectNamed? = null,
    val longestChat: ReflectChat? = null,
    val biggestWorkflow: ReflectWorkflow? = null,
    val newPeople: List<String> = emptyList(),
    val memoriesAdded: Int = 0,
    val skillsLearned: List<String> = emptyList(),
    val goalsMoved: Int = 0,
    val goalsDone: Int = 0,
)

@Serializable
data class ReflectSuggestion(val text: String = "", val why: String = "")

@Serializable
data class ReflectExcluded(val health: Int = 0, val incognito: Int = 0)

@Serializable
data class ReflectReport(
    /** week, month, 3m, 6m or 12m */
    val range: String = "week",
    val start: Long = 0,
    val end: Long = 0,
    val timezone: String = "UTC",
    val generatedAt: Long = 0,
    /** model or basic (from the numbers only) */
    val insights: String = "basic",
    val insightsNote: String? = null,
    val headline: String = "",
    val totals: ReflectTotals = ReflectTotals(),
    val work: ReflectWork = ReflectWork(),
    val rhythm: ReflectRhythm = ReflectRhythm(),
    val habits: List<ReflectHabit> = emptyList(),
    val models: ReflectModels = ReflectModels(),
    val `fun`: ReflectFun = ReflectFun(),
    val suggestions: List<ReflectSuggestion> = emptyList(),
    /** Empty when the range is too thin to ask one. */
    val question: String = "",
    val excluded: ReflectExcluded = ReflectExcluded(),
)

/** POST /api/assistant/reflect/run: the run it started, or why no model was called. */
@Serializable
data class ReflectNow(
    val run: ReflectRun? = null,
    val skipped: String? = null,
    val reflect: ReflectInfo = ReflectInfo(),
)
