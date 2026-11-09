package dev.conclave.client

import dev.conclave.client.logic.Attach
import dev.conclave.client.model.Attachment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Files in one message (docs/design/CHAT-AND-MOTION.md 2.5): any number of
 * any type, under what the hub reads in one request, and any file in the picker.
 */
class AttachTest {
    private fun file(bytes: Int, name: String = "a.txt") = Attachment(mediaType = "text/plain", data = "A".repeat(bytes * 4 / 3), name = name)

    @Test
    fun noCountCap() {
        val forty = List(40) { file(10) }
        assertNull(Attach.refusal(forty, file(10)))
    }

    @Test
    fun togetherUnderWhatTheHubReads() {
        val big = file(40 * 1024 * 1024)
        assertNull(Attach.refusal(emptyList(), big))
        assertEquals(Attach.TOO_LARGE, Attach.refusal(listOf(big), file(6 * 1024 * 1024)))
    }

    @Test
    fun anyFileIsPicked() {
        assertEquals(listOf("*/*"), Attach.PICKER_TYPES.toList())
        assertTrue(Attach.isZip("application/x-zip-compressed", "src.zip"))
        assertTrue(Attach.isZip("application/octet-stream", "Src.ZIP"))
        assertFalse(Attach.isZip("text/plain", "notes.zip"))
        assertEquals("application/zip", Attach.mediaTypeOf("application/octet-stream", "src.zip"))
        assertEquals("application/x-zip-compressed", Attach.mediaTypeOf("application/x-zip-compressed", "src.zip"))
        assertEquals("application/pdf", Attach.mediaTypeOf("application/pdf", "a.pdf"))
        assertEquals("application/octet-stream", Attach.mediaTypeOf(null, "a.bin"))
    }

    @Test
    fun aPastedPictureIsAFileAndTextIsNot() {
        assertTrue(Attach.isPastedImage("image/png"))
        assertTrue(Attach.isPastedImage("image/gif"))
        assertTrue(Attach.isPastedImage("Image/JPEG"))
        assertFalse(Attach.isPastedImage("text/plain"))
        assertFalse(Attach.isPastedImage("application/pdf"))
        assertFalse(Attach.isPastedImage(""))
        assertFalse(Attach.isPastedImage(null))
    }

    @Test
    fun theCountOnceTheRowScrolls() {
        assertEquals("1 file", Attach.filesWord(1))
        assertEquals("7 files", Attach.filesWord(7))
    }

    @Test
    fun aFileTheHubCouldNotReadAsksInsteadOfFailing() {
        assertEquals("a.pdf could not be read. Send again to go without it.", Attach.lostWords("Attachment not included: a.pdf could not be read. Send again to go without it."))
        assertNull(Attach.lostWords("Network error"))
    }
}
