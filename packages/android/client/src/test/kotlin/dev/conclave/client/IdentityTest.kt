package dev.conclave.client

import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.HubAddresses
import dev.conclave.client.model.HubIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.net.InetAddress
import java.net.Proxy
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** RFC 8032 section 7.1, test 1. */
private const val RFC_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
private const val RFC_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
private const val RFC_EMPTY_SIG =
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"

/** The RFC key in base64url, its fingerprint, and its signature of the identity text for one nonce (made with Python's cryptography). */
private const val HUB_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
private const val HUB_FP = "21fe31dfa154a261626bf854046fd227"
private const val VECTOR_NONCE = "q3vA9xYz-_0123456789ab"
private const val VECTOR_SIG = "M-pkYZOtZnVRFCEhCYD_Bwoq2JM-cW3YaxqzCGewOXFfn5zb6xRtDQsH-hwnfsuChKKfyvuY9GNcxwr0Zae4Ag"

private fun hex(s: String): ByteArray = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun rfcPrivate(): PrivateKey {
    val pkcs8 = hex("302e020100300506032b657004220420") + hex(RFC_SEED)
    return KeyFactory.getInstance("Ed25519").generatePrivate(PKCS8EncodedKeySpec(pkcs8))
}

private class TestKey(val secret: PrivateKey, val publicB64: String) {
    fun sign(text: ByteArray): String {
        val s = Signature.getInstance("Ed25519")
        s.initSign(secret)
        s.update(text)
        return HubKeys.encode(s.sign())
    }

    companion object {
        val hub = TestKey(rfcPrivate(), HUB_KEY)

        fun random(): TestKey {
            val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
            // X.509 encoding: 12 bytes of header, then the 32 raw key bytes
            return TestKey(pair.private, HubKeys.encode(pair.public.encoded.takeLast(32).toByteArray()))
        }
    }
}

class IdentityKeysTest {
    @Test
    fun verifiesTheRfcVector() {
        assertTrue(JdkEd25519.verify(hex(RFC_PUBLIC), ByteArray(0), hex(RFC_EMPTY_SIG)))
        val bad = hex(RFC_EMPTY_SIG).also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertFalse(JdkEd25519.verify(hex(RFC_PUBLIC), ByteArray(0), bad))
        assertFalse(JdkEd25519.verify(hex(RFC_PUBLIC).copyOf(31), ByteArray(0), hex(RFC_EMPTY_SIG)))
    }

    @Test
    fun verifiesTheIdentityTextVector() {
        val raw = HubKeys.rawKey(HUB_KEY)!!
        assertTrue(raw.contentEquals(hex(RFC_PUBLIC)))
        assertEquals("conclave-hub-identity-v1\n$VECTOR_NONCE", String(HubKeys.signedText(VECTOR_NONCE), Charsets.UTF_8))
        assertTrue(HubKeys.verify(raw, VECTOR_NONCE, VECTOR_SIG, JdkEd25519))
        // the same signature does not cover another nonce
        assertFalse(HubKeys.verify(raw, VECTOR_NONCE + "x", VECTOR_SIG, JdkEd25519))
        // Ed25519 is deterministic: signing here gives the same bytes as the other implementation
        assertEquals(VECTOR_SIG, TestKey.hub.sign(HubKeys.signedText(VECTOR_NONCE)))
        assertFalse(HubKeys.verify(raw, VECTOR_NONCE, "not base64!", JdkEd25519))
    }

    @Test
    fun fingerprintIsTheFirst16BytesOfSha256InHex() {
        assertEquals(HUB_FP, HubKeys.fingerprint(HUB_KEY))
        assertEquals("21fe 31df a154 a261 626b f854 046f d227", HubKeys.groups(HUB_FP))
        assertTrue(HubKeys.sameFingerprint("21FE 31DF A154 A261 626B F854 046F D227", HUB_FP))
        assertFalse(HubKeys.sameFingerprint(HUB_FP.dropLast(1), HUB_FP.dropLast(1)))
        assertNull(HubKeys.fingerprint("dG9vIHNob3J0"))
        // padding or not, the same key
        assertTrue(HubKeys.sameKey(HUB_KEY, "$HUB_KEY="))
        assertFalse(HubKeys.sameKey(HUB_KEY, TestKey.random().publicB64))
    }

