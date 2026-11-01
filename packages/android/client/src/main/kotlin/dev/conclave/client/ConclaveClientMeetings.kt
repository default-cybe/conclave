package dev.conclave.client

import dev.conclave.client.model.Meeting
import dev.conclave.client.model.MeetingFolder
import dev.conclave.client.model.MeetingFolders
import dev.conclave.client.model.MeetingInput
import dev.conclave.client.model.MeetingList
import dev.conclave.client.model.MeetingNotes
import dev.conclave.client.model.PrepView
import dev.conclave.client.model.SteeringPreset
import dev.conclave.client.model.SteeringPresets
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Meetings and their prep (docs/design/MEETING-MODE.md 11.6), the routes of
// packages/server/src/routes-meetings.ts. The phone never listens: none of
// the segments or answer calls are here.

/** [view]: upcoming, now, past or all. [before] pages Past. A 0.4.51 hub ignores both and answers every meeting. */
suspend fun ConclaveClient.meetings(view: String? = null, limit: Int? = null, before: Long? = null): List<Meeting> =
    get(p("api", "meetings"), MeetingList.serializer(), mapOf("view" to view, "limit" to limit, "before" to before)).meetings

/** One meeting; the detail's transcript and answers are left out of [Meeting]. */
suspend fun ConclaveClient.meeting(id: String): Meeting = get(p("api", "meetings", id), Meeting.serializer())

/** 201: scheduled with a [MeetingInput.scheduledAt], else preparing now. */
suspend fun ConclaveClient.createMeeting(input: MeetingInput): Meeting =
    send("POST", p("api", "meetings"), MeetingInput.serializer(), input, Meeting.serializer())

/** 409 when the schedule moves after it started. */
suspend fun ConclaveClient.updateMeeting(id: String, patch: MeetingInput): Meeting =
    send("PATCH", p("api", "meetings", id), MeetingInput.serializer(), patch, Meeting.serializer())

suspend fun ConclaveClient.deleteMeeting(id: String) = sendUnit("DELETE", p("api", "meetings", id))

/** An ended meeting's notes as Markdown; 404 before wrap-up. */
suspend fun ConclaveClient.meetingNotes(id: String): String = get(p("api", "meetings", id, "notes"), MeetingNotes.serializer()).markdown

/** The account's known device and folder pairs, newest first. */
suspend fun ConclaveClient.meetingFolders(q: String? = null): List<MeetingFolder> =
    get(p("api", "meetings", "folders"), MeetingFolders.serializer(), mapOf("q" to q)).folders

/** The steering presets, the same text as the web's. */
suspend fun ConclaveClient.steeringPresets(): List<SteeringPreset> = get(p("api", "meetings", "presets"), SteeringPresets.serializer()).presets

suspend fun ConclaveClient.meetingPrep(id: String): PrepView = get(p("api", "meetings", id, "prep"), PrepView.serializer())

/** Prepare, or Prepare again; [approve] answers the 500k-token pause. 409 while it runs. */
suspend fun ConclaveClient.startPrep(id: String, approve: Boolean = false) =
    sendUnit("POST", p("api", "meetings", id, "prep"), if (approve) buildJsonObject { put("approve", true) } else null)

/** Stops the calls running; the chats read so far stay read. */
suspend fun ConclaveClient.cancelPrep(id: String) = sendUnit("POST", p("api", "meetings", id, "prep", "cancel"))

/** The owner's version of the prep, at most 60,000 characters. */
suspend fun ConclaveClient.savePrep(id: String, markdown: String): PrepView =
    sendJson("PUT", p("api", "meetings", id, "prep"), buildJsonObject { put("markdown", markdown) }, PrepView.serializer())

/** Back to the generated draft: the owner's edits go. */
suspend fun ConclaveClient.revertPrep(id: String) = sendUnit("DELETE", p("api", "meetings", id, "prep", "edit"))
