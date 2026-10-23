package dev.conclave.client

import dev.conclave.client.model.ApplyShareInput
import dev.conclave.client.model.CleanupInput
import dev.conclave.client.model.FriendInviteInput
import dev.conclave.client.model.OpenPrInput
import dev.conclave.client.model.PermissionMode
import dev.conclave.client.model.PushInput
import dev.conclave.client.model.RepoSessionInput
import dev.conclave.client.model.SendShareInput
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Headers
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The calls of the Map, friends, shares, repo sessions and map pictures: paths, queries and bodies as the hub takes them. */
class ClientFeaturesTest {
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

    private fun client() = ConclaveClient(server.url("/").toString(), "tok")

    @Test
    fun theMapAndAReplay() = runBlocking {
        server.enqueue(MockResponse(body = """{"at":5,"live":true,"from":1,"hub":{"name":"madx","state":"running"},"devices":[],"groups":[],"nodes":[],"totals":{"running":1,"waiting":0,"today":{"from":0,"tokens":10,"costUsd":0.5}}}"""))
        val live = client().map(tz = -120)
        assertEquals("madx", live.hub.name)
        val req = server.takeRequest()
        assertEquals("/api/map", req.url.encodedPath)
        assertEquals("-120", req.url.queryParameter("tz"))
        assertNull(req.url.queryParameter("at"))
        server.enqueue(MockResponse(body = """{"at":3,"live":false}"""))
        client().map(at = 3, tz = 0)
        assertEquals("3", server.takeRequest().url.queryParameter("at"))
    }