    @Test
    fun noncesAreFreshBase64url() {
        val a = HubKeys.nonce()
        val b = HubKeys.nonce()
        assertTrue(a != b)
        assertEquals(32, a.length)
        assertTrue(a.all { it.isLetterOrDigit() || it == '-' || it == '_' })
    }

    @Test
    fun passwordGoesOnlyOverHttpsOrToAPrivateAddress() {
        val yes = listOf(
            "https://hub.example.com",
            "https://8.8.8.8",
            "http://localhost:7777",
            "http://127.0.0.1:7777",
            "http://[::1]:7777",
            "http://10.1.2.3:7777",
            "http://172.16.0.5",
            "http://172.31.255.1",
            "http://192.168.1.20:7777",
            "http://100.64.0.1",
            "http://100.127.1.1",
            "http://[fd7a:115c:a1e0::1]:7777",
            "http://[fd00::1]",
            "http://studio.local:7777",
            "http://box.tail1234.ts.net",
        )
        val no = listOf(
            "http://hub.example.com",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://100.128.0.1",
            "http://192.169.1.1",
            "http://[fe80::1]",
            "http://[fd::1]",
            "http://[2001:db8::1]",
            "http://nas",
            "ftp://192.168.1.2",
            "",
        )
        yes.forEach { assertTrue(PasswordRule.allowed(it), it) }
        no.forEach { assertFalse(PasswordRule.allowed(it), it) }
        // the same cases as isPrivateAddress in packages/core/test/client/identity.test.ts
        val private = listOf(
            "http://localhost:7717", "http://127.0.0.1", "http://127.8.9.10:1", "http://[::1]:7717", "http://10.0.0.5",
            "http://172.16.0.1", "http://172.31.255.255", "http://192.168.1.20:7717", "http://100.64.0.1", "http://100.127.255.254",
            "http://[fd7a:115c:a1e0::1]:7717", "http://hub.local", "http://hub.local.:7717", "https://box.tail1234.ts.net", "192.168.0.2:7717",
        )
        val public = listOf(
            "http://8.8.8.8", "http://172.15.0.1", "http://172.32.0.1", "http://100.63.0.1", "http://100.128.0.1", "http://192.169.0.1",
            "http://[2001:db8::1]", "http://[fc00::1]", "https://hub.example.com", "http://local", "http://evil.ts.net.example.com", "not a url at all",
        )
        private.forEach { assertTrue(PasswordRule.isPrivateAddress(it), it) }
        public.forEach { assertFalse(PasswordRule.isPrivateAddress(it), it) }
    }

    @Test
    fun pairLinksCarryTheFingerprint() {
        val url = enc("https://a.trycloudflare.com")
        val lan = enc("http://192.168.1.2:7777")
        val link = DeepLink.parse("conclave://pair?url=$url&code=482913&fp=21FE31DFA154A261626BF854046FD227&alt=$lan")
        assertEquals(DeepLink.Pair("https://a.trycloudflare.com", "482913", listOf("http://192.168.1.2:7777"), HUB_FP), link)
        // from a hub older than identity: no fp
        assertNull((DeepLink.parse("conclave://pair?url=$url&code=1") as DeepLink.Pair).fp)
        assertNull((DeepLink.parse("conclave://pair?url=$url&code=1&fp=") as DeepLink.Pair).fp)
    }

    @Test
    fun pairingMovesOnOnlyWhenAnAddressDoesNotAnswer() = runBlocking {
        val tried = mutableListOf<String>()
        val (url, result) = HubAddresses.firstAnswer(listOf("https://a", "http://b", "http://c")) { u ->
            tried += u
            if (u == "https://a") throw IOException("no answer")
            "paired at $u"
        }
        assertEquals("http://b", url)
        assertEquals("paired at http://b", result)
        assertEquals(listOf("https://a", "http://b"), tried)

        // another machine at the first address: stop, the code never goes to the next one
        tried.clear()
        val mismatch = assertFailsWith<HubIdentityException> {
            HubAddresses.firstAnswer(listOf("https://a", "http://b")) { u ->
                tried += u
                throw HubIdentityException(u, HubIdentityException.NOT_THE_CODES_HUB)
            }
        }
        assertEquals("This address is not the hub that made the code.", mismatch.message)
        assertEquals(listOf("https://a"), tried)

        // the hub's own answer (a used code) stops too
        tried.clear()
        assertFailsWith<ConclaveApiException> {
            HubAddresses.firstAnswer(listOf("https://a", "http://b")) { u ->
                tried += u
                throw ConclaveApiException(400, "Invalid or expired pairing code")
            }
        }
        assertEquals(listOf("https://a"), tried)

        // nothing answers: the last failure
        val lost = assertFailsWith<IOException> {
            HubAddresses.firstAnswer(listOf("https://a", "http://b")) { u -> throw IOException("down $u") }
        }
        assertEquals("down http://b", lost.message)
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
}

/**
 * A fake hub with an identity key. It answers /api/identity by signing the
 * nonce (or not, as a test says), and everything else from [routes].
 */
private class FakeHub : Dispatcher() {
    val key = AtomicReference(TestKey.hub)

