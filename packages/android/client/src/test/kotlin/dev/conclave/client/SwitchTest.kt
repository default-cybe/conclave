package dev.conclave.client

import dev.conclave.client.logic.SwitchWords
import dev.conclave.client.model.SessionStats
import dev.conclave.client.model.SwitchEstimate
import dev.conclave.client.model.SwitchMath
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
 * A model switch's price step (logic/SwitchWords.kt) and its two calls:
 * GET switch-estimate and POST handoff with brief. The numbers are the
 * hub's worked example: 100K tokens from Opus 5.5 to Sonnet 5.5.
 */
class SwitchTest {
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

    private val body = """
        {"from":"anthropic/claude-opus-5-5","to":"anthropic/claude-sonnet-5-5","tokens":100000,"threshold":50000,"ttl":"1h",
         "full":{"tokens":100000,"onceUsd":0.4,"stayUsd":0.02,"replyUsd":0.042,"stayReplyUsd":0.084,"paybackReplies":9},
         "brief":{"tokens":35000,"onceUsd":0.14500000000000002,"stayUsd":0.02,"replyUsd":0.0355,"stayReplyUsd":0.084,"paybackReplies":3,"summaryUsd":0.005},
         "askUsd":0.037,"confirm":true,"suggestBrief":true,"priced":true,"later":"ignored"}
    """.trimIndent()

    @Test
    fun readsTheEstimateAndSendsBriefOnlyWhenPicked() = runBlocking {
        val client = ConclaveClient(server.url("/").toString(), "t")
        server.enqueue(MockResponse(body = body))
        val e = client.switchEstimate("s1", "anthropic/claude-sonnet-5-5")
        val req = server.takeRequest()
        assertEquals("/api/sessions/s1/switch-estimate", req.url.encodedPath)
        assertEquals("anthropic/claude-sonnet-5-5", req.url.queryParameter("model"))
        assertTrue(e.confirm)
        assertEquals(9, e.full.paybackReplies)
        assertEquals(35_000, e.brief!!.tokens)

        server.enqueue(MockResponse(body = """{"id":"s1","model":"anthropic/claude-sonnet-5-5"}"""))
        client.handoff("s1", "anthropic/claude-sonnet-5-5")
        assertEquals("""{"model":"anthropic/claude-sonnet-5-5"}""", server.takeRequest().body?.utf8())
        server.enqueue(MockResponse(body = """{"id":"s1","model":"anthropic/claude-sonnet-5-5"}"""))
        client.handoff("s1", "anthropic/claude-sonnet-5-5", brief = true)
        assertEquals("""{"model":"anthropic/claude-sonnet-5-5","brief":true}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun wordsMatchTheWeb() {
        val e = ConclaveJson.decodeFromString(SwitchEstimate.serializer(), body)
        assertEquals("About $0.40 once, pays back after about 9 replies", SwitchWords.priceLine(e.full))
        assertEquals("About $0.15 once, pays back after about 3 replies", SwitchWords.priceLine(e.brief!!))
        assertEquals("A short handover would save about $0.26 here.", SwitchWords.suggestion(e, briefPicked = false))
        assertNull(SwitchWords.suggestion(e, briefPicked = true))
        assertEquals("One answer from Sonnet 5.5, about $0.04", SwitchWords.askLine(e, "Sonnet 5.5"))
        assertEquals("This chat holds about 100k tokens. Sonnet 5.5 reads them with no cache on its first reply.", SwitchWords.sizeLine(e, "Sonnet 5.5"))
        assertEquals("About $0.80 once, and each reply costs more than staying", SwitchWords.priceLine(SwitchMath(onceUsd = 0.8)))
        assertEquals("About $0.01 once, cheaper than staying from the first reply", SwitchWords.priceLine(SwitchMath(onceUsd = 0.01, paybackReplies = 0)))
        assertEquals("under a cent", SwitchWords.usd(0.004))
        // the house words: no long dashes, and switch, not hand off
        val all = listOf(SwitchWords.priceLine(e.full), SwitchWords.BRIEF_DETAIL, SwitchWords.suggestion(e, false)!!).joinToString(" ")
        assertFalse(all.contains('\u2014') || all.contains('\u2013'))
        assertFalse(all.lowercase().contains("hand off"))
    }

    @Test
    fun anOlderHubSaysNothingAboutCacheWrites() {
        assertEquals(0, ConclaveJson.decodeFromString(SessionStats.serializer(), """{"messages":2}""").cacheWriteTokens)
        assertEquals(1234, ConclaveJson.decodeFromString(SessionStats.serializer(), """{"cacheWriteTokens":1234}""").cacheWriteTokens)
    }
}