    private class ScriptedSocket : WebSocketListener() {
        val received = LinkedBlockingQueue<String>()
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send("""{"type":"hello","seq":1}""")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            received.add(text)
        }
    }

    @Test
    fun theSocketAsksForMapDeltasWhileTheMapIsOpen() = runBlocking {
        val socket = ScriptedSocket()
        server.enqueue(MockResponse.Builder().webSocketUpgrade(socket).build())
        val open = MutableStateFlow(true)
        val job = launch(Dispatchers.IO) { client().live(pingIntervalMs = 60_000, map = open).collect { } }
        try {
            assertEquals("""{"type":"map","on":true}""", socket.received.poll(10, TimeUnit.SECONDS))
            open.value = false
            assertEquals("""{"type":"map","on":false}""", socket.received.poll(10, TimeUnit.SECONDS))
            open.value = true
            assertEquals("""{"type":"map","on":true}""", socket.received.poll(10, TimeUnit.SECONDS))
        } finally {
            job.cancel()
        }
    }

    @Test
    fun aClosedMapSendsNothingOnConnect() = runBlocking {
        val socket = ScriptedSocket()
        server.enqueue(MockResponse.Builder().webSocketUpgrade(socket).build())
        val job = launch(Dispatchers.IO) { client().live(pingIntervalMs = 300, map = MutableStateFlow(false)).collect { } }
        try {
            // the only frame is the plain ping
            assertEquals("""{"type":"ping"}""", socket.received.poll(10, TimeUnit.SECONDS))
        } finally {
            job.cancel()
        }
    }

    @Test
    fun friendsCalls() = runBlocking {
        server.enqueue(MockResponse(body = """{"link":"conclave://friend?x","qrSvg":"<svg/>","expiresAt":9,"fingerprint":"ab","url":"https://a","addresses":["https://a"]}"""))
        val invite = client().createFriendInvite(FriendInviteInput(includeLan = true))
        assertEquals("conclave://friend?x", invite.link)
        val r1 = server.takeRequest()
        assertEquals("/api/friends/invites", r1.url.encodedPath)
        assertEquals("""{"includeLan":true}""", r1.body?.utf8())

        server.enqueue(MockResponse(body = """{"id":"f1","name":"Alice","status":"pending","direction":"out"}"""))
        client().acceptFriendInvite("conclave://friend?fp=1")
        assertEquals("""{"link":"conclave://friend?fp=1"}""", server.takeRequest().body?.utf8())

        server.enqueue(MockResponse(body = """{"id":"f1","name":"Alice","status":"active"}"""))
        client().setFriendGrants("f 1", receiveShares = false)
        val r3 = server.takeRequest()
        assertEquals("PUT", r3.method)
        assertEquals("/api/friends/f%201/grants", r3.url.encodedPath)
        assertEquals("""{"receiveShares":false}""", r3.body?.utf8())

        server.enqueue(MockResponse(body = """{"id":"f1","name":"Alice","status":"active","unread":0}"""))
        client().markFriendRead("f1", "n9")
        assertEquals("""{"upTo":"n9"}""", server.takeRequest().body?.utf8())

        server.enqueue(MockResponse(body = """{"ok":true}"""))
        client().removeFriend("f1")
        assertEquals("DELETE", server.takeRequest().method)

        server.enqueue(MockResponse(body = """[{"id":"o1","friendId":"f1","type":"note","state":"queued","attempts":0,"createdAt":1,"preview":"note: hi","text":"hi"}]"""))
        assertEquals("hi", client().friendOutbox("f1").single().text)
        assertEquals("f1", server.takeRequest().url.queryParameter("friend"))
    }

    @Test
    fun sharesCalls() = runBlocking {
        val input = SendShareInput(sessionId = "ses_1", toolOutput = "full", attachments = true, thinking = false, code = "diff", to = listOf("f1"), title = "T", note = "N")
        server.enqueue(MockResponse(body = """{"sessionId":"ses_1","kind":"session","title":"T","options":{"thinking":false,"toolOutput":"full","attachments":true,"code":"diff"},"messages":3,"total":3,"sessions":1,"report":{"secrets":1},"items":[{"id":"k1","rule":"secret","original":"sk-1","replacement":"[secret]","count":2,"messageIds":["m1"],"kept":false}],"code":{"kind":"diff","error":"The device is offline."},"bytes":100,"warnings":[]}"""))
        val p = client().previewShare(input)
        assertEquals("The device is offline.", p.code?.error)
        assertEquals(2, p.items.single().count)
        // the review never names the friends
        assertEquals("""{"sessionId":"ses_1","thinking":false,"toolOutput":"full","attachments":true,"code":"diff"}""", server.takeRequest().body?.utf8())

        server.enqueue(MockResponse(body = """{"id":"s1","sessionId":"ses_1","title":"T","recipients":[{"friendId":"f1","friendName":"Alice","state":"sent","revision":1}]}"""))
        client().sendShare(input)
        val send = server.takeRequest()
        assertEquals("/api/shares", send.url.encodedPath)
        assertTrue(send.body!!.utf8().contains(""""to":["f1"]"""))

        server.enqueue(MockResponse(body = """{"planId":"p1","device":"mac","deviceName":"MacBook","kind":"diff","root":"~/app","branch":"from-alice/t","files":["a"],"runsCode":["package.json"],"check":{"ok":false,"error":"does not apply"},"expiresAt":5}"""))
        val plan = client().planApplyShare("r1", ApplyShareInput("mac", "~/app"))
        assertEquals("does not apply", plan.check.error)
        assertEquals("/api/shares/received/r1/apply-plan", server.takeRequest().url.encodedPath)

        server.enqueue(MockResponse(body = """{"device":"mac","root":"~/app","branch":"from-alice/t","commit":"abc"}"""))
        client().applyShare("r1", "p1")
        assertEquals("""{"planId":"p1"}""", server.takeRequest().body?.utf8())

        server.enqueue(MockResponse(body = """{"id":"s1","sessionId":"ses_1","state":"revoked"}"""))
        assertEquals("revoked", client().unsendShare("s1").state)
        assertEquals("DELETE", server.takeRequest().method)
    }

    @Test
    fun repoCalls() = runBlocking {
        server.enqueue(MockResponse(body = """[{"fullName":"acme/widgets","owner":"acme","name":"widgets","private":true,"defaultBranch":"main","url":"https://github.com/acme/widgets","canPush":true}]"""))
        assertEquals("acme/widgets", client().githubRepos(" wid ").single().fullName)
        val r1 = server.takeRequest()
        assertEquals("/api/github/repos", r1.url.encodedPath)
        assertEquals("wid", r1.url.queryParameter("q"))

        server.enqueue(MockResponse(body = """{"defaultBranch":"main","branches":["main","dev"]}"""))
        assertEquals(listOf("main", "dev"), client().githubBranches("acme/widgets").branches)
        assertEquals("/api/github/repos/acme/widgets/branches", server.takeRequest().url.encodedPath)

        server.enqueue(MockResponse(body = """{"id":"ses_9","title":"","meta":{"repo":{"repo":"acme/widgets","branch":"conclave/x","base":"main"}}}"""))
        client().createRepoSession(RepoSessionInput(repo = "acme/widgets", base = "dev", device = "mac", prompt = "Fix it", permissionMode = PermissionMode.DEFAULT))
        val r3 = server.takeRequest()
        assertEquals("/api/github/sessions", r3.url.encodedPath)
        assertEquals("""{"repo":"acme/widgets","base":"dev","device":"mac","prompt":"Fix it","permissionMode":"default"}""", r3.body?.utf8())

        server.enqueue(MockResponse(body = """{"sessionId":"ses_9","repo":"acme/widgets","branch":"conclave/x","base":"main","pushed":"current","online":true,"canCleanUp":false,"line":"Pushed."}"""))
        client().sessionRepo("ses_9", refresh = true)
        assertEquals("true", server.takeRequest().url.queryParameter("refresh"))

        server.enqueue(MockResponse(body = """{"pushed":true,"branch":"conclave/x","sha":"abc","commits":2,"committed":1,"line":"Pushed 2 commits."}"""))
        assertEquals("Pushed 2 commits.", client().pushSession("ses_9", PushInput("Fix it")).line)
        assertEquals("""{"commitMessage":"Fix it"}""", server.takeRequest().body?.utf8())

        server.enqueue(MockResponse(body = """{"sessionId":"ses_9","repo":"acme/widgets","branch":"conclave/x","pr":{"number":7,"url":"u","state":"open"},"line":"Open."}"""))
        assertEquals(7, client().openPullRequest("ses_9", OpenPrInput("Fix it", "Body", true)).pr?.number)
        assertEquals("""{"title":"Fix it","body":"Body","draft":true}""", server.takeRequest().body?.utf8())

        server.enqueue(MockResponse(body = """{"sessionId":"ses_9","repo":"acme/widgets","branch":"conclave/x","cleaned":true,"line":"Cleaned."}"""))
        client().cleanupSession("ses_9", CleanupInput(force = true))
        assertEquals("""{"force":true}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun aMapPictureComesAsBytesWithTheToken() = runBlocking {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 1, 2, 3)
        server.enqueue(MockResponse.Builder().headers(Headers.headersOf("content-type", "image/png")).body(Buffer().write(png)).build())
        val (bytes, type) = client().mapImage("map_abcdefghij")
        assertContentEquals(png, bytes)
        assertEquals("image/png", type)
        val req = server.takeRequest()
        assertEquals("/api/maps/image/map_abcdefghij", req.url.encodedPath)
        assertEquals("Bearer tok", req.headers["Authorization"])

        server.enqueue(MockResponse(code = 502, body = """{"error":"Google refused the key."}"""))
        val e = assertFailsWith<ConclaveApiException> { client().mapImage("map_abcdefghij") }
        assertEquals(502, e.status)
        assertEquals("Google refused the key.", e.message)
    }
}
