package dev.conclave.client

import dev.conclave.client.logic.DraftStore
import dev.conclave.client.model.Attachment
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The Android composer's draft on disk: it outlives the process, per chat, until sent, deleted or signed out. */
class DraftsTest {
    private val dir = Files.createTempDirectory("drafts").toFile()
    private val pic = Attachment(mediaType = "image/png", data = "iVBORw0KGgo=", name = "a.png")

    @Test
    fun aNewStoreOnTheSameFolderReadsTheDraftBack() {
        DraftStore(dir).apply {
            saveText("s1", "half a thought")
            saveFiles("s1", listOf(pic))
        }
        val again = DraftStore(dir)
        assertEquals("half a thought", again.text("s1"))
        assertEquals(listOf(pic), again.files("s1"))
        assertEquals("", again.text("s2"))
        assertEquals(emptyList(), again.files("s2"))
    }

    @Test
    fun sendingClearsAndAFailedSendPutsItBack() {
        val d = DraftStore(dir)
        d.saveText("s1", "hi")
        d.saveFiles("s1", listOf(pic))
        d.saveText("s1", "")
        d.saveFiles("s1", emptyList())
        assertEquals(emptyList(), dir.listFiles()!!.toList())
        d.saveText("s1", "hi")
        d.saveFiles("s1", listOf(pic))
        assertEquals("hi", d.text("s1"))
        assertEquals(listOf(pic), d.files("s1"))
    }

    @Test
    fun typingLeavesTheFilesAlone() {
        val d = DraftStore(dir)
        d.saveFiles("s1", listOf(pic))
        val files = dir.listFiles()!!.single()
        files.setLastModified(1_000L)
        d.saveText("s1", "more words")
        assertEquals(1_000L, files.lastModified())
    }

    @Test
    fun deleteAndSignOutForgetDrafts() {
        val d = DraftStore(dir)
        d.saveText("s1", "a")
        d.saveText("s2", "b")
        d.saveFiles("s2", listOf(pic))
        d.clear("s2")
        assertEquals("a", d.text("s1"))
        assertEquals("", d.text("s2"))
        assertEquals(emptyList(), d.files("s2"))
        d.clearAll()
        assertEquals("", d.text("s1"))
        d.saveText("s1", "after sign in")
        assertEquals("after sign in", d.text("s1"))
    }

    @Test
    fun aSaveFromBeforeSignOutIsRefused() {
        val d = DraftStore(dir)
        val before = d.generation
        d.saveText("s1", "typed while signed in", before)
        d.clearAll()
        // the open screen closing (or its pending save) after sign out
        d.saveText("s1", "typed while signed in", before)
        d.saveFiles("s1", listOf(pic), before)
        assertEquals("", d.text("s1"))
        assertEquals(emptyList(), d.files("s1"))
        assertTrue(!dir.exists() || dir.listFiles()!!.isEmpty())
    }

    @Test
    fun anOddSessionIdStaysInTheFolderAndABrokenFileIsNoDraft() {
        val d = DraftStore(dir)
        d.saveText("../../etc/x", "kept")
        assertEquals("kept", d.text("../../etc/x"))
        assertTrue(dir.listFiles()!!.all { it.parentFile == dir })
        java.io.File(dir, "s3.files").writeText("{not json")
        assertEquals(emptyList(), d.files("s3"))
    }
}
