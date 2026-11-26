package dev.conclave.client

import dev.conclave.client.logic.BlockRef
import dev.conclave.client.logic.Media
import dev.conclave.client.logic.Transcript
import dev.conclave.client.logic.TranscriptReducer
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.Role
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ToolResultBlock
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A big chat on Android (a 90 MB transcript of screenshots ended the app):
 * the newest page comes light (trim=1), older pages come on scroll with
 * beforeSeq, and a picture the page left out is read from its block only
 * when it shows. The same paged API as the web (store.ts PAGE, loadOlder).
 */
class PagingTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    private fun client() = ConclaveClient(server.url("/").toString(), "t")

    private fun msg(seq: Long) = Message(id = "m$seq", sessionId = "s1", seq = seq, role = Role.USER, content = listOf(TextBlock("$seq")))

    @Test
    fun readsTheNewestPageLightAndMarksWhatItCut() = runBlocking {
        server.enqueue(MockResponse(body = """[
            {"id":"m1","sessionId":"s1","seq":1,"role":"user","content":[{"type":"text","text":"hi"},{"type":"image","mediaType":"image/png"}],"meta":{"trimmed":[{"index":1,"bytes":4000000}]}},
            {"id":"m2","sessionId":"s1","seq":2,"role":"user","content":[{"type":"tool_result","toolUseId":"t1","content":[{"type":"text","text":"shot"},{"type":"image","mediaType":"image/png"}]}],"meta":{"trimmed":[{"index":0,"bytes":5000000}]}},
            {"id":"m3","sessionId":"s1","seq":3,"role":"user","content":[{"type":"image","mediaType":"image/png","data":"AAAA"}]}
        ]"""))
        val list = client().messages("s1", limit = TranscriptReducer.PAGE, trim = true)
        val url = server.takeRequest().url
        assertEquals("/api/sessions/s1/messages", url.encodedPath)
        assertEquals("200", url.queryParameter("limit"))
        assertEquals("1", url.queryParameter("trim"))
        assertNull(url.queryParameter("afterSeq"))

        // a cut picture names its block; a small one keeps its data and gets no ref
        val img = list[0].content[1] as ImageBlock
        assertEquals(BlockRef("s1", "m1", 1), BlockRef.of(img.url))
        assertEquals("AAAA", (list[2].content[0] as ImageBlock).data)
        assertNull((list[2].content[0] as ImageBlock).url)

        // a tool's picture names its part, and still shows as a thumbnail
        val shots = Media.toolImages(list[1].content[0] as ToolResultBlock)
        assertEquals(1, shots.size)
        assertNull(shots[0].data)
        assertEquals(BlockRef("s1", "m2", 0, 1), BlockRef.of(shots[0].url))
    }

    @Test
    fun aWholeReadStaysAsItWas() = runBlocking {
        server.enqueue(MockResponse(body = """[{"id":"m1","sessionId":"s1","seq":1,"role":"user","content":[]}]"""))
        client().messages("s1", afterSeq = 7)
        val url = server.takeRequest().url
        assertEquals("7", url.queryParameter("afterSeq"))
        assertNull(url.queryParameter("limit"))
        assertNull(url.queryParameter("trim"))
        assertNull(url.queryParameter("beforeSeq"))
    }

    @Test
    fun readsACutPictureFromItsBlock() = runBlocking {
        server.enqueue(MockResponse(body = """{"type":"image","mediaType":"image/png","data":"QUJD"}"""))
        assertEquals("QUJD", client().blockData(BlockRef("s1", "m1", 1)))
        assertEquals("/api/sessions/s1/messages/m1/blocks/1", server.takeRequest().url.encodedPath)

        server.enqueue(MockResponse(body = """{"type":"tool_result","toolUseId":"t1","content":[{"type":"text","text":"shot"},{"type":"image","mediaType":"image/png","data":"WFla"}]}"""))
        assertEquals("WFla", client().blockData(BlockRef("s1", "m2", 0, 1)))
        assertEquals("/api/sessions/s1/messages/m2/blocks/0", server.takeRequest().url.encodedPath)
    }

    @Test
    fun refsRoundTripAndOtherUrlsAreNotRefs() {
        val ref = BlockRef("ses_0mwubt3145w1mp4ql0k", "msg_1", 3, 2)
        assertEquals(ref, BlockRef.of(ref.url))
        assertEquals(BlockRef("s", "m", 0), BlockRef.of(BlockRef("s", "m", 0).url))
        assertNull(BlockRef.of("https://example.com/a.png"))
        assertNull(BlockRef.of(null))
        assertNull(BlockRef.of("conclave-block:s/m/x"))
    }

    @Test
    fun pagesBackToTheStart() {
        // a full newest page: older messages wait, read before the first one held
        val newest = (101L..300L).map(::msg)
        var t = TranscriptReducer.loaded(Transcript("s1"), newest, paged = true)
        assertTrue(t.older)
        assertEquals(101L, TranscriptReducer.olderBefore(t))

        // a short older page: the start, and nothing more to read
        t = TranscriptReducer.olderPage(t, (1L..100L).map(::msg))
        assertFalse(t.older)
        assertNull(TranscriptReducer.olderBefore(t))
        assertEquals((1L..300L).toList(), t.messages.map { it.seq })
    }

    @Test
    fun aFullOlderPageKeepsGoingAndAShortChatHasNone() {
        var t = TranscriptReducer.loaded(Transcript("s1"), (401L..600L).map(::msg), paged = true)
        t = TranscriptReducer.olderPage(t, (201L..400L).map(::msg))
        assertTrue(t.older)
        assertEquals(201L, TranscriptReducer.olderBefore(t))

        // a chat shorter than a page is whole at once
        val short = TranscriptReducer.loaded(Transcript("s1"), (1L..5L).map(::msg), paged = true)
        assertFalse(short.older)
        assertNull(TranscriptReducer.olderBefore(short))

        // a reload after a reconnect (afterSeq) leaves what the paging knew
        val again = TranscriptReducer.loaded(t, listOf(msg(601)), paged = false)
        assertTrue(again.older)
        assertEquals(601L, again.lastSeq)
    }
}
