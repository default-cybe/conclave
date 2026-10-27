package dev.conclave.client

import dev.conclave.client.logic.Attach
import dev.conclave.client.logic.ShareIn
import dev.conclave.client.model.Attachment
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Files and text shared from other apps, and the "Share to" picker's list. */
class ShareInTest {
    private fun file(bytes: Int, name: String = "a.txt") = Attachment(mediaType = "text/plain", data = "A".repeat(bytes * 4 / 3), name = name)

    @Test
    fun urisFromEveryPlaceEachOnce() {
        assertEquals(listOf("a", "b", "c"), ShareIn.uris("b", listOf("a", "b"), listOf("a", "c")))
        assertEquals(listOf("x"), ShareIn.uris("x", null, emptyList()))
        assertEquals(listOf("y"), ShareIn.uris(null, null, listOf("y")))
        assertEquals(emptyList(), ShareIn.uris<String>(null, null, emptyList()))
    }

    @Test
    fun subjectAndTextEachOnce() {
        assertEquals("Title\nhttps://x.y", ShareIn.text(" Title ", "https://x.y"))
        assertEquals("https://x.y", ShareIn.text("https://x.y", "https://x.y"))
        assertEquals("note", ShareIn.text(null, "note"))
        assertEquals("", ShareIn.text("  ", null))
    }

    @Test
    fun takesWhatTheHubReads() {
        assertTrue(ShareIn.supported("image/heic", "IMG_1.heic"))
        assertTrue(ShareIn.supported("application/pdf", "a.pdf"))
        assertTrue(ShareIn.supported("text/plain; charset=utf-8", "a.txt"))
        assertTrue(ShareIn.supported("application/json", "a"))
        assertTrue(ShareIn.supported("application/zip", "a"))
        assertTrue(ShareIn.supported("application/octet-stream", "src.zip"))
        // a type that says nothing: the extension decides, the hub fixes the type by it
        assertTrue(ShareIn.supported("application/octet-stream", "notes.md"))
        assertTrue(ShareIn.supported(null, "scan.pdf"))
        assertFalse(ShareIn.supported("video/mp4", "clip.mp4"))
        assertFalse(ShareIn.supported("audio/mpeg", "song.mp3"))
        assertFalse(ShareIn.supported("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "cv.docx"))
        assertFalse(ShareIn.supported("application/octet-stream", "app.apk"))
        assertTrue(ShareIn.unsupported("clip.mp4").startsWith("clip.mp4 was not added"))
        assertEquals("a.pdf is larger than 8 MB", ShareIn.unreadable("a.pdf", "a.pdf is larger than 8 MB"))
        assertEquals("a.jpg: Cannot decode image", ShareIn.unreadable("a.jpg", "Cannot decode image"))
        assertEquals("a.pdf could not be read.", ShareIn.unreadable("a.pdf", null))
    }

    @Test
    fun mergeKeepsWhatFitsAndSaysWhy() {
        val (all, none) = ShareIn.merge(listOf(file(10)), listOf(file(10), file(10)))
        assertEquals(3, all.size)
        assertNull(none)
        val (fifteen, many) = ShareIn.merge(List(14) { file(10) }, List(3) { file(10) })
        assertEquals(Attach.MAX, fifteen.size)
        assertEquals(Attach.TOO_MANY, many)
        // too big together: that one stays out, a smaller one after it still goes in
        val (some, large) = ShareIn.merge(emptyList(), listOf(file(40 * 1024 * 1024, "big"), file(10 * 1024 * 1024, "next"), file(10, "small")))
        assertEquals(listOf("big", "small"), some.map { it.name })
        assertEquals(Attach.TOO_LARGE, large)
    }

    @Test
    fun sharedWordsGoAfterTheDraft() {
        assertEquals("hi\nlink", ShareIn.draft("hi", "link"))
        assertEquals("link", ShareIn.draft("", "link"))
        assertEquals("hi", ShareIn.draft("hi", " "))
    }

    @Test
    fun targetsNewestFirstAndSearchable() {
        val chat = Session("c1", title = "Trip plans", kind = SessionKind.CHAT, updatedAt = 30)
        val code = Session("s1", title = "Fix login", agent = "coder", updatedAt = 50)
        val assistant = Session("a1", title = "", agent = "assistant", updatedAt = 10)
        val archived = Session("old", title = "Trip old", kind = SessionKind.CHAT, archived = true, updatedAt = 99)
        val sub = Session("sub", title = "Subagent", parentId = "s1", updatedAt = 99)
        val run = Session("w1", title = "Workflow agent", meta = buildJsonObject { putJsonObject("workflow") { put("runId", "r1") } }, updatedAt = 99)
        val all = listOf(assistant, chat, code, archived, sub, run)
        assertEquals(listOf("s1", "c1", "a1"), ShareIn.targets(all).map { it.id })
        assertEquals(listOf("c1"), ShareIn.targets(all, " trip ").map { it.id })
        assertEquals(listOf("s1"), ShareIn.targets(all, "coder").map { it.id })
        // the mode's word finds them too, and an untitled one by its shown title
        assertEquals(listOf("a1"), ShareIn.targets(all, "assistant").map { it.id })
        assertEquals(listOf("a1"), ShareIn.targets(all, "new session").map { it.id })
        assertEquals(listOf("s1"), ShareIn.targets(all, "code").map { it.id })
    }

    @Test
    fun summary() {
        assertEquals("2 files", ShareIn.summary(2, ""))
        assertEquals("1 file and a note", ShareIn.summary(1, "x"))
        assertEquals("A note", ShareIn.summary(0, "x"))
    }
}
