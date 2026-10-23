package dev.conclave.client

import dev.conclave.client.logic.FileCardData
import dev.conclave.client.logic.FileCards
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
    fun theCachedCopyStaysInItsFolder() {
        val card = FileCardData("t", "../../.ssh/id ed25519?.txt", "text/plain", 1)
        assertEquals("id ed25519_.txt", FileCards.cacheName(card))
        assertEquals("file", FileCards.cacheName(card.copy(name = "...")))
        assertEquals("______x", FileCards.cacheFolder(card.copy(toolUseId = "../../x")))
    }
}
