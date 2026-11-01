package dev.conclave.client

import dev.conclave.client.logic.Unread
import dev.conclave.client.model.Session
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Unread conversations (logic/Unread.kt), the same rule as the hub's core/src/session/unread.ts. */
class UnreadTest {
    private fun s(done: Long?, seen: Long?) = Session("s", meta = buildJsonObject {
        if (done != null) put("doneAt", done)
        if (seen != null) put("seenAt", seen)
    })

    @Test
    fun `a turn that finished after the last open is unread`() {
        assertTrue(Unread.isUnread(s(done = 20, seen = 10)))
        assertTrue(Unread.isUnread(s(done = 20, seen = null)))
    }

    @Test
    fun `opened since, or from before the stamps, reads as seen`() {
        assertFalse(Unread.isUnread(s(done = 10, seen = 20)))
        assertFalse(Unread.isUnread(s(done = null, seen = null)))
        assertFalse(Unread.isUnread(Session("s")))
    }
}
