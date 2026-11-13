package dev.conclave.client

import dev.conclave.client.logic.SessionModes
import dev.conclave.client.model.SessionMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The composer's Style chip (logic/SessionModes.kt), as the web's ModeChip (design review #4). */
class SessionModesTest {
    @Test
    fun chipSaysStyle() {
        assertEquals("Agent style", SessionModes.chipWords(SessionMode.AGENT, ultra = false, ultraOffered = true))
        assertEquals("Jury style, Ultra", SessionModes.chipWords(SessionMode.JURY, ultra = true, ultraOffered = true))
        // Ultra is only named where the session takes it
        assertEquals("Chat style", SessionModes.chipWords(SessionMode.CHAT, ultra = true, ultraOffered = false))
    }

    @Test
    fun expertStylesFoldUnderMoreStyles() {
        assertEquals(listOf(SessionMode.AGENT, SessionMode.CHAT, SessionMode.PLAN), SessionModes.EVERYDAY)
        assertEquals(listOf(SessionMode.JURY, SessionMode.DEBATE, SessionMode.LOOP), SessionModes.MORE_STYLES)
        // every mode is still reachable
        assertEquals(SessionMode.entries.toSet(), (SessionModes.EVERYDAY + SessionModes.MORE_STYLES).toSet())
        assertFalse(SessionModes.moreOpen(SessionMode.AGENT, ultra = false, ultraOffered = true))
        assertTrue(SessionModes.moreOpen(SessionMode.LOOP, ultra = false, ultraOffered = true))
        assertTrue(SessionModes.moreOpen(SessionMode.PLAN, ultra = true, ultraOffered = true))
        assertFalse(SessionModes.moreOpen(SessionMode.PLAN, ultra = true, ultraOffered = false))
    }
}