    /** Sign this text instead of the right one (a bad signature). */
    val signInstead = AtomicReference<String?>(null)

    /** Answer /api/identity with this code instead (404: a hub older than identity). */
    val identityStatus = AtomicReference<Int?>(null)
    val identityRefused = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Answer /api/identity with this 200 body instead (a captive portal page). */
    val identityBody = AtomicReference<String?>(null)

    /** Put this fingerprint in the proof instead of the key's. */
    val fingerprintInstead = AtomicReference<String?>(null)

    val identityCalls = AtomicInteger(0)
    val routes = Collections.synchronizedMap(HashMap<String, () -> MockResponse>())

    override fun dispatch(request: RecordedRequest): MockResponse {
        val path = request.url.encodedPath
        if (path == "/api/identity") {
            identityCalls.incrementAndGet()
            identityStatus.get()?.let { return MockResponse(code = it, body = """{"error":"Not found"}""") }
            if (identityRefused.get()) return MockResponse(code = 403, body = """{"error":"This hub only answers this computer.","code":"network"}""")
            identityBody.get()?.let { return MockResponse(body = it) }
            val nonce = request.url.queryParameter("nonce") ?: return MockResponse(code = 400, body = """{"error":"Bad nonce"}""")
            val k = key.get()
            val text = signInstead.get()?.toByteArray(Charsets.UTF_8) ?: HubKeys.signedText(nonce)
            val fp = fingerprintInstead.get() ?: HubKeys.fingerprint(k.publicB64)
            return MockResponse(body = """{"publicKey":"${k.publicB64}","fingerprint":"$fp","signature":"${k.sign(text)}"}""")
        }
        return routes[path]?.invoke() ?: MockResponse(code = 404, body = """{"error":"Not found"}""")
    }
}

class IdentityClientTest {
    private lateinit var server: MockWebServer
    private lateinit var hub: FakeHub

    @BeforeTest
    fun setUp() {
        hub = FakeHub()
        server = MockWebServer()
        server.dispatcher = hub
        server.start()
        hub.routes["/api/info"] = { MockResponse(body = """{"name":"home","version":"0.9.0"}""") }
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    /** "hub.test" resolves to the fake hub: an address that is not loopback, so the check runs. */
    private val http: OkHttpClient by lazy {
        val loopback = InetAddress.getByName(server.hostName)
        OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    if (hostname == "hub.test") listOf(loopback) else Dns.SYSTEM.lookup(hostname)
            })
            .build()
    }

    private val remote get() = "http://hub.test:${server.port}"

    private fun client(guard: HubIdentityGuard?, token: String? = "secret-token", base: String = remote) =
        ConclaveClient(base, token, http, identity = guard)

    private var taken = 0

    /** The requests the hub got since the last look, in order. */
    private fun requests(): List<RecordedRequest> {
        val total = server.requestCount
        val out = List(total - taken) { server.takeRequest() }
        taken = total
        return out
    }

    /** A port where nothing listens. */
    private fun deadPort(): Int {
        val s = MockWebServer()
        s.start()
        val port = s.port
        s.close()
        return port
    }

    @Test
    fun theHubProvesItsKeyBeforeTheTokenGoes() = runBlocking {
        val guard = HubIdentityGuard(HUB_KEY)
        assertEquals("home", client(guard).info().name)
        assertEquals("home", client(guard).info().name)
        val sent = requests()
        assertEquals(listOf("/api/identity", "/api/info", "/api/info"), sent.map { it.url.encodedPath })
        // the identity call carries no token, and a nonce of its own
        assertNull(sent[0].headers["Authorization"])
        assertEquals(32, sent[0].url.queryParameter("nonce")!!.length)
        assertEquals("Bearer secret-token", sent[1].headers["Authorization"])
    }

