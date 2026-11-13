package dev.conclave.client

import dev.conclave.client.logic.FileCardData
import dev.conclave.client.logic.FileCards
import dev.conclave.client.logic.Media
import dev.conclave.client.logic.MediaKind
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The in-app viewer's choices (logic/Media.kt): what it shows, what the pager swipes through, and a tool's pictures. */
class MediaTest {
    @Test
    fun eachTypeHasItsView() {
        assertEquals(MediaKind.IMAGE, Media.kind("image/png", "a.png"))
        assertEquals(MediaKind.IMAGE, Media.kind("image/jpeg", "a.jpg"))
        assertEquals(MediaKind.ANIMATED, Media.kind("image/gif", "a.gif"))
        assertEquals(MediaKind.ANIMATED, Media.kind("image/webp", "a.webp"))
        assertEquals(MediaKind.SVG, Media.kind("image/svg+xml", "chart.svg"))
        assertEquals(MediaKind.VIDEO, Media.kind("video/mp4", "clip.mp4"))
        assertEquals(MediaKind.PDF, Media.kind("application/pdf", "report.pdf"))
        assertEquals(MediaKind.TEXT, Media.kind("text/plain; charset=utf-8", "notes.txt"))
        assertEquals(MediaKind.TEXT, Media.kind("application/json", "data.json"))
        // a script sent as bytes: its extension says it is text
        assertEquals(MediaKind.TEXT, Media.kind("application/octet-stream", "backup.sh"))
        assertNull(Media.kind("application/octet-stream", "blob.bin"))
        assertNull(Media.kind("application/zip", "files.zip"))
        assertNull(Media.kind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"))
    }

    private fun card(id: String, type: String, name: String, image: Int? = null) = FileCardData(id, name, type, 10, image = image)

    @Test
    fun thePagerSwipesThroughTheViewableFilesOfTheMessage() {
        val pic = card("g", "image/png", "a.png", image = 0)
        val pic2 = card("g", "image/png", "b.png", image = 1)
        val zip = card("z", "application/zip", "f.zip")
        val pdf = card("p", "application/pdf", "r.pdf")
        val (list, start) = Media.pager(listOf(pic, zip, pic2, pdf), pdf)
        assertEquals(listOf(pic, pic2, pdf), list)
        assertEquals(2, start)
        // two pictures of one GenerateImage call are told apart by their index
        assertEquals(1, Media.pager(listOf(pic, pic2, pdf), pic2).second)
    }

    @Test
    fun aFileTheViewerCannotShowOpensNoPager() {
        val zip = card("z", "application/zip", "f.zip")
        assertEquals(emptyList(), Media.pager(listOf(zip), zip).first)
    }

    @Test
    fun aVideoTooBigToHoldGoesToOpenWith() {
        assertTrue(Media.viewable(FileCardData("v", "clip.mp4", "video/mp4", Media.VIDEO_MAX)))
        assertEquals(false, Media.viewable(FileCardData("v", "film.mp4", "video/mp4", Media.VIDEO_MAX + 1)))
    }

    @Test
    fun aTappedFileMissingFromTheListStillOpensAlone() {
        val pdf = card("p", "application/pdf", "r.pdf")
        assertEquals(listOf(pdf) to 0, Media.pager(emptyList(), pdf))
    }

    private fun result(content: String, isError: Boolean = false) = ConclaveJson.decodeFromString(
        ContentBlock.serializer(),
        """{"type":"tool_result","toolUseId":"t1","isError":$isError,"content":$content}""",
    ) as ToolResultBlock

    @Test
    fun aToolsPicturesComeFromItsResultInOrder() {
        val r = result(
            """[{"type":"text","text":"Took a screenshot"},
               {"type":"image","mediaType":"image/png","data":"AAAA"},
               {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"BBBB"}},
               {"type":"image","mediaType":"image/png"},
               {"type":"image","mediaType":"image/svg+xml","data":"CCCC"}]""",
        )
        assertEquals(listOf(ImageBlock("image/png", "AAAA"), ImageBlock("image/jpeg", "BBBB")), Media.toolImages(r))
    }

    @Test
    fun aFailedOrTextOnlyResultHasNoPictures() {
        assertTrue(Media.toolImages(null).isEmpty())
        assertTrue(Media.toolImages(result("\"done\"")).isEmpty())
        assertTrue(Media.toolImages(result("""[{"type":"image","mediaType":"image/png","data":"AAAA"}]""", isError = true)).isEmpty())
    }

    @Test
    fun theSettingGatesTheThumbnailsAndIsOnByDefault() {
        val r = result("""[{"type":"image","mediaType":"image/png","data":"AAAA"}]""")
        assertTrue(Media.TOOL_PICTURES_DEFAULT)
        assertEquals(1, Media.toolPictures(true, r).size)
        assertTrue(Media.toolPictures(false, r).isEmpty())
    }

    @Test
    fun picturesAndVideosAreThumbnailsAndTheRestCompactCards() {
        listOf("image/png" to "a.png", "image/jpeg" to "a.jpg", "image/gif" to "a.gif", "image/webp" to "a.webp", "video/mp4" to "c.mp4")
            .forEach { (t, n) -> assertTrue(Media.thumbnail(FileCardData("x", n, t, 10)), t) }
        listOf("application/pdf" to "r.pdf", "text/plain" to "a.kt", "application/zip" to "f.zip", "image/svg+xml" to "c.svg", "application/octet-stream" to "b.bin")
            .forEach { (t, n) -> assertFalse(Media.thumbnail(FileCardData("x", n, t, 10)), t) }
        // too big to fetch whole for a thumbnail: a card that opens Open with or the viewer
        assertFalse(Media.thumbnail(FileCardData("x", "big.png", "image/png", FileCards.INLINE_MAX + 1)))
        assertFalse(Media.thumbnail(FileCardData("x", "film.mp4", "video/mp4", Media.VIDEO_MAX + 1)))
    }

    private fun use(id: String, name: String, vararg input: Pair<String, String>) = ToolUseBlock(id, name, JsonObject(input.associate { (k, v) -> k to JsonPrimitive(v) }))

    private fun shared(id: String, name: String, type: String = "image/png", title: String? = null) = ConclaveJson.decodeFromString(
        ContentBlock.serializer(),
        """{"type":"tool_result","toolUseId":"$id","content":"Shared","meta":{"file":{"name":"$name","mediaType":"$type","size":189542${title?.let { ",\"title\":\"$it\"" } ?: ""}}}}""",
    ) as ToolResultBlock

    private fun pic(id: String, data: String = "AAAA") = ConclaveJson.decodeFromString(
        ContentBlock.serializer(),
        """{"type":"tool_result","toolUseId":"$id","content":[{"type":"image","mediaType":"image/png","data":"$data"}]}""",
    ) as ToolResultBlock

    @Test
    fun aSharedPictureACallAlsoReturnedShowsOnceAsThatThumbnail() {
        val read = use("r", "Read", "file_path" to "/home/k/out/bar-final-right.png")
        val shot = use("b", "browser_screenshot")
        val share = use("s", "ShareFile", "path" to "/home/k/out/bar-final-right.png")
        val results = mapOf("r" to pic("r"), "b" to pic("b", "BBBB"), "s" to shared("s", "bar-final-right.png", title = "Real bar, right half at 1:1"))
        val rows = Media.rows(listOf(listOf(read, shot, share)), results, enabled = true)
        assertEquals(1, rows.size)
        val row = rows[0]
        assertEquals(listOf("r:0", "b:0"), row.map { it.key })
        // the Read's picture is the shared file: drawn from the call, opened from the hub, with the card's title
        assertTrue(row[0].shared)
        assertEquals("s", row[0].card.toolUseId)
        assertEquals("AAAA", row[0].block?.data)
        assertEquals("Real bar, right half at 1:1", row[0].caption)
        assertFalse(row[1].shared)
        assertEquals("browser_screenshot-1.png", row[1].card.name)
    }

    @Test
    fun toolPicturesComeFirstThenSharedPicturesEachOnce() {
        val shot = use("b", "browser_screenshot")
        val s1 = use("s1", "ShareFile")
        val s2 = use("s2", "ShareFile")
        val s3 = use("s3", "ShareFile")
        val doc = use("s4", "ShareFile")
        val results = mapOf(
            "b" to pic("b"),
            "s1" to shared("s1", "chart.png"),
            // the same file shared again: once
            "s2" to shared("s2", "out/Chart.PNG"),
            "s3" to shared("s3", "clip.mp4", "video/mp4"),
            "s4" to shared("s4", "report.pdf", "application/pdf"),
        )
        val row = Media.rows(listOf(listOf(s1, shot, s2, s3, doc)), results, enabled = true).single()
        assertEquals(listOf("b:0", "s1:", "s3:"), row.map { it.key })
        // the PDF is no thumbnail: it stays a compact card
        assertTrue(row.none { it.card.name == "report.pdf" })
    }

    @Test
    fun sharedPicturesStayWhenToolPicturesAreOffAndSitUnderTheirOwnGroup() {
        val read = use("r", "Read", "file_path" to "/o/a.png")
        val share = use("s", "ShareFile")
        val results = mapOf("r" to pic("r"), "s" to shared("s", "a.png"))
        val rows = Media.rows(listOf(listOf(read), listOf(share)), results, enabled = false)
        assertEquals(listOf(emptyList(), listOf("s:")), rows.map { r -> r.map { it.key } })
        // on: the Read in the first group already shows it, so the second group has none
        val on = Media.rows(listOf(listOf(read), listOf(share)), results, enabled = true)
        assertEquals(listOf(listOf("r:0"), emptyList()), on.map { r -> r.map { it.key } })
        assertTrue(on[0][0].shared)
    }

    @Test
    fun twoFilesOfOneNameInDifferentFoldersBothShow() {
        val readA = use("r1", "Read", "file_path" to "/a/chart.png")
        val readA2 = use("r2", "Read", "file_path" to "chart.png")
        val shareB = use("s", "ShareFile", "path" to "/b/chart.png")
        val results = mapOf("r1" to pic("r1"), "r2" to pic("r2"), "s" to shared("s", "chart.png"))
        val row = Media.rows(listOf(listOf(readA, readA2, shareB)), results, enabled = true).single()
        // the relative Read is the same /a/chart.png: once; the shared /b/chart.png is another file
        assertEquals(listOf("r1:0", "s:"), row.map { it.key })
        assertFalse(row[0].shared)
    }

    @Test
    fun aCallNamingNoPictureIsNeverMatchedOrMerged() {
        val shot1 = use("a", "browser_screenshot", "url" to "https://example.com/page")
        val shot2 = use("b", "browser_screenshot", "url" to "https://example.com/page")
        val row = Media.rows(listOf(listOf(shot1, shot2)), mapOf("a" to pic("a"), "b" to pic("b")), enabled = true).single()
        assertEquals(listOf("a:0", "b:0"), row.map { it.key })
        assertEquals("shot.png", Media.pictureSource(use("x", "WebFetch", "url" to "https://h/i/shot.png?w=2#top")))
        assertNull(Media.pictureSource(use("x", "Read", "file_path" to "/o/notes.md")))
    }

    @Test
    fun theCaptionIsTheTitleOnlyWhenItSaysMoreThanTheName() {
        val c = FileCardData("s", "bar-final-right.png", "image/png", 10)
        assertNull(FileCards.caption(c))
        assertNull(FileCards.caption(c.copy(title = "bar-final-right.png")))
        assertNull(FileCards.caption(c.copy(title = "Bar-Final-Right")))
        assertNull(FileCards.caption(c.copy(title = "  ")))
        assertEquals("Real bar, right half at 1:1", FileCards.caption(c.copy(title = "Real bar, right half at 1:1")))
    }
}
