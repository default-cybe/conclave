package dev.conclave.client

import dev.conclave.client.logic.Inbox
import dev.conclave.client.model.AlertAction
import dev.conclave.client.model.AlertItem
import dev.conclave.client.model.AlertSessionRef
import dev.conclave.client.model.EngineEvent
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Alerts (docs/DESIGN.md 28): the hub's events and replies decode, the calls match the routes, and the rows say the web's words. */
class AlertsTest {
    private lateinit var server: MockWebServer
    private val min = 60_000L
    private val t0 = 1_800_000_000_000L

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

    private val conflict = AlertItem(
        id = "alrt_c",
        kind = "fileConflict",
        sessionId = "ses_b",
        text = "'Fix login' and 'Refactor auth' are both editing src/auth/redirect.ts",
        createdAt = t0,
        sessions = listOf(AlertSessionRef("ses_a", "Fix login"), AlertSessionRef("ses_b", "Refactor auth")),
        device = "local",
        path = "/repo/src/auth/redirect.ts",
        file = "src/auth/redirect.ts",
    )
    private val idle = AlertItem(
        id = "alrt_i",
        kind = "stuck",
        reason = "idle",
        sessionId = "ses_a",
        text = "No progress in 'Fix login' for 5 min",
        sessions = listOf(AlertSessionRef("ses_a", "Fix login")),
        since = t0 - 5 * min,
        thresholdMs = 5 * min,
    )
    private val loop = AlertItem(id = "alrt_l", kind = "stuck", reason = "loop", sessionId = "ses_a", text = "'Fix login' may be in a loop: Bash failed the same way 3 times", tool = "Bash", count = 3, error = "Exit code 3")

    @Test
    fun raisedAndClearedEventsDecode() {
        val raised = Frame.parse(
            """{"type":"alert.raised","seq":3,"ts":1,"alert":{"id":"alrt_c","kind":"fileConflict","sessionId":"ses_b",
            "text":"'Fix login' and 'Refactor auth' are both editing src/auth/redirect.ts","createdAt":1,"updatedAt":2,
            "sessions":[{"id":"ses_a","title":"Fix login"},{"id":"ses_b","title":"Refactor auth"}],
            "device":"local","path":"/repo/src/auth/redirect.ts","file":"src/auth/redirect.ts","newField":true}}""",
        )
        val e = (raised as Frame.Event).envelope.event as EngineEvent.AlertRaised
        assertEquals("ses_b", e.sessionKey)
        assertTrue(e.alert.isConflict)
        assertEquals(listOf("Fix login", "Refactor auth"), e.alert.sessions.map { it.title })
        assertEquals("src/auth/redirect.ts", e.alert.file)

        val stuck = Frame.parse("""{"type":"alert.raised","seq":4,"ts":1,"alert":{"id":"alrt_l","kind":"stuck","reason":"loop","sessionId":"ses_a","tool":"Bash","count":3}}""")
        val s = ((stuck as Frame.Event).envelope.event as EngineEvent.AlertRaised).alert
        assertTrue(s.isLoop)
        assertFalse(s.isConflict)
        assertEquals(3, s.count)

        val cleared = Frame.parse("""{"type":"alert.cleared","seq":5,"ts":1,"id":"alrt_c","sessionId":"ses_b"}""")
        val c = (cleared as Frame.Event).envelope.event as EngineEvent.AlertCleared
        assertEquals("alrt_c", c.id)
        assertEquals("ses_b", c.sessionKey)
    }

    @Test
    fun listAndActOnAlerts() = runBlocking {
        server.enqueue(MockResponse(body = """[{"id":"alrt_i","kind":"stuck","reason":"idle","sessionId":"ses_a","text":"No progress","since":1,"thresholdMs":300000}]"""))
        val list = client().alerts()
        assertEquals("/api/alerts", server.takeRequest().url.encodedPath)
        assertEquals(300_000L, list.single().thresholdMs)

        server.enqueue(MockResponse(body = """{"ok":true}"""))
        client().alertAction("alrt_i", AlertAction.WAIT)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/alerts/alrt_i", req.url.encodedPath)
        assertEquals("""{"action":"wait"}""", req.body?.utf8())

        server.enqueue(MockResponse(code = 404, body = """{"error":"This alert is not open any more."}"""))
        val err = runCatching { client().alertAction("alrt_gone", AlertAction.STOP) }.exceptionOrNull() as ConclaveApiException
        assertEquals(404, err.status)
        assertEquals("This alert is not open any more.", err.message)
    }

    @Test
    fun rowsSayTheWebsWords() {
        assertEquals("1 min", Inbox.alertMinutes(20_000))
        assertEquals("6 min", Inbox.alertMinutes(6 * min + 59_000))
        // a quiet turn keeps counting; the rest keep the hub's sentence
        assertEquals("No progress in 'Fix login' for 6 min", Inbox.alertText(idle, t0 + min))
        assertEquals(loop.text, Inbox.alertText(loop, t0))
        assertEquals(conflict.text, Inbox.alertText(conflict, t0))

        assertEquals("'Fix login' is editing redirect.ts too", Inbox.alertLine(conflict, t0))
        assertEquals("Another chat is editing redirect.ts too", Inbox.alertLine(conflict.copy(sessions = emptyList()), t0))
        assertEquals("No progress for 7 min", Inbox.alertLine(idle, t0 + 2 * min))
        assertEquals("Bash failed the same way 3 times", Inbox.alertLine(loop, t0))

        assertEquals(listOf("Dismiss"), Inbox.alertActions(conflict).map { it.label })
        assertEquals(listOf("Stop", "Keep waiting"), Inbox.alertActions(idle).map { it.label })
        assertEquals(listOf("stop", "wait"), Inbox.alertActions(loop).map { it.wire })
    }
}