    @Test
    fun anotherKeySendsNothing() = runBlocking {
        hub.key.set(TestKey.random())
        val mismatches = mutableListOf<HubIdentityException>()
        val guard = HubIdentityGuard(HUB_KEY, onMismatch = { mismatches += it })
        val e = assertFailsWith<HubIdentityException> { client(guard).info() }
        assertEquals("This address is not your hub. Conclave did not send your sign-in.", e.message)
        assertEquals(remote, e.address)
        assertEquals(listOf(e), mismatches)
        val sent = requests()
        assertEquals(listOf("/api/identity"), sent.map { it.url.encodedPath })
        assertTrue(sent.none { it.headers["Authorization"] != null })
    }

    @Test
    fun aBadSignatureSendsNothing() = runBlocking {
        // the right key, but the signature covers other words (a replayed answer)
        hub.signInstead.set("conclave-hub-identity-v1\nsomeone-elses-nonce")
        assertFailsWith<HubIdentityException> { client(HubIdentityGuard(HUB_KEY)).info() }
        assertEquals(listOf("/api/identity"), requests().map { it.url.encodedPath })
    }

    @Test
    fun noAnswerIsOfflineNotAStranger() = runBlocking {
        val mismatches = mutableListOf<HubIdentityException>()
        val guard = HubIdentityGuard(HUB_KEY, onMismatch = { mismatches += it })
        val port = deadPort()
        val e = assertFailsWith<IOException> { client(guard, base = "http://hub.test:$port").info() }
        assertFalse(e is HubIdentityException)
        assertTrue(mismatches.isEmpty())
        assertFalse(guard.isFresh("http://hub.test:$port"))
    }

    @Test
    fun aCheckHoldsTenMinutesAtThatAddress() = runBlocking {
        var now = 1_000_000L
        val guard = HubIdentityGuard(HUB_KEY, now = { now })
        client(guard).info()
        now += 9 * 60_000L
        client(guard).info()
        now += 60_000L
        client(guard).info()
        assertEquals(
            listOf("/api/identity", "/api/info", "/api/info", "/api/identity", "/api/info"),
            requests().map { it.url.encodedPath },
        )
        assertTrue(guard.isFresh("$remote/"))
        // another address of the same hub is checked on its own
        assertFalse(guard.isFresh("https://hub.example.com"))
    }

    @Test
    fun thisDeviceIsNotChecked() = runBlocking {
        hub.key.set(TestKey.random())
        val local = server.url("/").toString()
        assertEquals("home", client(HubIdentityGuard(HUB_KEY), base = local).info().name)
        assertEquals(0, hub.identityCalls.get())
    }

    @Test
    fun aHubPairedBeforeIdentityKeepsItsFirstKey() = runBlocking {
        val pinned = mutableListOf<HubIdentity>()
        val guard = HubIdentityGuard(null, onPinned = { pinned += it })
        client(guard).info()
        assertEquals(listOf(HubIdentity(HUB_KEY, HUB_FP)), pinned)
        assertEquals(HUB_KEY, guard.pinnedKey)
        // later another key at the address is a stranger
        hub.key.set(TestKey.random())
        guard.forget(remote)
        assertFailsWith<HubIdentityException> { client(guard).info() }
        assertEquals(1, pinned.size)
    }

    @Test
    fun aHubOlderThanIdentity() = runBlocking<Unit> {
        hub.identityStatus.set(404)
        // nothing pinned: nothing to check against, the token goes as before
        val pinned = mutableListOf<HubIdentity>()
        assertEquals("home", client(HubIdentityGuard(null, onPinned = { pinned += it })).info().name)
        assertTrue(pinned.isEmpty())
        // a key is pinned, so the hub has /api/identity: a 404 here is another machine
        assertFailsWith<HubIdentityException> { client(HubIdentityGuard(HUB_KEY)).info() }
    }

