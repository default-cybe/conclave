package dev.conclave.client.logic

import dev.conclave.client.model.Session
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Unread conversations, the hub's core/src/session/unread.ts: the hub stamps
 * meta.doneAt when a turn stops running and meta.seenAt when the owner opens
 * it (POST /api/sessions/:id/seen). Unread is finished after last seen; the
 * lists show its title in bold. Sessions from before have no doneAt and read as seen.
 */
object Unread {
    private fun Session.stamp(key: String): Long? = (meta?.get(key) as? JsonPrimitive)?.longOrNull

    fun isUnread(s: Session): Boolean {
        val done = s.stamp("doneAt") ?: return false
        val seen = s.stamp("seenAt") ?: return true
        return done > seen
    }
}
