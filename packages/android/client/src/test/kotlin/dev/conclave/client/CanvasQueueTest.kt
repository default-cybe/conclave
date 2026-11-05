package dev.conclave.client

import dev.conclave.client.logic.Canvas
import dev.conclave.client.logic.CanvasFile
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Canvas's run queue on the hub: the routes, the bodies and the file keys match the web's. */
class CanvasQueueTest {
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

    @Test
    fun listReadsTheQueueForOneFile() = runBlocking {
        server.enqueue(
            MockResponse(
                body = """[{"id":"cq_1","file":"workflow:review","kind":"workflow","workflow":"review","args":{"pr":3},"createdAt":5,"future":1},
                {"id":"cq_2","file":"program:ses_1:fetch","kind":"program","sessionId":"ses_1","flow":"fetch","createdAt":6}]""",
            ),
        )
        val q = client().canvasQueue("workflow:review")
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/canvas/queue", req.url.encodedPath)
        assertEquals("workflow:review", req.url.queryParameter("file"))
        assertEquals(listOf("cq_1", "cq_2"), q.map { it.id })
        assertEquals("program", q[1].kind)
        assertEquals("fetch", q[1].flow)
        assertNull(q[1].args)
    }

    @Test
    fun listWithNoFileSendsNoQuery() = runBlocking {
        server.enqueue(MockResponse(body = "[]"))
        assertEquals(0, client().canvasQueue().size)
        assertNull(server.takeRequest().url.query)
    }

    @Test
    fun queueAWorkflowWithAndWithoutArgs() = runBlocking {
        server.enqueue(MockResponse(code = 201, body = """{"id":"cq_1","file":"workflow:review","kind":"workflow","workflow":"review","createdAt":1}"""))
        server.enqueue(MockResponse(code = 201, body = """{"id":"cq_2","file":"workflow:review","kind":"workflow","workflow":"review","createdAt":2}"""))
        val c = client()
        assertEquals("cq_1", c.queueWorkflowRun("review", buildJsonObject { put("pr", JsonPrimitive(3)) }).id)
        val a = server.takeRequest()
        assertEquals("POST", a.method)
        assertEquals("/api/canvas/queue", a.url.encodedPath)
        assertEquals("""{"workflow":"review","args":{"pr":3}}""", a.body?.utf8())
        c.queueWorkflowRun("review", JsonNull)
        assertEquals("""{"workflow":"review"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun queueAProgram() = runBlocking {
        server.enqueue(MockResponse(code = 201, body = """{"id":"cq_3","file":"program:ses_1:fetch","kind":"program","sessionId":"ses_1","flow":"fetch","createdAt":1}"""))
        assertEquals("program:ses_1:fetch", client().queueFlowRun("ses_1", "fetch").file)
        assertEquals("""{"sessionId":"ses_1","flow":"fetch"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun cancelDeletesByIdAndTakesAnEmpty204() = runBlocking {
        server.enqueue(MockResponse(code = 204))
        client().cancelCanvasRun("cq 1")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/canvas/queue/cq%201", req.url.encodedPath)
    }

    @Test
    fun queueFileKeysMatchTheHub() {
        assertEquals("workflow:review", Canvas.queueFile(CanvasFile.Workflow("review", "Review", CanvasFile.Group.YOURS), null))
        val p = CanvasFile.Program("fetch", "dev", "/code", "ses_old")
        assertEquals("program:ses_new:fetch", Canvas.queueFile(p, "ses_new"))
        assertEquals("program:ses_old:fetch", Canvas.queueFile(p, null))
    }
}
