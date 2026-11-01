package dev.conclave.client

import dev.conclave.client.logic.TextSize
import kotlin.test.Test
import kotlin.test.assertEquals

/** Text size in Settings, Appearance (logic/TextSize.kt): the same four sizes and scales as the web app. */
class TextSizeTest {
    @Test
    fun fourSizesSmallestFirstWithTheWebScales() {
        assertEquals(listOf("Small", "Default", "Large", "Larger"), TextSize.entries.map { it.label })
        assertEquals(listOf("small", "default", "large", "larger"), TextSize.entries.map { it.wire })
        assertEquals(listOf(0.875f, 1f, 1.125f, 1.25f), TextSize.entries.map { it.scale })
    }

    @Test
    fun aReplyReads16spByDefaultAsInClaudesApp() {
        assertEquals(16f, TextSize.DEFAULT.sp(TextSize.CHAT_BODY))
        assertEquals(listOf(14f, 16f, 18f, 20f), TextSize.entries.map { it.sp(TextSize.CHAT_BODY) })
    }

    @Test
    fun theStoredValueReadsBack() {
        for (s in TextSize.entries) assertEquals(s, TextSize.from(s.wire))
        // none yet, or a size this version does not know
        assertEquals(TextSize.DEFAULT, TextSize.from(null))
        assertEquals(TextSize.DEFAULT, TextSize.from("huge"))
        assertEquals(TextSize.DEFAULT, TextSize.from("LARGE"))
    }

    @Test
    fun scalesOnTopOfThePhonesOwnFontSize() {
        assertEquals(1f, TextSize.DEFAULT.fontScale(1f))
        assertEquals(1.25f, TextSize.LARGER.fontScale(1f))
        assertEquals(1.3f * 0.875f, TextSize.SMALL.fontScale(1.3f))
    }
}
