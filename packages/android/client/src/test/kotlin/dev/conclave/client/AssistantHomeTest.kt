package dev.conclave.client

import dev.conclave.client.logic.Drawer
import dev.conclave.client.logic.GroupBy
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AssistantHomeTest {
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

    private fun client() = ConclaveClient(server.url("/").toString(), "secret-token")

    @Test
    fun assistantHomeReadsTheHomeSession() = runBlocking {
        server.enqueue(MockResponse(body = """{"id":"h1","title":"Assistant","agent":"assistant","pinned":true,"meta":{"home":true}}"""))
        val s = client().assistantHome()
        assertEquals("h1", s?.id)
        assertTrue(s != null && Drawer.isHome(s))
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/assistant/home", req.url.encodedPath)
    }

    @Test
    fun anOlderHubWithoutTheRouteGivesNull() = runBlocking {
        server.enqueue(MockResponse(code = 404, body = """{"error":"Not found"}"""))
        assertNull(client().assistantHome())
    }

    @Test
    fun otherErrorsStillThrow() {
        server.enqueue(MockResponse(code = 500, body = """{"error":"boom"}"""))
        val e = assertFailsWith<ConclaveApiException> { runBlocking { client().assistantHome() } }
        assertEquals(500, e.status)
    }

    private val homeMeta = buildJsonObject { put("home", true) }

    private fun assistant(id: String, updated: Long, pinned: Boolean = false) =
        Session(id, title = id, agent = Start.ASSISTANT_AGENT, device = "local", pinned = pinned, updatedAt = updated)

    @Test
    fun assistantModeShowsTheHomeThreadFirstAndTheRestUnderHistory() {
        val sessions = listOf(
            assistant("old", 1),
            assistant("home", 2, pinned = true).copy(title = "Assistant", meta = homeMeta),
            assistant("pinnedOne", 3, pinned = true),
            Session("chat", title = "chat", kind = SessionKind.CHAT, updatedAt = 4),
        )
        val groups = Drawer.groups(sessions, StartMode.ASSISTANT, GroupBy.TIME)
        assertEquals(listOf(Drawer.HOME, Drawer.HISTORY), groups.map { it.key })
        assertEquals(listOf("Assistant", "History"), groups.map { it.title })
        assertEquals(listOf("home"), groups[0].items.map { it.id })
        assertEquals(listOf("pinnedOne", "old"), groups[1].items.map { it.id })
    }

    @Test
    fun withoutAHomeThreadAssistantModeGroupsAsBefore() {
        val sessions = listOf(assistant("a", 1), assistant("p", 2, pinned = true))
        val groups = Drawer.groups(sessions, StartMode.ASSISTANT, GroupBy.TIME)
        assertEquals(Drawer.PINNED, groups.first().key)
        assertTrue(groups.none { it.key == Drawer.HOME || it.key == Drawer.HISTORY })
    }

    @Test
    fun anArchivedHomeThreadIsNotTheHome() {
        val archived = assistant("home", 1).copy(meta = homeMeta, archived = true)
        assertNull(Drawer.homeOf(listOf(archived)))
        assertEquals("home", Drawer.homeOf(listOf(archived.copy(archived = false)))?.id)
    }
}
