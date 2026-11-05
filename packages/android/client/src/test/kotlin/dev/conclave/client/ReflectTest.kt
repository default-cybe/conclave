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
    fun theReportReadsEachRangeAndRefreshPosts() = runBlocking {
        val body = """{"range":"month","start":1761804000000,"end":1762365600001,"timezone":"UTC","generatedAt":1,"insights":"basic","headline":"Busy month.",
            "totals":{"chats":12,"sessions":1,"workflows":0,"hoursActive":3.5,"tokens":3200000,"costUsd":4,"projects":2},
            "work":{"topics":[],"projects":[{"name":"conclave","sessions":4,"example":"Reflect"}],"newThisPeriod":[]},
            "rhythm":{"heatmap":[[0,1]],"messages":100,"activeDays":4,"longestStreak":1,"busiestDay":{"date":"2026-11-03","count":40},"lateNightShare":0.27},
            "habits":[{"key":"diligence","observation":"You ran 2 review sessions."}],
            "models":{"models":[{"name":"cliproxy/claude-opus-5-5","calls":3,"tokens":100,"costUsd":0}],"agents":[],"fallbacks":3,"topFallback":"cliproxy/claude-opus-5-5 to anthropic/claude-sonnet-5-5","switches":0,"finishedTurns":0},
            "fun":{"newPeople":[],"memoriesAdded":2,"skillsLearned":[],"goalsMoved":1,"goalsDone":0},"suggestions":[],"question":"","excluded":{"health":0,"incognito":1}}"""
        server.enqueue(MockResponse(body = body))
        val r = client().reflectReport("month")
        val get = server.takeRequest()
        assertEquals("/api/reflect/report", get.url.encodedPath)
        assertEquals("month", get.url.queryParameter("range"))
        assertEquals("Busy month.", r.headline)
        assertEquals("diligence", r.habits[0].key)
        server.enqueue(MockResponse(body = body))
        client().reflectRefresh("month")
        val post = server.takeRequest()
        assertEquals("POST", post.method)
        assertEquals("/api/reflect/report/refresh", post.url.encodedPath)

        // the late-night share is said once, and models read as in the model picker
        val stats = ReflectWords.rhythm(r.rhythm)
        assertEquals("4 active days, longest streak 1 day, busiest Tue 3 Nov with 40 messages.", stats)
        assertEquals(1, Regex("27%").findAll(stats + ReflectWords.lateLine(r.rhythm.lateNightShare, r.rhythm.messages)).count())
        assertEquals("3 fallbacks, most often Opus 5.5 to Sonnet 5.5.", ReflectWords.modelsLine(r.models))
        assertTrue(ReflectWords.modelLine(r.models.models[0].name).startsWith("Opus 5.5"))
        assertEquals(listOf("13", "3.5", "3.2M", "2"), ReflectWords.bigNumbers(r.totals).map { it.first })
        assertEquals("Left out: 1 incognito chat. Only titles and short summaries are read, never mail, files or tool output.", ReflectWords.excluded(r.excluded))
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
