package dev.conclave.client.logic

import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * "Try the next model" on a refused reply (Refusal fallback, Settings >
 * Models on the hub; web features/chat/TryNextModel.tsx). When a model
 * refuses, the hub's notice says whether the owner's list has a next model
 * and account (meta type "refusal", canTryNext). The button asks the hub to
 * run the same turn there (POST /api/sessions/:id/next-model): the refused
 * reply leaves (message.deleted), a notice says each step ("Opus 5.5 (neu)
 * declined. Trying GLM-5.3."), and it changes in place when a model answers.
 */
object NextModel {
    const val LABEL = "Try the next model"

    /** While the hub takes it. */
    const val BUSY = "Trying"

    /** What the button is for: the notice that offers it and the refused reply it drops. */
    data class Offer(val notice: Message, val reply: Message)

    /** A refusal notice that offers the next model. */
    fun offers(m: Message): Boolean {
        val meta = m.meta ?: return false
        val can = meta["canTryNext"] as? JsonPrimitive
        return m.kind == MessageKind.NOTICE && meta.string("type") == "refusal" && can != null && !can.isString && can.booleanOrNull == true
    }

    /**
     * The newest notice that offers the next model, while only notices and
     * the "Not run" answers to the refused reply's calls came after it (what
     * the hub takes). A reply, a message of yours or a newer offer ends it.
     */
    fun notice(messages: List<Message>): Message? {
        for (i in messages.indices.reversed()) {
            val m = messages[i]
            if (offers(m)) return m
            if (m.kind == MessageKind.NOTICE || m.role == Role.USER && m.kind == MessageKind.NORMAL && ChatItems.isToolResultsOnly(m)) continue
            return null
        }
        return null
    }

    /** The reply [notice] is about: the last reply before it, when it ended in a refusal. */
    fun refused(messages: List<Message>, notice: Message): Message? {
        val at = messages.indexOfFirst { it.id == notice.id }
        if (at < 0) return null
        val reply = messages.subList(0, at).lastOrNull { it.role == Role.ASSISTANT && it.kind == MessageKind.NORMAL } ?: return null
        return reply.takeIf { it.stopReason == "refusal" }
    }

    /** Nothing runs and nothing waits on you: the hub takes it only then (web: not running, not waiting). */
    fun ready(status: SessionStatus?): Boolean =
        status != null && status != SessionStatus.RUNNING && status != SessionStatus.WAITING_APPROVAL && status != SessionStatus.WAITING_INPUT

    /** The offer to show now, or null: on its notice, and in the action row of the reply it is for. */
    fun of(messages: List<Message>, status: SessionStatus?): Offer? {
        if (!ready(status)) return null
        val notice = notice(messages) ?: return null
        val reply = refused(messages, notice) ?: return null
        return Offer(notice, reply)
    }
}