    @Test
    fun whatCountsAsAStranger() = runBlocking<Unit> {
        // a 4xx other than 429 is not the hub answering
        for (code in listOf(400, 401, 403, 404, 410)) {
            hub.identityStatus.set(code)
            assertFailsWith<HubIdentityException>("$code") { client(HubIdentityGuard(HUB_KEY)).info() }
        }
        // the hub's own trouble or a pause: an API error, not a stranger
        for (code in listOf(429, 500, 502, 503)) {
            hub.identityStatus.set(code)
            val e = assertFailsWith<ConclaveApiException>("$code") { client(HubIdentityGuard(HUB_KEY)).info() }
            assertEquals(code, e.status)
        }
        hub.identityStatus.set(null)
        // the hub's own network refusal: an API error in the app's words, not a stranger
        hub.identityBody.set(null)
        hub.identityRefused.set(true)
        val refused = assertFailsWith<ConclaveApiException> { client(HubIdentityGuard(HUB_KEY)).info() }
        assertEquals(403, refused.status)
        assertEquals(HubIdentityException.NETWORK_REFUSED, refused.message)
        hub.identityRefused.set(false)
        // a page that is not a proof (a captive portal)
        hub.identityBody.set("<html>Sign in to the Wi-Fi</html>")
        assertFailsWith<HubIdentityException> { client(HubIdentityGuard(HUB_KEY)).info() }
        hub.identityBody.set("""{"ok":true}""")
        assertFailsWith<HubIdentityException> { client(HubIdentityGuard(HUB_KEY)).info() }
        hub.identityBody.set(null)
        // the right key and signature, but the proof names another fingerprint
        hub.fingerprintInstead.set("00".repeat(16))
        assertFailsWith<HubIdentityException> { client(HubIdentityGuard(HUB_KEY)).info() }
        // through all of it, nothing with the token went out
        assertTrue(requests().all { it.url.encodedPath == "/api/identity" && it.headers["Authorization"] == null })
    }

    @Test
    fun aCaptivePortalPinsNothingForAnOldPairing() = runBlocking {
        hub.identityBody.set("<html>Sign in to the Wi-Fi</html>")
        val guard = HubIdentityGuard(null)
        client(guard).info()
        assertNull(guard.pinnedKey)
        // the real hub later: its key is kept
        hub.identityBody.set(null)
        guard.forget(remote)
        client(guard).info()
        assertEquals(HUB_KEY, guard.pinnedKey)
    }

    @Test
    fun aQrCodeChecksItsHubBeforeTheCodeGoes() = runBlocking {
        hub.routes["/api/pair"] = { MockResponse(body = """{"token":"tok","clientId":"c1","hub":{"name":"home"},"identity":{"publicKey":"$HUB_KEY","fingerprint":"$HUB_FP"}}""") }
        val wrong = assertFailsWith<HubIdentityException> {
            client(null, token = null).pair("482913", "Pixel", "android", fingerprint = "00".repeat(16))
        }
        assertEquals("This address is not the hub that made the code.", wrong.message)
        assertEquals(listOf("/api/identity"), requests().map { it.url.encodedPath })

        val r = client(null, token = null).pair("482913", "Pixel", "android", fingerprint = HUB_FP.uppercase())
        assertEquals("tok", r.token)
        assertEquals(HubIdentity(HUB_KEY, HUB_FP), r.identity)
        val sent = requests()
        assertEquals(listOf("/api/identity", "/api/pair"), sent.map { it.url.encodedPath })
        assertEquals("""{"code":"482913","name":"Pixel","platform":"android"}""", sent[1].body?.utf8())
    }

    @Test
    fun aTypedCodeHasNoFingerprintToCheck() = runBlocking {
        hub.routes["/api/pair"] = { MockResponse(body = """{"token":"tok","hub":{"name":"home"},"identity":{"publicKey":"$HUB_KEY","fingerprint":"$HUB_FP"}}""") }
        val r = client(null, token = null).pair("482913", "Pixel")
        assertEquals(HUB_KEY, r.identity?.publicKey)
        assertEquals(listOf("/api/pair"), requests().map { it.url.encodedPath })
    }

