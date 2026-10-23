package dev.conclave.client

import dev.conclave.client.model.ApprovalResponse
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.ChatSettingsPatch
import dev.conclave.client.model.SendInput
import dev.conclave.client.model.SessionKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody.Companion.asResponseBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.ForwardingSource
import okio.buffer
import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientTest {
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

    private fun client(token: String? = "secret-token") =
        ConclaveClient(server.url("/").toString(), token)

    @Test
    fun sendsBearerTokenAndParsesList() = runBlocking {
        server.enqueue(MockResponse(body = """[{"id":"s1","title":"A"},{"id":"s2","title":"B","pinned":true}]"""))
        val sessions = client().listSessions(archived = false, search = "build fix")
        assertEquals(listOf("s1", "s2"), sessions.map { it.id })
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/sessions", req.url.encodedPath)
        assertEquals("false", req.url.queryParameter("archived"))
        assertEquals("build fix", req.url.queryParameter("search"))
        assertNull(req.url.queryParameter("agent"))
        assertEquals("Bearer secret-token", req.headers["Authorization"])
    }

    @Test
    fun postsJsonBodies() = runBlocking {
        server.enqueue(MockResponse(body = """{"queued":true,"messageId":"m9"}"""))
        val r = client().send("s 1", SendInput(text = "hi"))
        assertTrue(r.queued)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/sessions/s%201/messages", req.url.encodedPath)
        assertEquals("""{"text":"hi"}""", req.body?.utf8())
        assertTrue(req.headers["Content-Type"]!!.startsWith("application/json"))
    }

    @Test
    fun listsChatsAndPatchesSwitches() = runBlocking {
        server.enqueue(MockResponse(body = """[{"id":"c1","kind":"chat","chat":{"webSearch":true,"memory":false}}]"""))
        val chats = client().listSessions(kind = SessionKind.CHAT, archived = false)
        assertTrue(chats.single().isChat)
        assertEquals("chat", server.takeRequest().url.queryParameter("kind"))

        server.enqueue(MockResponse(body = """{"id":"c1","kind":"chat","chat":{"webSearch":true,"memory":true}}"""))
        val s = client().updateChat("c1", ChatSettingsPatch(memory = true, agentThinking = true))
        assertEquals(true, s.chat?.memory)
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/sessions/c1", req.url.encodedPath)
        assertEquals("""{"chat":{"memory":true,"thinking":null}}""", req.body?.utf8())
    }

    @Test
    fun resolvesApprovalAndIgnoresOkBody() = runBlocking {
        server.enqueue(MockResponse(body = """{"ok":true}"""))
        client().resolveApproval("a1", ApprovalResponse.allowSession())
        val req = server.takeRequest()
        assertEquals("/api/approvals/a1", req.url.encodedPath)
        assertEquals("""{"decision":"allow","scope":"session"}""", req.body?.utf8())
    }

    @Test
    fun pairsWithoutToken() = runBlocking {
        server.enqueue(MockResponse(body = """{"token":"tok","clientId":"c1","hub":{"name":"home","version":"0.1.0"}}"""))
        val r = client(token = null).pair("123456", "Pixel", "android")
        assertEquals("tok", r.token)
        assertEquals("home", r.hub.name)
        val req = server.takeRequest()
        assertNull(req.headers["Authorization"])
        assertEquals("""{"code":"123456","name":"Pixel","platform":"android"}""", req.body?.utf8())
    }

    @Test
    fun mapsErrorsToApiException() = runBlocking {
        server.enqueue(MockResponse(code = 401, body = """{"error":"bad token"}"""))
        val e = assertFailsWith<ConclaveApiException> { client().info() }
        assertEquals(401, e.status)
        assertEquals("bad token", e.message)
    }

    @Test
    fun readsTheBodyOffTheCallersThread() = runBlocking {
        // on Android the caller is often the main thread, where a socket read throws NetworkOnMainThreadException
        server.enqueue(MockResponse(body = """[{"id":"s1"}]"""))
        val readers = Collections.synchronizedSet(HashSet<String>())
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val r = chain.proceed(chain.request())
            val watched = object : ForwardingSource(r.body.source()) {
                override fun read(sink: Buffer, byteCount: Long): Long {
                    readers += Thread.currentThread().name
                    return super.read(sink, byteCount)
                }
            }
            r.newBuilder().body(watched.buffer().asResponseBody(r.body.contentType(), r.body.contentLength())).build()
        }.build()
        val caller = Executors.newSingleThreadExecutor { Thread(it, "caller") }.asCoroutineDispatcher()
        try {
            val list = withContext(caller) { ConclaveClient(server.url("/").toString(), "t", http).listSessions() }
            assertEquals("s1", list.single().id)
        } finally {
            caller.close()
        }
        assertTrue(readers.isNotEmpty())
        // coroutine debug mode adds " @coroutine#1" to the name
        assertFalse(readers.any { it.startsWith("caller") }, readers.toString())
    }

    @Test
    fun keepsBasePathPrefix() = runBlocking {
        server.enqueue(MockResponse(body = "[]"))
        ConclaveClient(server.url("/hub/").toString(), "t").approvals()
        assertEquals("/hub/api/approvals", server.takeRequest().url.encodedPath)
    }

    @Test
    fun webSocketUrlLeavesTheTokenOut() {
        val c = ConclaveClient("https://hub.example.ts.net/", "abc")
        assertEquals("https://hub.example.ts.net/api/ws", c.webSocketUrl().toString())
        assertEquals("https://hub.example.ts.net/api/ws?active=0", c.webSocketUrl(active = false).toString())
    }

    @Test
    fun backoffMatchesTypeScript() {
        assertEquals(500, ConclaveClient.defaultBackoff(0))
        assertEquals(1000, ConclaveClient.defaultBackoff(1))
        assertEquals(8000, ConclaveClient.defaultBackoff(4))
        assertEquals(15_000, ConclaveClient.defaultBackoff(5))
        assertEquals(15_000, ConclaveClient.defaultBackoff(40))
    }

    /** Server side of one WebSocket connection: records frames from the app and sends scripted ones. */
    private class ScriptedSocket(private val script: (WebSocket) -> Unit) : WebSocketListener() {
        val received = LinkedBlockingQueue<String>()
        override fun onOpen(webSocket: WebSocket, response: Response) = script(webSocket)
        override fun onMessage(webSocket: WebSocket, text: String) {
            received.add(text)
        }
    }

    @Test
    fun liveReconnectsAndReplaysSinceLastSeq() = runBlocking {
        val first = ScriptedSocket { ws ->
            ws.send("""{"type":"hello","seq":5}""")
            ws.send("""{"type":"session.deleted","sessionId":"s1","seq":6,"ts":1}""")
            ws.send("""{"type":"task.deleted","taskId":"t1","seq":7,"ts":2}""")
            ws.close(1001, "restart")
        }
        val second = ScriptedSocket { ws ->
            ws.send("""{"type":"hello","seq":7}""")
            ws.send("""{"type":"resync","seq":20}""")
        }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(first).build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(second).build())

        val items = CopyOnWriteArrayList<LiveEvent>()
        val job = launch(Dispatchers.IO) {
            client().live(pingIntervalMs = 60_000, backoffMs = { 10L }).collect { items += it }
        }
        try {
            // The reconnect asked for everything after seq 7.
            assertEquals("""{"type":"since","seq":7}""", second.received.poll(10, TimeUnit.SECONDS))
            withTimeout(10_000) {
                while (LiveEvent.Resync(20) !in items) delay(20)
            }
        } finally {
            job.cancel()
        }

        val events = items.toList().filterIsInstance<LiveEvent.Event>().map { it.envelope.event }
        assertEquals(EngineEvent.SessionDeleted("s1"), events[0])
        assertEquals(EngineEvent.TaskDeleted("t1"), events[1])
        assertTrue(items.contains(LiveEvent.Status(ConnectionState.CLOSED)))
        val upgrade = server.takeRequest()
        assertEquals("Bearer secret-token", upgrade.headers["Authorization"])
        assertNull(upgrade.url.queryParameter("token"))
        // The first connection never sent "since": it had not seen any seq yet.
        assertNull(first.received.poll(100, TimeUnit.MILLISECONDS))
    }

    @Test
    fun aRestartedHubMeansResync() = runBlocking {
        val first = ScriptedSocket { ws ->
            ws.send("""{"type":"hello","seq":5}""")
            ws.send("""{"type":"task.deleted","taskId":"t1","seq":6,"ts":1}""")
            ws.close(1001, "restart")
        }
        // the hub came back and counts from 0 again; it drops the line only after it got "since", or a slow runner loses it
        val second = object : WebSocketListener() {
            val received = LinkedBlockingQueue<String>()
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"type":"hello","seq":2}""")
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                received.add(text)
                webSocket.close(1001, "again")
            }
        }
        val third = ScriptedSocket { }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(first).build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(second).build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(third).build())

        val items = CopyOnWriteArrayList<LiveEvent>()
        val job = launch(Dispatchers.IO) {
            client().live(pingIntervalMs = 60_000, backoffMs = { 10L }).collect { items += it }
        }
        try {
            assertEquals("""{"type":"since","seq":6}""", second.received.poll(10, TimeUnit.SECONDS))
            // the next connect replays from the new hub's seq, not the old one
            assertEquals("""{"type":"since","seq":2}""", third.received.poll(10, TimeUnit.SECONDS))
        } finally {
            job.cancel()
        }
        assertEquals(listOf(LiveEvent.Resync(2)), items.toList().filterIsInstance<LiveEvent.Resync>())
        assertEquals(listOf(LiveEvent.Hello(5), LiveEvent.Hello(2)), items.toList().filterIsInstance<LiveEvent.Hello>())
    }

    @Test
    fun liveStartsWithKnownSeq() = runBlocking {
        val socket = ScriptedSocket { ws -> ws.send("""{"type":"hello","seq":99}""") }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(socket).build())
        val job = launch(Dispatchers.IO) { client().live(startSeq = 42, pingIntervalMs = 60_000).collect { } }
        try {
            assertEquals("""{"type":"since","seq":42}""", socket.received.poll(10, TimeUnit.SECONDS))
        } finally {
            job.cancel()
        }
    }
}
