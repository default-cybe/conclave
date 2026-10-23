package dev.conclave.client

import dev.conclave.client.logic.Attach
import dev.conclave.client.model.Attachment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Files in one message (docs/design/CHAT-AND-MOTION.md 2.5): 15 at most, the
 * same line as the web app and the hub past that, and zips in the picker.
 */
class AttachTest {
    private fun file(bytes: Int, name: String = "a.txt") = Attachment(mediaType = "text/plain", data = "A".repeat(bytes * 4 / 3), name = name)

    @Test
    fun fifteenAtMostWithTheSameLine() {
        assertEquals(15, Attach.MAX)
        assertEquals("Up to 15 files per message. Zip the rest.", Attach.TOO_MANY)
        assertEquals(15, Attach.room(0))
        assertEquals(5, Attach.room(10))
        assertEquals(0, Attach.room(15))
        assertEquals(0, Attach.room(20))
        val fourteen = List(14) { file(10) }
        assertNull(Attach.refusal(fourteen, file(10)))
        assertEquals(Attach.TOO_MANY, Attach.refusal(fourteen + file(10), file(10)))
    }

    @Test
    fun togetherUnderWhatTheHubReads() {
        val big = file(40 * 1024 * 1024)
        assertNull(Attach.refusal(emptyList(), big))
        assertEquals(Attach.TOO_LARGE, Attach.refusal(listOf(big), file(6 * 1024 * 1024)))
    }

    @Test
    fun zipsArePicked() {
        assertTrue("application/zip" in Attach.PICKER_TYPES)
        assertTrue("application/x-zip-compressed" in Attach.PICKER_TYPES)
        assertTrue(Attach.isZip("application/x-zip-compressed", "src.zip"))
        assertTrue(Attach.isZip("application/octet-stream", "Src.ZIP"))
        assertFalse(Attach.isZip("text/plain", "notes.zip"))
        assertEquals("application/zip", Attach.mediaTypeOf("application/octet-stream", "src.zip"))
        assertEquals("application/x-zip-compressed", Attach.mediaTypeOf("application/x-zip-compressed", "src.zip"))
        assertEquals("application/pdf", Attach.mediaTypeOf("application/pdf", "a.pdf"))
        assertEquals("application/octet-stream", Attach.mediaTypeOf(null, "a.bin"))
    }

    @Test
    fun theCountOnceTheRowScrolls() {
        assertEquals("1 file", Attach.filesWord(1))
        assertEquals("7 files", Attach.filesWord(7))
    }
}
