package dev.conclave.client

import dev.conclave.client.logic.Drawer
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import dev.conclave.client.model.MePreferences
import dev.conclave.client.model.ModesPreference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Which optional modes show (logic/Start.kt modeOn), the same rule as the web's modeOn. */
class StartModesTest {
    @Test
    fun onUnlessTurnedOff() {
        // nothing loaded yet, or a hub from before the setting: both on
        assertTrue(Start.modeOn(null, "canvas"))
        assertTrue(Start.modeOn(MePreferences(), "security"))
        val prefs = MePreferences(modes = ModesPreference(security = false, canvas = true))
        assertFalse(Start.modeOn(prefs, "security"))
        assertTrue(Start.modeOn(prefs, "canvas"))
        val off = MePreferences(modes = ModesPreference(security = false, canvas = false))
        assertFalse(Start.modeOn(off, "canvas"))
        // Chat, Assistant and Code are always on
        assertTrue(Start.modeOn(off, "code"))
    }

    @Test
    fun meetingsFollowTheHub() {
        // an older hub sends no meetings: on, as before
        assertTrue(Start.modeOn(MePreferences(modes = ModesPreference()), "meetings"))
        assertFalse(Start.modeOn(MePreferences(modes = ModesPreference(meetings = false)), "meetings"))
        assertTrue(Start.modeOn(MePreferences(modes = ModesPreference(meetings = true)), "meetings"))
    }

    @Test
    fun settingsSendsAllThreeWithTheOneChange() {
        val prefs = MePreferences(modes = ModesPreference(security = false, canvas = true, meetings = false))
        assertEquals(ModesPreference(security = false, canvas = true, meetings = true), Start.modesWith(prefs, "meetings", true))
        assertEquals(ModesPreference(security = true, canvas = true, meetings = false), Start.modesWith(prefs, "security", true))
        // nothing loaded: what shows is on, so the rest go as on
        assertEquals(ModesPreference(security = true, canvas = false, meetings = true), Start.modesWith(null, "canvas", false))
        assertEquals(listOf("security", "canvas", "meetings"), Start.OPTIONAL_MODES.map { it.first })
    }

    @Test
    fun panelRowsPerMode() {
        assertEquals(emptyList<Drawer.Page>(), Drawer.pages(StartMode.CHAT, meetings = false))
        assertEquals(listOf(Drawer.Page.MEETINGS), Drawer.pages(StartMode.CODE, meetings = true))
        assertEquals(listOf(Drawer.Page.ROUTINES), Drawer.pages(StartMode.ASSISTANT, meetings = false))
        assertEquals(listOf(Drawer.Page.MEETINGS, Drawer.Page.ROUTINES), Drawer.pages(StartMode.ASSISTANT, meetings = true))
    }
}
