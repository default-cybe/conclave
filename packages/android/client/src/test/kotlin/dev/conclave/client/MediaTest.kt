package dev.conclave.client

import dev.conclave.client.logic.FileCardData
import dev.conclave.client.logic.Media
import dev.conclave.client.logic.MediaKind
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.ToolResultBlock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

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
}
