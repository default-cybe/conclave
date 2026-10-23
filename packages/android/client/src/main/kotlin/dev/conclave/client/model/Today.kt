package dev.conclave.client.model

import kotlinx.serialization.Serializable

// Home's Today: mirrors TodayDto in packages/core/src/assistant/types.ts and
// ProposalDto in packages/core/src/pim/types.ts (docs/DESIGN.md, Calendar and
// mail). The saved day plan, today's calendar events, and the calendar
// changes and messages that wait for the owner's approval. Kinds, actions and
// statuses stay strings, so one a newer hub adds still decodes.

@Serializable
data class DayPlanItem(
    /** Local "HH:MM", when the item has a time. */
    val time: String? = null,
    val text: String = "",
    /** event, task, goal, focus or reminder. */
    val kind: String? = null,
)

@Serializable
data class PlanQuestion(val text: String = "", val options: List<String> = emptyList(), val answer: String? = null)

@Serializable
data class PlanFocus(val text: String = "", val start: String = "", val end: String = "")

@Serializable
data class DayPlan(
    val date: String = "",
    val summary: String = "",
    val items: List<DayPlanItem> = emptyList(),
    val focus: PlanFocus? = null,
    val question: PlanQuestion? = null,
    val sessionId: String? = null,
    val savedAt: Long = 0,
)

/** One of today's events, in the owner's zone. */
@Serializable
data class TodayEvent(
    val id: String,
    val title: String = "",
    val start: Long = 0,
    val end: Long = 0,
    val allDay: Boolean = false,
    val calendar: String = "",
    /** "#2e7d32" */
    val color: String? = null,
    val location: String? = null,
)

/** The event a proposal would write. */
@Serializable
data class ProposedEvent(
    val title: String = "",
    val start: Long = 0,
    val end: Long = 0,
    val allDay: Boolean = false,
    val calendarId: String = "",
    val calendar: String = "",
    val account: String = "",
    val location: String? = null,
    val description: String? = null,
    val attendees: List<String> = emptyList(),
    val project: String? = null,
    /** "server": the calendar sends invitations; "none": nobody does. */
    val invites: String? = null,
)

@Serializable
data class EventBefore(val title: String = "", val start: Long = 0, val end: Long = 0, val allDay: Boolean = false)

/** The message a proposal would save as a draft or send. */
@Serializable
data class ProposedMail(
    val accountId: String = "",
    val account: String = "",
    val from: String = "",
    val to: List<String> = emptyList(),
    val cc: List<String> = emptyList(),
    val subject: String = "",
    val body: String = "",
    val inReplyTo: String? = null,
)

/** A write the owner approves on a card. */
@Serializable
data class Proposal(
    val id: String,
    /** event or mail. */
    val kind: String = "event",
    /** create, update, delete, draft or send. */
    val action: String = "create",
    /** pending, applied, declined or failed. */
    val status: String = "pending",
    val summary: String = "",
    val createdAt: Long = 0,
    val decidedAt: Long? = null,
    val sessionId: String? = null,
    val event: ProposedEvent? = null,
    val before: EventBefore? = null,
    val mail: ProposedMail? = null,
    val result: String? = null,
    val error: String? = null,
) {
    val pending: Boolean get() = status == "pending"
}

@Serializable
data class TodayTasks(val dueToday: Int = 0, val overdue: Int = 0)

@Serializable
data class Today(
    val date: String = "",
    /** IANA zone the times read in. */
    val timezone: String = "UTC",
    val plan: DayPlan? = null,
    val tasks: TodayTasks = TodayTasks(),
    /** Absent when no calendar is connected. */
    val events: List<TodayEvent>? = null,
    val calendarError: String? = null,
    val proposals: List<Proposal> = emptyList(),
)