    @Test
    fun passwordLoginRefusesPlainHttpToAPublicAddress() = runBlocking {
        val e = assertFailsWith<PasswordOverHttpException> { client(null, token = null).login("correct horse battery", "Pixel") }
        assertEquals("Use the https address of your hub to log in with a password.", e.message)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun passwordLoginOverAPrivateAddress() = runBlocking {
        hub.routes["/api/login"] = { MockResponse(body = """{"token":"tok","clientId":"c2","hub":{"name":"home","fingerprint":"$HUB_FP"},"addresses":["http://192.168.1.2:7777"],"identity":{"publicKey":"$HUB_KEY","fingerprint":"$HUB_FP"}}""") }
        val r = client(null, token = null, base = server.url("/").toString()).login("correct horse battery", "Pixel")
        assertEquals("tok", r.token)
        assertEquals(HUB_FP, r.hub.fingerprint)
        assertEquals(HUB_KEY, r.identity?.publicKey)
        val req = server.takeRequest()
        assertEquals("/api/login", req.url.encodedPath)
        assertNull(req.headers["Authorization"])
        assertEquals("""{"password":"correct horse battery","name":"Pixel","platform":"android"}""", req.body?.utf8())
    }

    @Test
    fun aWrongPasswordIsTheHubsOneMessage() = runBlocking {
        hub.routes["/api/login"] = { MockResponse(code = 401, body = """{"error":"Wrong password, or no password is set on this hub."}""") }
        val e = assertFailsWith<ConclaveApiException> { client(null, token = null, base = server.url("/").toString()).login("nope", "Pixel") }
        assertEquals("Wrong password, or no password is set on this hub.", e.message)
    }

    private class Socket(private val closeAfterOpen: Boolean) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send("""{"type":"hello","seq":1}""")
            if (closeAfterOpen) webSocket.close(1001, "restart")
        }
    }

    @Test
    fun theSocketChecksFirstAndAgainAfterEachReconnect() = runBlocking {
        val sockets = AtomicInteger(0)
        // the first socket drops at once, the second stays
        hub.routes["/api/ws"] = { MockResponse.Builder().webSocketUpgrade(Socket(closeAfterOpen = sockets.incrementAndGet() == 1)).build() }
        val items = CopyOnWriteArrayList<LiveEvent>()
        val job = launch(Dispatchers.IO) {
            client(HubIdentityGuard(HUB_KEY)).live(pingIntervalMs = 60_000, backoffMs = { 10L }).collect { items += it }
        }
        try {
            withTimeout(10_000) {
                while (sockets.get() < 2 || items.count { it == LiveEvent.Status(ConnectionState.OPEN) } < 2) delay(20)
            }
        } finally {
            job.cancel()
        }
        val paths = requests().map { it.url.encodedPath }
        assertEquals(listOf("/api/identity", "/api/ws", "/api/identity", "/api/ws"), paths.take(4))
    }

    @Test
    fun theSocketNeverOpensToAnotherKey() = runBlocking {
        hub.key.set(TestKey.random())
        hub.routes["/api/ws"] = { MockResponse.Builder().webSocketUpgrade(Socket(closeAfterOpen = false)).build() }
        val items = CopyOnWriteArrayList<LiveEvent>()
        val job = launch(Dispatchers.IO) {
            client(HubIdentityGuard(HUB_KEY)).live(pingIntervalMs = 60_000, backoffMs = { 10L }).collect { items += it }
        }
        try {
            // it keeps trying with backoff, checking each time
            withTimeout(10_000) {
                while (items.count { it is LiveEvent.NotYourHub } < 2) delay(20)
            }
        } finally {
            job.cancel()
        }
        assertTrue(hub.identityCalls.get() >= 2)
        val no = items.filterIsInstance<LiveEvent.NotYourHub>().first()
        assertEquals(remote, no.address)
        assertEquals("This address is not your hub. Conclave did not send your sign-in.", no.message)
        assertTrue(LiveEvent.Status(ConnectionState.OPEN) !in items)
        assertTrue(requests().none { it.url.encodedPath == "/api/ws" })
    }

    @Test
    fun aSocketWithNoAnswerIsAPlainDisconnect() = runBlocking {
        val port = deadPort()
        val items = CopyOnWriteArrayList<LiveEvent>()
        val job = launch(Dispatchers.IO) {
            client(HubIdentityGuard(HUB_KEY), base = "http://hub.test:$port").live(pingIntervalMs = 60_000, backoffMs = { 10L }).collect { items += it }
        }
        try {
            withTimeout(10_000) {
                while (items.count { it == LiveEvent.Status(ConnectionState.CLOSED) } < 2) delay(20)
            }
        } finally {
            job.cancel()
        }
        assertTrue(items.none { it is LiveEvent.NotYourHub || it is LiveEvent.Rejected })
    }
}
