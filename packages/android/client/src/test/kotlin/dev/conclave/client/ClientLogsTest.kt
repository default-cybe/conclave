package dev.conclave.client

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** What the app reports about itself to the hub's logs (docs/DESIGN.md 33): batched, capped, deduplicated, never chat text. */
class ClientLogsTest {
    private lateinit var server: MockWebServer
    private var now = 1_800_000_000_000L

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        ClientLogs.batcher = null
    }

    @AfterTest
    fun tearDown() {
        ClientLogs.batcher = null
        server.close()
    }

    private fun batcher(send: suspend (ClientLogBatch) -> Unit) = LogBatcher(version = "1.2.3", platform = "Android 16", clock = { now }, send = send)

    @Test
    fun batchesGoWithTheAppVersionAndPlatform() = runBlocking {
        val sent = mutableListOf<ClientLogBatch>()
        val b = batcher { sent += it }
        b.log("info", "connect", mapOf("attempt" to 0))
        b.log("warn", "request.failed", mapOf("status" to 502, "path" to "/api/x"), "Hub error 502")
        assertTrue(b.flush())
        assertEquals(1, sent.size)
        assertEquals("android", sent[0].app)
        assertEquals("1.2.3", sent[0].version)
        assertEquals("Android 16", sent[0].platform)
        assertEquals(listOf("connect", "request.failed"), sent[0].events.map { it.event })
        assertEquals(JsonPrimitive(502), sent[0].events[1].fields!!["status"])
        assertEquals("Hub error 502", sent[0].events[1].msg)
        assertEquals(0, b.pending)
    }

    @Test
    fun theSameEventSoonCountsOnTheFirstAndTheMinuteIsCapped() {
        val b = batcher { }
        repeat(5) { b.log("error", "js.error", msg = "boom") }
        assertEquals(1, b.pending)
        repeat(100) { b.log("info", "e$it") }
        assertEquals(60, b.pending)
        assertEquals(41, b.droppedCount)
        // a minute later there is room again
        now += 61_000
        b.log("info", "later")
        assertEquals(61, b.pending)
    }

    @Test
    fun theQueueKeepsAtMost200() {
        val b = LogBatcher(clock = { now }, perMinute = 1000) { }
        repeat(300) { b.log("info", "e$it") }
        assertEquals(200, b.pending)
        assertEquals(100, b.droppedCount)
    }

    @Test
    fun theDroppedCountGoesInTheNextBatch() = runBlocking {
        val sent = mutableListOf<ClientLogBatch>()
        val b = LogBatcher(clock = { now }, perMinute = 2) { sent += it }
        repeat(5) { b.log("info", "e$it") }
        b.flush()
        val last = sent.single().events.last()
        assertEquals("log.dropped", last.event)
        assertEquals(3, last.fields!!["dropped"]!!.int)
    }

    @Test
    fun anOlderHubStopsTheSendingAServerErrorKeepsTheEventsABadRequestDropsThem() = runBlocking {
        var status = 503
        val b = batcher { throw ConclaveApiException(status, "no") }
        b.log("info", "connect")
        assertFalse(b.flush())
        assertEquals(1, b.pending)
        status = 400
        assertFalse(b.flush())
        assertEquals(0, b.pending)
        b.log("info", "again")
        status = 404
        b.flush()
        assertTrue(b.off)
        b.log("info", "after")
        assertEquals(0, b.pending)
    }

    @Test
    fun offlineKeepsThem() = runBlocking {
        val b = batcher { throw java.io.IOException("no route to host") }
        b.log("info", "connect")
        assertFalse(b.flush())
        assertEquals(1, b.pending)
    }

    @Test
    fun fieldsAreSmallAndFlat() = runBlocking {
        val sent = mutableListOf<ClientLogBatch>()
        val b = batcher { sent += it }
        val many = (0 until 20).associate { "k$it" to it } + mapOf("long" to "x".repeat(500), "none" to null)
        b.log("info", "e".repeat(100), many, "m".repeat(1000))
        b.flush()
        val e = sent.single().events.single()
        assertEquals(64, e.event.length)
        assertEquals(240, e.msg!!.length)
        assertEquals(12, e.fields!!.size)
    }

    @Test
    fun pathsLoseTheirIds() {
        assertEquals("/api/sessions/:id/messages", ClientLogs.foldPath(listOf("api", "sessions", "ses_0mvhhgjec6noz", "messages")))
        assertEquals("/api/devices/:id/files", ClientLogs.foldPath(listOf("api", "devices", "3f2b8c1e-0000-4000-8000-123456789abc", "files")))
        assertEquals("/api/logs", ClientLogs.foldPath(listOf("api", "logs")))
    }

    @Test
    fun aFailedCallIsReportedWithItsFoldedPathAndStatusAndTheLogsRouteIsNot() = runBlocking {
        val b = batcher { }
        ClientLogs.batcher = b
        server.enqueue(MockResponse(code = 502, body = """{"error":"bad gateway"}"""))
        val c = ConclaveClient(server.url("/").toString(), "t")
        assertFailsWith<ConclaveApiException> { c.getSession("ses_abcdef123") }
        server.enqueue(MockResponse(code = 500, body = "{}"))
        assertFailsWith<ConclaveApiException> { c.sendClientLogs(ClientLogBatch(app = "android", events = emptyList())) }
        assertEquals(1, b.pending)
        val sent = mutableListOf<ClientLogBatch>()
        val probe = LogBatcher(clock = { now }) { sent += it }
        ClientLogs.batcher = probe
        server.enqueue(MockResponse(code = 404, body = """{"error":"not found"}"""))
        assertFailsWith<ConclaveApiException> { c.getSession("ses_zzzzzz999") }
        probe.flush()
        val e = sent.single().events.single()
        assertEquals("request.failed", e.event)
        assertEquals("info", e.level)
        assertEquals(JsonPrimitive("/api/sessions/:id"), e.fields!!["path"])
        assertEquals(JsonPrimitive(404), e.fields!!["status"])
        assertEquals("not found", e.msg)
    }

    @Test
    fun sendClientLogsPostsTheBatchWithTheToken() = runBlocking {
        server.enqueue(MockResponse(code = 200, body = """{"accepted":1,"dropped":0}"""))
        val c = ConclaveClient(server.url("/").toString(), "tok")
        val r = c.sendClientLogs(ClientLogBatch(app = "android", version = "1", platform = "Android 16", events = listOf(ClientLogEvent(ts = 1, level = "info", event = "connect"))))
        assertEquals(ClientLogResult(1, 0), r)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/logs/client", req.url.encodedPath)
        assertEquals("Bearer tok", req.headers["Authorization"])
        val body = Json.parseToJsonElement(req.body!!.utf8()).jsonObject
        assertEquals("android", body["app"]!!.jsonPrimitive.content)
        assertEquals("connect", body["events"]!!.jsonArray[0].jsonObject["event"]!!.jsonPrimitive.content)
        assertNull(body["events"]!!.jsonArray[0].jsonObject["msg"])
    }
}
