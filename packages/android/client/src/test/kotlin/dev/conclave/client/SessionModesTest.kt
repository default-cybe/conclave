package dev.conclave.client

import dev.conclave.client.logic.SessionModes
import dev.conclave.client.model.JuryConfig
import dev.conclave.client.model.LoopConfig
import dev.conclave.client.model.ModeConfig
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
    fun theConversationsSwitchesSayWhatChangedAndSecurityIsNeverFolded() {
        // the switches that left the model picker (design review #7)
        val turn = SessionModes.optionsChanges(SessionMode.PLAN, false, true, null, null, memory = "No memory", security = true, sameModel = true, cyber = "Daybreak Blue")
        assertEquals(listOf("No memory", "Security", "Plan", "Same model", "Daybreak Blue"), turn)
        assertEquals("No memory, Security +3", SessionModes.optionsWords(turn))
        // Security alone after another change is still named
        assertEquals("Plan, Security", SessionModes.optionsWords(listOf("Plan", "Security")))
        assertEquals("Same model", SessionModes.optionsWords(SessionModes.optionsChanges(null, false, false, null, null, null, sameModel = true)))
    }

    @Test
    fun theModelPickersSameModelSwitchIsOffOnlyForAMemberOnARefusedModel() {
        val why = "Same model for all work needs a model your account may use; Opus 5.5 is not one."
        assertEquals(why, SessionModes.sameModelRefusal(member = true, unavailable = "Not allowed for you on this hub.", on = false, name = "Opus 5.5"))
        // the owner is never checked; a member on a model they may use, or with it on already (so it can go off), is free
        assertEquals(null, SessionModes.sameModelRefusal(member = false, unavailable = "Plan refused", on = false, name = "Opus 5.5"))
        assertEquals(null, SessionModes.sameModelRefusal(member = true, unavailable = null, on = false, name = "Opus 5.5"))
        assertEquals(null, SessionModes.sameModelRefusal(member = true, unavailable = "Not allowed", on = true, name = "Opus 5.5"))
    }

    @Test
    fun theSetupChipNamesTheExpertStylesSettings() {
        assertEquals("4 jurors", SessionModes.setupWords(SessionMode.JURY, null))
        assertEquals("Debaters, 2 rounds", SessionModes.setupWords(SessionMode.DEBATE, null))
        assertEquals("Until bun test, max 8", SessionModes.setupWords(SessionMode.LOOP, null))
        assertEquals("Until done, max 3", SessionModes.setupWords(SessionMode.LOOP, ModeConfig(loop = LoopConfig(untilCommand = " ", maxIterations = 3))))
        assertEquals("1 juror", SessionModes.setupWords(SessionMode.JURY, ModeConfig(jury = JuryConfig(jurors = listOf("zai/glm-5")))))
        assertEquals(null, SessionModes.setupWords(SessionMode.AGENT, null))
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
