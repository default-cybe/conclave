package dev.conclave.client

import dev.conclave.client.logic.SessionModes
import dev.conclave.client.model.SessionMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The style in the composer's Options chip (logic/SessionModes.kt), as the web's OptionsChip (design reviews #4, #6). */
class SessionModesTest {
    @Test
    fun optionsSaysWhatChanged() {
        // at the defaults: one word
        val none = SessionModes.optionsChanges(SessionMode.AGENT, ultra = false, ultraOffered = true, agent = "coder", defaultAgent = "coder", memory = null)
        assertEquals("Options", SessionModes.optionsWords(none))
        assertEquals("Plan", SessionModes.optionsWords(SessionModes.optionsChanges(SessionMode.PLAN, false, true, null, null, null)))
        // memory leads, so No memory is never folded into the count
        val many = SessionModes.optionsChanges(SessionMode.JURY, ultra = true, ultraOffered = true, agent = "reviewer", defaultAgent = "coder", memory = "No memory")
        assertEquals(listOf("No memory", "Jury", "Ultra", "reviewer"), many)
        assertEquals("No memory +3", SessionModes.optionsWords(many))
        // Ultra is only named where the session takes it; no style offered (a chat) names none
        assertEquals(listOf("Chat"), SessionModes.optionsChanges(SessionMode.CHAT, ultra = true, ultraOffered = false, agent = null, defaultAgent = null, memory = null))
        assertEquals(listOf("Memory, use only"), SessionModes.optionsChanges(null, ultra = true, ultraOffered = true, agent = null, defaultAgent = null, memory = "Memory, use only"))
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
