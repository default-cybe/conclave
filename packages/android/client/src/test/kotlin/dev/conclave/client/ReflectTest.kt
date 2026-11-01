package dev.conclave.client

import dev.conclave.client.logic.ApiValue
import dev.conclave.client.logic.ContextUse
import dev.conclave.client.logic.ReflectWords
import dev.conclave.client.model.ReflectPatch
import dev.conclave.client.model.ReflectRun
import dev.conclave.client.model.UsageBucket
import dev.conclave.client.model.UsageSummary
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Settings > Reflect on the phone, and what plan use is worth at API prices on Usage. */
class ReflectTest {
    private lateinit var server: MockWebServer
    private val utc = ZoneId.of("UTC")

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

    private val reflectJson = """
        {"enabled":true,"time":"02:40","schedule":"40 2 * * *","timezone":"Europe/Berlin","model":"fast","routineId":"rtn_1","nextRunAt":2,
         "last":{"id":"run_1","status":"ok","trigger":"schedule","startedAt":1,"saved":2,"retired":1,"sessionId":"ses_1"},
         "notes":[{"id":"mem_1","scope":"agent","scopeKey":"assistant","kind":"procedure","content":"The owner wants the command first.","tags":["reflection"],"createdAt":1,"updatedAt":1}],
         "somethingNew":1}
    """.trimIndent()

    @Test
    fun reflectReadsTheSwitchTheLastRunAndTheNotes() = runBlocking {
        server.enqueue(MockResponse(body = reflectJson))
        val r = client().reflect()
        assertEquals("/api/assistant/reflect", server.takeRequest().url.encodedPath)
        assertTrue(r.enabled)
        assertEquals("02:40", r.time)
        assertEquals(listOf("The owner wants the command first."), r.notes.map { it.content })
        assertEquals(2, r.last?.saved)
        assertEquals("The small model", ReflectWords.model(r.model))
        assertEquals("Every night at 02:40, Europe/Berlin.", ReflectWords.time(r))
    }

    @Test
    fun theSwitchAndReflectNowHitTheRoutes() = runBlocking {
        server.enqueue(MockResponse(body = reflectJson))
        client().setReflect(ReflectPatch(enabled = false))
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/api/assistant/reflect", put.url.encodedPath)
        // only what is set goes: the time and model stay as they are
        assertEquals("""{"enabled":false}""", put.body?.utf8())

        server.enqueue(MockResponse(body = """{"skipped":"No chats since the last reflection","reflect":$reflectJson}"""))
        val now = client().reflectNow()
        val post = server.takeRequest()
        assertEquals("POST", post.method)
        assertEquals("/api/assistant/reflect/run", post.url.encodedPath)
        assertEquals("No chats since the last reflection", now.skipped)
        assertNull(now.run)
    }

    @Test
    fun theLastRunInWords() {
        val now = ZonedDateTime.of(2026, 10, 23, 9, 0, 0, 0, utc).toInstant().toEpochMilli()
        val at = ZonedDateTime.of(2026, 10, 23, 2, 40, 0, 0, utc).toInstant().toEpochMilli()
        val run = ReflectRun(id = "r", status = "ok", startedAt = at, saved = 2, retired = 1)
        assertEquals("Last ran 02:40, saved 2 notes, retired 1.", ReflectWords.lastRun(run, now, utc))
        assertEquals("Last ran 02:40, saved 1 note.", ReflectWords.lastRun(run.copy(saved = 1, retired = 0), now, utc))
        assertEquals("Last ran 02:40, skipped: no chats since the last reflection.", ReflectWords.lastRun(run.copy(status = "skipped", reason = "No chats since the last reflection"), now, utc))
        assertEquals("Last ran 02:40 (Reflect now), saved 2 notes, retired 1.", ReflectWords.lastRun(run.copy(trigger = "manual"), now, utc))
        assertEquals("Last ran yesterday 02:40, nothing new to keep.", ReflectWords.lastRun(run.copy(saved = 0, retired = 0, startedAt = at - 86_400_000), now, utc))
        assertEquals("Has not run yet.", ReflectWords.lastRun(null, now, utc))
        assertFalse(ReflectWords.LINE.contains('\u2014'))
    }

    @Test
    fun planUseIsWorthItsApiPrice() {
        val s = ConclaveJson.decodeFromString(
            UsageSummary.serializer(),
            """{"from":0,"to":1,"totals":{"key":"total","costUsd":128.4,"apiValueUsd":340.15,"estimatedUsd":4,"calls":10},
               "byAccount":[{"key":"claude-a","costUsd":0,"apiValueUsd":95.6,"calls":3},{"key":"api-anthropic","costUsd":38.59,"apiValueUsd":38.59,"calls":5}],
               "savedUsd":211.75}""",
        )
        assertEquals("Your plans saved you about $212 this month", ApiValue.savedSentence(s.totals))
        assertTrue(ApiValue.savedDetail(s.totals).startsWith("Worth $340 at API prices, billed $128."))
        assertEquals("Billed $0, worth $95.60 at API prices", ApiValue.billedLine(s.byAccount[0].costUsd, s.byAccount[0].apiValueUsd))
        // a key is worth what it billed
        assertEquals("Billed $38.59", ApiValue.billedLine(s.byAccount[1].costUsd, s.byAccount[1].apiValueUsd))
        // a hub before values were kept says nothing more
        assertNull(ApiValue.savedSentence(UsageBucket(costUsd = 5.0)))
        assertEquals(211.75, s.savedUsd)
    }

    @Test
    fun aPlanSessionSaysWhatItIsWorth() {
        val plan = ContextUse(used = 0, window = 0, tokensIn = 10, tokensOut = 2, costUsd = 0.0, plan = true, session = true, apiValueUsd = 1.2)
        assertEquals("plan, worth $1.20 at API prices", plan.costLine)
        val key = ContextUse(used = 0, window = 0, tokensIn = 10, tokensOut = 2, costUsd = 0.5, plan = false, session = true, apiValueUsd = 0.5)
        assertEquals("$0.50", key.costLine)
    }
}
