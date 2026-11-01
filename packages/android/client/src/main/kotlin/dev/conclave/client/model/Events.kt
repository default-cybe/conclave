package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Engine events streamed over the WebSocket, polymorphic on "type".
 * Mirrors EngineEvent in packages/core/src/types.ts.
 * Unknown types decode to [EngineEvent.Unknown].
 */
@Serializable
sealed class EngineEvent {
    /** Session this event belongs to, when it has one. */
    open val sessionKey: String? get() = null

    @Serializable
    @SerialName("session.created")
    data class SessionCreated(val session: Session) : EngineEvent() {
        override val sessionKey get() = session.id
    }

    @Serializable
    @SerialName("session.updated")
    data class SessionUpdated(val session: Session) : EngineEvent() {
        override val sessionKey get() = session.id
    }

    @Serializable
    @SerialName("session.deleted")
    data class SessionDeleted(val sessionId: String) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("message.created")
    data class MessageCreated(val message: Message) : EngineEvent() {
        override val sessionKey get() = message.sessionId
    }

    @Serializable
    @SerialName("message.updated")
    data class MessageUpdated(val message: Message) : EngineEvent() {
        override val sessionKey get() = message.sessionId
    }

    /**
     * A message left the transcript: an empty reply, or a refused one that
     * Refusal fallback dropped before the next model answered.
     */
    @Serializable
    @SerialName("message.deleted")
    data class MessageDeleted(val sessionId: String, val messageId: String) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("message.delta")
    data class MessageDelta(
        val sessionId: String,
        val messageId: String,
        val index: Int = 0,
        val kind: DeltaKind = DeltaKind.TEXT,
        val text: String = "",
    ) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("tool.started")
    data class ToolStarted(
        val sessionId: String,
        val messageId: String = "",
        val toolUseId: String,
        val name: String = "",
        val input: JsonObject = JsonObject(emptyMap()),
    ) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("tool.progress")
    data class ToolProgress(val sessionId: String, val toolUseId: String, val text: String = "") : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("tool.completed")
    data class ToolCompleted(val sessionId: String, val toolUseId: String, val result: ToolResultBlock) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("approval.requested")
    data class ApprovalRequested(val approval: ApprovalRequest) : EngineEvent() {
        override val sessionKey get() = approval.sessionId
    }

    @Serializable
    @SerialName("approval.resolved")
    data class ApprovalResolved(val id: String, val sessionId: String = "", val response: ApprovalResponse? = null) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("question.asked")
    data class QuestionAsked(val question: QuestionRequest) : EngineEvent() {
        override val sessionKey get() = question.sessionId
    }

    @Serializable
    @SerialName("question.answered")
    data class QuestionAnswered(val id: String, val sessionId: String = "") : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("todo.updated")
    data class TodoUpdated(val sessionId: String, val todos: List<Todo> = emptyList()) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    /**
     * The messages waiting in a session changed: one was sent while it was
     * busy, removed, started, or a Stop cleared them. The whole list, in the
     * order they will run.
     */
    @Serializable
    @SerialName("session.queue")
    data class SessionQueue(val sessionId: String, val queue: List<QueuedMessage> = emptyList()) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    @Serializable
    @SerialName("usage.recorded")
    data class UsageRecorded(val record: UsageRecord) : EngineEvent()

    @Serializable
    @SerialName("limit.updated")
    data class LimitUpdated(val limit: LimitState) : EngineEvent()

    @Serializable
    @SerialName("notice")
    data class NoticeEvent(val notice: Notice) : EngineEvent() {
        override val sessionKey get() = notice.sessionId
    }

    @Serializable
    @SerialName("task.updated")
    data class TaskUpdated(val task: Task) : EngineEvent()

    @Serializable
    @SerialName("task.deleted")
    data class TaskDeleted(val taskId: String) : EngineEvent()

    @Serializable
    @SerialName("routine.updated")
    data class RoutineUpdated(val routine: Routine) : EngineEvent()

    @Serializable
    @SerialName("routine.deleted")
    data class RoutineDeleted(val routineId: String) : EngineEvent()

    @Serializable
    @SerialName("routine.run")
    data class RoutineRunEvent(val run: RoutineRun) : EngineEvent()

    @Serializable
    @SerialName("memory.updated")
    data class MemoryUpdated(val entry: MemoryEntry) : EngineEvent()

    @Serializable
    @SerialName("memory.deleted")
    data class MemoryDeleted(val id: String) : EngineEvent()

    @Serializable
    @SerialName("device.updated")
    data class DeviceUpdated(val device: Device) : EngineEvent()

    @Serializable
    @SerialName("device.deleted")
    data class DeviceDeleted(val deviceId: String) : EngineEvent()

    /** An app of this account paired, signed in, came or went, or was signed out. */
    @Serializable
    @SerialName("app.updated")
    data class AppUpdated(val app: AppDto) : EngineEvent()

    @Serializable
    @SerialName("checkpoint.created")
    data class CheckpointCreated(val sessionId: String, val checkpoint: Checkpoint) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    /** Remote access changed: a new tunnel address, a mode, the address list. */
    @Serializable
    @SerialName("remote.updated")
    data class RemoteUpdated(val remote: RemoteStatus) : EngineEvent()

    /** A chat import batch changed (its counts, its state). */
    @Serializable
    @SerialName("import.batch")
    data class ImportBatchUpdated(val batch: ImportBatch) : EngineEvent()

