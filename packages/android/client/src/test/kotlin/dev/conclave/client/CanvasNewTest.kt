package dev.conclave.client

import dev.conclave.client.logic.Canvas
import dev.conclave.client.logic.CanvasFile
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import java.io.IOException
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Canvas's New on the phone: POST /api/canvas/programs, the file it opens, and a member's 400 asking for a folder. */
class CanvasNewTest {
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

    private val made = """{"sessionId":"ses_1","device":"local","cwd":"/srv/projects/canvas/owner","view":{"name":"untitled-1","path":"flows/untitled-1.flow.ts","graph":{"name":"untitled-1","phases":[],"nodes":[],"edges":[]}}}"""

    @Test
    fun theOwnersNewSendsNoFolderAndOpensTheBlankFile() = runBlocking {
        server.enqueue(MockResponse(code = 201, body = made))
        val m = client().newCanvasProgram()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/canvas/programs", req.url.encodedPath)
        assertEquals("{}", req.body?.utf8())
        assertEquals("untitled-1", m.view.name)
        assertEquals(0, m.view.graph.nodes.size)
        assertEquals(CanvasFile.Program("untitled-1", "local", "/srv/projects/canvas/owner", "ses_1"), Canvas.newFile(m))
        assertEquals("/canvas/program/untitled-1?device=local&cwd=%2Fsrv%2Fprojects%2Fcanvas%2Fowner", Canvas.webPath(Canvas.newFile(m)))
    }

    @Test
    fun aMembersNewNamesTheDeviceAndFolder() = runBlocking {
        server.enqueue(MockResponse(code = 201, body = made.replace("\"local\"", "\"dev_1\"")))
        assertEquals("dev_1", client().newCanvasProgram("dev_1", "~/code/app").device)
        assertEquals("""{"device":"dev_1","cwd":"~/code/app"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun aFourHundredWithNoFolderAsksForOne() = runBlocking {
        server.enqueue(MockResponse(code = 400, body = """{"error":"Your programs live on a computer you paired: pick a folder there (New in folder)."}"""))
        val e = assertFailsWith<ConclaveApiException> { client().newCanvasProgram() }
        assertEquals(400, e.status)
        assertTrue(Canvas.asksFolder(e))
        assertFalse(Canvas.asksFolder(ConclaveApiException(404, "Device dev_x not found")))
        assertFalse(Canvas.asksFolder(IOException("offline")))
    }
}
