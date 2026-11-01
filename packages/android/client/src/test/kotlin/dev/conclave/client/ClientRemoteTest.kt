package dev.conclave.client

import dev.conclave.client.model.RemoteMode
import dev.conclave.client.model.RemoteState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Headers
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientRemoteTest {
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

    private fun client(token: String? = "tok") = ConclaveClient(server.url("/").toString(), token)

    @Test
    fun readsAndChangesRemoteAccess() = runBlocking {
        server.enqueue(MockResponse(body = """{"mode":"quick","state":"starting","since":1,"detail":"Waiting for Cloudflare","addresses":[{"url":"http://10.0.0.2:7777","kind":"lan","label":"Wi-Fi"}],"lan":{"on":true,"listening":true},"cloudflareToken":false}"""))
        val s = client().remote()
        assertEquals(RemoteMode.QUICK, s.mode)
        assertEquals(RemoteState.STARTING, s.state)
        assertEquals("/api/remote", server.takeRequest().url.encodedPath)

        server.enqueue(MockResponse(body = """{"mode":"custom","state":"on","addresses":[]}"""))
        client().setRemote(mode = RemoteMode.CUSTOM, url = "https://hub.example.com")
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("""{"mode":"custom","url":"https://hub.example.com"}""", put.body?.utf8())

        server.enqueue(MockResponse(body = """{"mode":"off","state":"off","addresses":[]}"""))
        client().setRemote(lan = false, clearUrl = true)
        assertEquals("""{"lan":false,"url":null}""", server.takeRequest().body?.utf8())

        server.enqueue(MockResponse(body = """{"mode":"off","state":"off","addresses":[],"warning":"The DNS name was already gone."}"""))
        assertEquals("The DNS name was already gone.", client().removeStableTunnel().warning)
        assertEquals("DELETE", server.takeRequest().method)

        server.enqueue(MockResponse(body = """{"zones":[{"id":"z1","name":"example.com","accountId":"a"}]}"""))
        assertEquals(listOf("example.com"), client().cloudflareToken("cf-secret").map { it.name })
        assertEquals("""{"token":"cf-secret"}""", server.takeRequest().body?.utf8())

        server.enqueue(MockResponse(body = """{"mode":"stable","state":"starting","addresses":[]}"""))
        client().setupStableTunnel("z1", "conclave")
        assertEquals("""{"zoneId":"z1","name":"conclave"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun healthNeedsNoTokenAndPairingKeepsEveryAddress() = runBlocking {
        server.enqueue(MockResponse(body = """{"ok":true,"version":"0.3.0","uptimeMs":5}"""))
        assertTrue(client(token = null).health().ok)
        assertNull(server.takeRequest().headers["Authorization"])

        server.enqueue(MockResponse(body = """{"token":"t","clientId":"c","hub":{"name":"home"},"addresses":["https://a.trycloudflare.com","http://192.168.1.2:7777"]}"""))
        val r = client(token = null).pair("123456", "Pixel")
        assertEquals(listOf("https://a.trycloudflare.com", "http://192.168.1.2:7777"), r.addresses)
    }

    @Test
    fun tooManyTriesCarriesRetryAfter() = runBlocking {
        server.enqueue(
            MockResponse(
                code = 429,
                headers = Headers.headersOf("retry-after", "40", "content-type", "application/json"),
                body = """{"error":"Too many failed attempts from this address. Try again in 40 seconds."}""",
            ),
        )
        val e = assertFailsWith<ConclaveApiException> { client().info() }
        assertEquals(429, e.status)
        assertEquals(40L, e.retryAfterSeconds)
        assertEquals("Too many failed attempts from this address. Try again in 40 seconds.", e.message)
    }

    @Test
    fun refusedSocketWaitsLonger() {
        val unauthorized = LiveEvent.Rejected(401, null)
        assertEquals(60_000L, ConclaveClient.refusedWait(unauthorized, 0, 500))
        assertEquals(480_000L, ConclaveClient.refusedWait(unauthorized, 9, 500))
        assertEquals(40_000L, ConclaveClient.refusedWait(LiveEvent.Rejected(429, null, 40), 0, 500))
        assertEquals(30_000L, ConclaveClient.refusedWait(LiveEvent.Rejected(429, null), 0, 500))
        assertEquals(60_000L, ConclaveClient.backgroundBackoff(20))
    }

    private class ScriptedSocket(private val script: (WebSocket) -> Unit = {}) : WebSocketListener() {
        val received = LinkedBlockingQueue<String>()
        override fun onOpen(webSocket: WebSocket, response: Response) = script(webSocket)
        override fun onMessage(webSocket: WebSocket, text: String) {
            received.add(text)
        }
    }

    @Test
    fun reportsPresenceAfterConnectAndOnEveryChange() = runBlocking {
        val socket = ScriptedSocket { ws -> ws.send("""{"type":"hello","seq":1}""") }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(socket).build())
        val visible = MutableStateFlow(false)
        val job = launch(Dispatchers.IO) { client().live(pingIntervalMs = 60_000, active = visible).collect { } }
        try {
            assertEquals("""{"type":"presence","active":false}""", socket.received.poll(10, TimeUnit.SECONDS))
            visible.value = true
            assertEquals("""{"type":"presence","active":true}""", socket.received.poll(10, TimeUnit.SECONDS))
            visible.value = false
            assertEquals("""{"type":"presence","active":false}""", socket.received.poll(10, TimeUnit.SECONDS))
        } finally {
            job.cancel()
        }
        // connected from the background: the hub does not count it as use
        assertEquals("0", server.takeRequest().url.queryParameter("active"))
    }

    @Test
    fun sendsPresenceAsTheHeartbeatWhileInUse() = runBlocking {
        val socket = ScriptedSocket()
        server.enqueue(MockResponse.Builder().webSocketUpgrade(socket).build())
        val job = launch(Dispatchers.IO) { client().live(pingIntervalMs = 100, active = MutableStateFlow(true)).collect { } }
        try {
            repeat(3) { assertEquals("""{"type":"presence","active":true}""", socket.received.poll(10, TimeUnit.SECONDS)) }
        } finally {
            job.cancel()
        }
        assertNull(server.takeRequest().url.queryParameter("active"))
    }

    @Test
    fun aRefusedSocketSaysWhy() = runBlocking {
        server.enqueue(MockResponse(code = 403, body = """{"error":"This hub only takes connections from its own network."}"""))
        val items = CopyOnWriteArrayList<LiveEvent>()
        val job = launch(Dispatchers.IO) { client().live(backoffMs = { 10L }).collect { items += it } }
        try {
            withTimeout(10_000) {
                while (items.none { it is LiveEvent.Rejected }) delay(20)
            }
        } finally {
            job.cancel()
        }
        val r = items.filterIsInstance<LiveEvent.Rejected>().single()
        assertEquals(403, r.status)
        assertEquals("This hub only takes connections from its own network.", r.message)
    }
}