    /** A project's identity or locations changed. */
    @Serializable
    @SerialName("project.updated")
    data class ProjectUpdated(val project: Project) : EngineEvent()

    /** A session moved to another device or folder. */
    @Serializable
    @SerialName("session.moved")
    data class SessionMoved(
        val sessionId: String,
        val from: SessionPlace = SessionPlace(),
        val to: SessionPlace = SessionPlace(),
        val via: LocationVia? = null,
        val level: MatchLevel? = null,
    ) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    /** A workflow run changed state, and every 2 seconds while it runs. */
    @Serializable
    @SerialName("workflow.run")
    data class WorkflowRunUpdated(val run: WorkflowRun) : EngineEvent()

    @Serializable
    @SerialName("workflow.phase")
    data class WorkflowPhaseStarted(val runId: String, val index: Int = 0, val title: String = "") : EngineEvent()

    /** One call of a run changed state (queued, running, done, failed, skipped, cached, parked). */
    @Serializable
    @SerialName("workflow.agent")
    data class WorkflowCallUpdated(val runId: String, val call: WorkflowCall) : EngineEvent()

    @Serializable
    @SerialName("workflow.log")
    data class WorkflowLog(val runId: String, val ts: Long = 0, val text: String = "") : EngineEvent()

    /**
     * What one call does now ([lastTool]). [callSeq] is the call's number (the
     * envelope's own seq is the event number). [waiting] is "approval" while
     * the agent waits on a tool approval, false when that ends, absent when
     * nothing changed.
     */
    @Serializable
    @SerialName("workflow.progress")
    data class WorkflowProgress(
        val runId: String,
        val callSeq: Int = 0,
        val lastTool: String = "",
        val waiting: kotlinx.serialization.json.JsonPrimitive? = null,
    ) : EngineEvent() {
        /** True or false when the event says, null when it does not. */
        val waitingOnOwner: Boolean?
            get() = when {
                waiting == null -> null
                waiting.isString -> waiting.content == "approval"
                else -> false
            }
    }

    /** An alert (a file conflict, a stuck turn) landed in the Inbox, or an open one changed. */
    @Serializable
    @SerialName("alert.raised")
    data class AlertRaised(val alert: AlertItem) : EngineEvent() {
        override val sessionKey get() = alert.sessionId
    }

    /** It left the Inbox: answered, dismissed, or it cleared itself. */
    @Serializable
    @SerialName("alert.cleared")
    data class AlertCleared(val id: String, val sessionId: String = "") : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    /** A friend changed: a request, an accept, a key change, a read mark, a delivery (docs/design/FRIENDS.md). */
    @Serializable
    @SerialName("friend.updated")
    data class FriendUpdated(val friend: FriendDto) : EngineEvent()

    /** A note from a friend landed. It is data: nothing runs because of it. */
    @Serializable
    @SerialName("friend.message")
    data class FriendMessage(val message: InboxItemDto) : EngineEvent()

    /** A share from a friend: received, updated, accepted, revoked or expired. */
    @Serializable
    @SerialName("friend.share")
    data class FriendShare(val change: String = "", val share: ReceivedShareDto) : EngineEvent()

    /** A share this hub sent: sent, updated, accepted, revoked or failed. */
    @Serializable
    @SerialName("friend.share.sent")
    data class FriendShareSent(val change: String = "", val share: SentShareDto) : EngineEvent()

    /**
     * Token and tool activity on the Map, only while live(map = ...) asks for
     * it. [delta] stays JSON: MapDeltas.parse tells a null from a field that
     * is not there.
     */
    @Serializable
    @SerialName("map.delta")
    data class MapDeltaEvent(val delta: JsonObject = JsonObject(emptyMap())) : EngineEvent()

    /** A meeting changed: its status, its schedule, its steering (docs/design/MEETING-MODE.md 3.2). */
    @Serializable
    @SerialName("meeting.updated")
    data class MeetingUpdated(val sessionId: String = "", val meeting: Meeting) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    /** A meeting's prep job moved on (11.4.3), at most twice a second. */
    @Serializable
    @SerialName("meeting.prep")
    data class MeetingPrep(val sessionId: String = "", val meetingId: String, val state: String = "", val progress: PrepProgress? = null) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    /** A scheduled meeting's start time came (11.5). */
    @Serializable
    @SerialName("meeting.due")
    data class MeetingDue(val sessionId: String = "", val meetingId: String) : EngineEvent() {
        override val sessionKey get() = sessionId
    }

    /** Also emitted locally when the hub asks for a full resync. */
    @Serializable
    @SerialName("config.updated")
    class ConfigUpdated : EngineEvent() {
        override fun equals(other: Any?): Boolean = other is ConfigUpdated
        override fun hashCode(): Int = 1
        override fun toString(): String = "ConfigUpdated"
    }

    /** An event type this app does not know yet. */
    @Serializable
    @SerialName("unknown")
    class Unknown : EngineEvent() {
        override fun equals(other: Any?): Boolean = other is Unknown
        override fun hashCode(): Int = 2
        override fun toString(): String = "Unknown"
    }
}

@Serializable
enum class DeltaKind {
    @SerialName("text") TEXT,
    @SerialName("thinking") THINKING,
    @SerialName("tool_input") TOOL_INPUT,
}

/** EngineEventEnvelope: the event plus the hub's sequence number and timestamp. */
data class EventEnvelope(
    val seq: Long,
    val ts: Long,
    /** Raw "type" string, kept so unknown events can still be logged by name. */
    val type: String,
    val event: EngineEvent,
)
