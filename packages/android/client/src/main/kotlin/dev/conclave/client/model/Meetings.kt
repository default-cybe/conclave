package dev.conclave.client.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Meetings: mirrors packages/core/src/meeting/wire.ts with the scheduled
// meetings of docs/design/MEETING-MODE.md 11.6. Status and prep state stay
// strings, so a value a newer hub adds still decodes; Meetings.kt maps them
// to words. A 0.4.51 hub's rows have none of the new fields: they decode to
// the defaults (no scheduledAt, prepState "none").

@Serializable
data class Meeting(
    val id: String,
    val accountId: String = "",
    val sessionId: String = "",
    val projectId: String? = null,
    val device: String = "",
    val cwd: String = "",
    val title: String = "",
    /** "What it's for". */
    val agenda: String? = null,
    /** scheduled, preparing, ready, live, paused, ending, ended or failed. */
    val status: String = "",
    val createdAt: Long = 0,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val audioClientId: String? = null,
    val notesPath: String? = null,
    val error: String? = null,
    val scheduledAt: Long? = null,
    val durationMin: Int? = null,
    /** The IANA zone at scheduling time. */
    val tz: String? = null,
    val steering: String? = null,
    val steeringPreset: String? = null,
    /** short or long. */
    val answerLength: String = "short",
    val calendarEventId: String? = null,
    val calendarId: String? = null,
    /** Minutes before the start: a subset of 1440, 60 and 15. */
    val reminders: List<Int> = listOf(1440, 15),
    val autoPrep: Boolean = true,
    /** none, queued, running, waiting, done, failed or cancelled. */
    val prepState: String = "none",
    val prepProgress: PrepProgress? = null,
    val prepAt: Long? = null,
    val prepEditedAt: Long? = null,
    val prepError: String? = null,
)

/** The prep job's progress (11.4.3). [phase]: inventory, waiting-approval, map, merge, reduce or done. */
@Serializable
data class PrepProgress(
    val phase: String = "",
    val done: Int = 0,
    val total: Int = 0,
    val startedAt: Long? = null,
    val leftOut: Int = 0,
)

/** What a prep read (11.6 prep_sources). */
@Serializable
data class PrepSources(
    val sessions: Int = 0,
    val chunks: Int = 0,
    val workflows: Int = 0,
    val commits: Int = 0,
    val files: Int = 0,
    val tokensIn: Long = 0,
    val tokensOut: Long = 0,
    val leftOut: List<String> = emptyList(),
)

/** GET /api/meetings/:id/prep. [estimate] is the 500k-token approval pause's cost line, kept as JSON. */
@Serializable
data class PrepView(
    val state: String = "none",
    val progress: PrepProgress? = null,
    val draft: String? = null,
    val edited: String? = null,
    val at: Long? = null,
    val editedAt: Long? = null,
    val sources: PrepSources? = null,
    val error: String? = null,
    val estimate: JsonObject? = null,
)

/** One device and folder pair the form can pick (11.3.1). */
@Serializable
data class MeetingFolder(
    val device: String = "",
    val deviceName: String = "",
    val online: Boolean = false,
    val cwd: String = "",
    val projectId: String? = null,
    val projectName: String? = null,
    val chats: Int = 0,
    val lastAt: Long = 0,
)

@Serializable
data class MeetingFolders(val folders: List<MeetingFolder> = emptyList())

@Serializable
data class SteeringPreset(val id: String = "", val label: String = "", val text: String = "")

@Serializable
data class SteeringPresets(val presets: List<SteeringPreset> = emptyList())

/** GET /api/meetings/:id/notes; the phone shows only [markdown]. */
@Serializable
data class MeetingNotes(val summary: String = "", val markdown: String = "")

@Serializable
data class MeetingList(val meetings: List<Meeting> = emptyList())

/**
 * CreateMeetingInput and MeetingPatch (11.6): only the fields set go out
 * (the client's JSON drops nulls). Without [scheduledAt] a create starts
 * preparing now ("Start now").
 */
@Serializable
data class MeetingInput(
    val device: String? = null,
    val cwd: String? = null,
    val projectId: String? = null,
    val title: String? = null,
    val agenda: String? = null,
    val scheduledAt: Long? = null,
    val durationMin: Int? = null,
    val tz: String? = null,
    val steering: String? = null,
    val steeringPreset: String? = null,
    val answerLength: String? = null,
    val reminders: List<Int>? = null,
    val autoPrep: Boolean? = null,
)
