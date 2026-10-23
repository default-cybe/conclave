package dev.conclave.client.logic

import dev.conclave.client.model.Attachment
import dev.conclave.client.model.Message
import dev.conclave.client.model.QueuedAttachment
import dev.conclave.client.model.QueuedMessage
import dev.conclave.client.model.Role
import dev.conclave.client.model.SendResult
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.random.Random

/** A message this app sent while the session worked that the hub's list does not show yet. [confirmedAt]: when the hub answered that it waits. */
data class Sending(val item: QueuedMessage, val confirmedAt: Long? = null)

/**
 * Messages you sent while a session works, before they join the transcript
 * (docs/design/CHAT-AND-MOTION.md 2.11). The same rules as the web's
 * store/queue.ts: the hub lists them (GET /queue and session.queue), this
 * app also holds the ones it sent itself until the hub's list has them, so
 * a message shows the moment you send it, and the user message that takes
 * one's place carries its id in meta.pendingIds.
 */
object PendingQueue {
    /** The label a waiting message wears. */
    const val QUEUED = "Queued"
    const val STEERING = "Sending to the running turn"
    /** One Stop held: it waits for Send or the x. */
    const val STOPPED = "Stopped"

    /** The label a stored message keeps when it joined a running turn. */
    const val STEERED = "Steered the running turn"

    private val ID = Regex("^[A-Za-z0-9_-]{6,64}$")

    /** What waits, as a session shows it: the hub's list in its order, then what this app sent that it does not list yet. */
    fun shown(hub: List<QueuedMessage>, sending: List<Sending>): List<QueuedMessage> {
        if (sending.isEmpty()) return hub
        val listed = hub.mapTo(HashSet()) { it.id }
        val mine = sending.filter { it.item.id !in listed }.map { it.item }
        return if (mine.isEmpty()) hub else hub + mine
    }

    /**
     * After the hub's list arrives: what it shows is the hub's now. An event
     * can come before the hub had a send that is still on its way, so the rest
     * stays. A full load asked after the hub answered a send ([loadedFrom]) is
     * the whole truth: one of those it does not list is gone.
     */
    fun afterHubList(sending: List<Sending>, hub: List<QueuedMessage>, loadedFrom: Long? = null): List<Sending> {
        if (sending.isEmpty()) return sending
        val listed = hub.mapTo(HashSet()) { it.id }
        val next = sending.filter { s ->
            val confirmed = s.confirmedAt
            s.item.id !in listed && !(loadedFrom != null && confirmed != null && confirmed <= loadedFrom)
        }
        return if (next.size == sending.size) sending else next
    }

    /** The waiting messages a user message took the place of (meta.pendingIds). */
    fun pendingIds(m: Message): List<String> {
        if (m.role != Role.USER) return emptyList()
        val ids = m.meta?.get("pendingIds") as? JsonArray ?: return emptyList()
        return ids.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
    }

    /** The message joined the transcript in place of a waiting one: it is on screen already, so it does not rise again. */
    fun replacesPending(m: Message): Boolean = pendingIds(m).isNotEmpty()

    /** The list key of a waiting message. */
    fun key(id: String): String = "p:$id"

    /** The list key of a message: the key of the waiting one it took the place of, so the row stays where it was. */
    fun keyOf(m: Message): String = pendingIds(m).firstOrNull()?.let(::key) ?: m.id

    /** An id the hub keeps (SendInput.pendingId): "a_", the time and random letters. */
    fun newId(now: Long = System.currentTimeMillis(), random: Random = Random.Default): String {
        val alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
        val rand = (1..10).map { alphabet[random.nextInt(alphabet.length)] }.joinToString("")
        return "a_" + now.toString(36) + rand
    }

    /** True for an id the hub would keep. */
    fun validId(id: String): Boolean = ID.matches(id)

    /** A message this app sends while the session works, as it shows until the hub lists it. */
    fun item(id: String, text: String, attachments: List<Attachment>, whenBusy: String, at: Long): QueuedMessage =
        QueuedMessage(id = id, text = text, attachments = attachments.map { QueuedAttachment(name = it.name, mediaType = it.mediaType) }, at = at, whenBusy = if (whenBusy == "steer") "steer" else "queue")

    /** The label a waiting message wears. */
    fun pendingWord(whenBusy: String, held: Boolean = false): String = if (held) STOPPED else if (whenBusy == "steer") STEERING else QUEUED

    /** The question of a "/btw <question>" message, or null for any other text. */
    fun btwQuestion(text: String): String? = BTW.matchEntire(text.trim())?.groupValues?.get(1)?.trim()?.ifEmpty { null }

    private val BTW = Regex("^/btw\\s+([\\s\\S]*)$", RegexOption.IGNORE_CASE)

    /** The label a stored message keeps when it was sent while the session worked (meta.whenBusy), else null. */
    fun storedWord(meta: JsonObject?): String? = when ((meta?.get("whenBusy") as? JsonPrimitive)?.contentOrNull) {
        "steer" -> STEERED
        "queue" -> QUEUED
        else -> null
    }

    /** What the hub's answer to a send means for one this app sent: it waits (confirmed), or it leaves (refused, or it ran at once). */
    fun answered(sending: List<Sending>, id: String, result: SendResult?, now: Long): List<Sending> {
        if (sending.none { it.item.id == id }) return sending
        return if (result?.queued == true && result.pendingId == id) {
            sending.map { if (it.item.id == id) it.copy(confirmedAt = now) else it }
        } else {
            sending.filterNot { it.item.id == id }
        }
    }
}
