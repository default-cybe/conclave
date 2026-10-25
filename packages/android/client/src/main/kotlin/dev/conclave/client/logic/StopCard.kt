package dev.conclave.client.logic

import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * "Why did this turn stop": the reason a session is not working, from its
 * status, its last reply's stop reason and its newest notice, with the
 * evidence and the next step (web features/chat/stopCard.ts, same words).
 * [activity] tells a quiet task from a live one by its session's last update.
 */
data class StopCard(val kind: String, val title: String, val evidence: String, val next: String)

object StopCards {
    /** A running task with no activity for this long is not shown as alive (the stuck alert's default is 5 min). */
    const val QUIET_MS = 5 * 60_000L

    /** "Active now", "Active 2 min ago", "No activity for 7 min"; null when the session has no update time. */
    fun activity(updatedAt: Long, now: Long): Pair<String, Boolean>? {
        if (updatedAt <= 0) return null
        val ms = maxOf(0L, now - updatedAt)
        if (ms >= QUIET_MS) return "No activity for ${ms / 60_000} min" to true
        return (if (ms < 45_000) "Active now" else "Active ${Math.round(ms / 60_000.0)} min ago") to false
    }

    private fun cut(s: String, n: Int = 160) = if (s.length > n) s.take(n - 1).trimEnd() + "…" else s

    private fun text(m: Message) = m.content.filterIsInstance<TextBlock>().joinToString("") { it.text }

    private fun flag(m: Message, key: String) = ((m.meta?.get(key) as? JsonPrimitive)?.takeIf { !it.isString })?.booleanOrNull == true

    /** The card for a session that stopped, or null while it works, waits on you or has nothing to say. [clock] words a time ("14:05"). */
    fun of(session: Session, messages: List<Message>, stuckSince: Long? = null, clock: (Long) -> String): StopCard? {
        val notices = messages.filter { it.kind == MessageKind.NOTICE }
        if (session.status == SessionStatus.RUNNING && stuckSince != null) {
            return StopCard("stalled", "Stalled", "No progress since ${clock(stuckSince)}.", "Stop it, or keep waiting, from the Inbox.")
        }
        if (session.status == SessionStatus.ERROR) {
            val n = notices.lastOrNull { it.meta?.string("level") == "error" || it.meta?.string("type") == "provider_error" || Regex("^error\\b", RegexOption.IGNORE_CASE).containsMatchIn(text(it)) }
            val evidence = cut((n?.let { text(it) } ?: session.error ?: "The provider failed.").replace(Regex("^error:?\\s*", RegexOption.IGNORE_CASE), ""))
            return StopCard("provider", "Provider error", evidence, if (n != null && flag(n, "canRetry")) "Retry with another model." else "Send a message to try again, or switch model.")
        }
        if (session.status == SessionStatus.WAITING_RESET) {
            val n = notices.lastOrNull { Regex("limit", RegexOption.IGNORE_CASE).containsMatchIn((it.meta?.string("type") ?: "") + " " + text(it)) }
            val next = session.resumeAt?.let { "It resumes at ${clock(it)}. Or switch model." } ?: "It resumes when the limit resets. Or switch model."
            return StopCard("limit", "Usage limit", cut(n?.let { text(it) } ?: "The model hit its usage limit."), next)
        }
        if (session.status != SessionStatus.IDLE) return null
        val last = messages.lastOrNull { it.kind == MessageKind.NORMAL && (it.role == Role.ASSISTANT || it.content.any { b -> b is TextBlock }) }
        if (last?.role == Role.ASSISTANT && last.stopReason == "refusal") {
            val offer = notices.lastOrNull { it.seq > last.seq && it.meta?.string("type") == "refusal" }
            return StopCard("refusal", "Refused", cut(text(last).ifBlank { "The model declined to continue." }), if (offer != null && flag(offer, "canTryNext")) "Try the next model." else "Rephrase, or switch model.")
        }
        val stopped = StopCard("stopped", "Stopped by you", "The turn was cut before it finished.", "Send a message to go on.")
        // only the owner's Stop writes the "Stopped" notice; a hub restart also sets stoppedTurn but writes none
        val after = notices.filter { last == null || it.seq > last.seq }
        val stoppedByYou = after.any { text(it) == "Stopped" }
        if (session.meta?.let { (it["stoppedTurn"] as? JsonPrimitive)?.booleanOrNull == true } == true) {
            return if (stoppedByYou) stopped else StopCard("interrupted", "Interrupted", "The hub restarted during this turn.", "Resume to go on.")
        }
        // a Stop mid tool run leaves the reply on tool_use; the notice is the proof either way
        if (stoppedByYou) return stopped
        if (last?.role == Role.ASSISTANT && last.stopReason == "aborted") {
            // the harness writes "aborted" for every stop that is not a clean end (output limit, ACP error), not only your Stop
            val n = after.lastOrNull { it.meta?.string("level").let { l -> l == "error" || l == "warning" } }
            if (n != null) return StopCard("provider", if (n.meta?.string("level") == "error") "Provider error" else "Stopped early", cut(text(n)), "Send a message to try again, or switch model.")
        }
        return null
    }
}
