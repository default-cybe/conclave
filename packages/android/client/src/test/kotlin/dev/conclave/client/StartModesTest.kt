package dev.conclave.client

import dev.conclave.client.logic.Start
import dev.conclave.client.model.MePreferences
import dev.conclave.client.model.ModesPreference
import kotlin.test.Test
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
}
