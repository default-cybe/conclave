package dev.conclave.client

import dev.conclave.client.update.UpdatePrompt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UpdatePromptTest {

    @Test
    fun theTitleNamesTheVersion() {
        assertEquals("Conclave 0.9.2 is ready", UpdatePrompt.title("0.9.2"))
    }

    @Test
    fun skipHidesThatVersionAndOlderOnesUntilANewerOne() {
        assertFalse(UpdatePrompt.isSkipped("0.9.2", null))
        assertFalse(UpdatePrompt.isSkipped("0.9.2", ""))
        assertTrue(UpdatePrompt.isSkipped("0.9.2", "0.9.2"))
        assertTrue(UpdatePrompt.isSkipped("0.9.2", "v0.9.2"))
        assertTrue(UpdatePrompt.isSkipped("0.9.1", "0.9.2"))
        assertFalse(UpdatePrompt.isSkipped("0.9.3", "0.9.2"))
        assertFalse(UpdatePrompt.isSkipped("1.0.0", "0.9.2"))
        // the release after a prerelease that was skipped asks again
        assertFalse(UpdatePrompt.isSkipped("1.0.0", "1.0.0-rc.1"))
    }

    @Test
    fun theDialogShowsOncePerStartWhenOnAndNotSkipped() {
        assertTrue(UpdatePrompt.showDialog("0.9.2", skipped = null, atStartup = true))
        assertFalse(UpdatePrompt.showDialog(null, skipped = null, atStartup = true))
        // closed once since the app started
        assertFalse(UpdatePrompt.showDialog("0.9.2", skipped = null, atStartup = true, shown = true))
        // Skip this version
        assertFalse(UpdatePrompt.showDialog("0.9.2", skipped = "0.9.2", atStartup = true))
        assertTrue(UpdatePrompt.showDialog("0.9.3", skipped = "0.9.2", atStartup = true))
        // Don't show at startup
        assertFalse(UpdatePrompt.showDialog("0.9.3", skipped = null, atStartup = false))
    }

    @Test
    fun theDotShowsForAVersionNotSkippedWhateverTheDialogSays() {
        assertTrue(UpdatePrompt.showDot("0.9.2", null))
        assertFalse(UpdatePrompt.showDot(null, null))
        assertFalse(UpdatePrompt.showDot("0.9.2", "0.9.2"))
        assertTrue(UpdatePrompt.showDot("0.9.3", "0.9.2"))
    }

    @Test
    fun whatsNewIsTheFirstPlainLineOfTheNotes() {
        assertNull(UpdatePrompt.whatsNew(""))
        assertNull(UpdatePrompt.whatsNew("  \n\n "))
        assertEquals("Faster sync on slow networks.", UpdatePrompt.whatsNew("Faster sync on slow networks.\nAnd more."))
        assertEquals(
            "The side panel is simpler: New, Search and your conversations.",
            UpdatePrompt.whatsNew("# Conclave 0.9.2\n\n## What's new\n\n- The side panel is **simpler**: New, Search and your conversations.\n- Fixes"),
        )
        assertEquals("See the release page for details", UpdatePrompt.whatsNew("1. See the [release page](https://example.com) for `details`"))
        // only headings: the first one, plain
        assertEquals("Conclave 0.9.2", UpdatePrompt.whatsNew("## Conclave 0.9.2"))
    }

    @Test
    fun aLongWhatsNewLineIsCutAtAWord() {
        val long = "Workflows now show every phase and agent as it runs, with the result folded under each step so a long run stays easy to read on a phone"
        val cut = UpdatePrompt.whatsNew(long, max = 60)!!
        assertTrue(cut.length <= 60, cut)
        assertTrue(cut.endsWith("…"), cut)
        assertTrue(long.startsWith(cut.removeSuffix("…")), cut)
        assertFalse(cut.removeSuffix("…").endsWith(" "), cut)
    }
}
