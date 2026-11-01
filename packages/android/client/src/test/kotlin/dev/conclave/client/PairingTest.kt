package dev.conclave.client

import dev.conclave.client.logic.JustPaired
import dev.conclave.client.logic.PairKind
import dev.conclave.client.logic.PairWatch
import dev.conclave.client.logic.PairingWords
import dev.conclave.client.model.AppDto
import dev.conclave.client.model.Device
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.PairingInfo
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun dev(id: String, online: Boolean, name: String = id.uppercase()) = Device(id = id, name = name, online = online)
private fun app(id: String, name: String = id.uppercase(), revoked: Boolean = false) = AppDto(id = id, name = name, revoked = revoked)

class PairWatchTest {
    @Test
    fun aComputerIsTheOneThatCameOnlineAfterTheCode() {
        val before = listOf(dev("local", true), dev("nas", false), dev("pc", true))
        val w = PairWatch.start(PairKind.COMPUTER, before, null)
        // nothing new yet
        assertNull(w.paired(before, emptyList()))
        // a new computer that is not online yet has not paired
        assertNull(w.paired(before + dev("win", false), emptyList()))
        assertEquals(JustPaired("win", "WIN"), w.paired(before + dev("win", true), emptyList()))
        // one that was offline and came back counts too, as on the web
        assertEquals(JustPaired("nas", "NAS"), w.paired(listOf(dev("local", true), dev("nas", true), dev("pc", true)), emptyList()))
        // apps never pair a computer code
        assertNull(w.paired(before, listOf(app("phone2"))))
    }

    @Test
    fun anAppIsTheOneThatIsNew() {
        val apps = listOf(app("me"), app("old", revoked = true))
        val w = PairWatch.start(PairKind.APP, listOf(dev("local", true)), apps)
        assertNull(w.paired(listOf(dev("local", true)), apps))
        // this phone coming and going is not a new app
        assertNull(w.paired(emptyList(), PairingWords.withApp(apps, app("me").copy(online = true))))
        // a new computer is not an app
        assertNull(w.paired(listOf(dev("local", true), dev("pc", true)), apps))
        // signed out at once: not paired
        assertNull(w.paired(emptyList(), apps + app("gone", revoked = true)))
        assertEquals(JustPaired("win", "Windows app"), w.paired(emptyList(), apps + app("win", "Windows app")))
        // no name: the id
        assertEquals(JustPaired("x1", "x1"), w.paired(emptyList(), apps + app("x1", "")))
    }

    @Test
    fun withoutTheAppsNoAppCanBeToldApart() {
        val w = PairWatch.start(PairKind.APP, emptyList(), null)
        assertNull(w.paired(emptyList(), listOf(app("me"), app("new"))))
    }

    @Test
    fun withAppPutsInOrReplaces() {
        val list = listOf(app("a"), app("b"))
        assertEquals(listOf("a", "b", "c"), PairingWords.withApp(list, app("c")).map { it.id })
        val changed = PairingWords.withApp(list, app("a", "New name"))
        assertEquals(2, changed.size)
        assertEquals("New name", changed.single { it.id == "a" }.name)
    }
}

class PairingWordsTest {
    private val info = PairingInfo(code = "ABCD-EFGH", url = "https://hub.example.com/", expiresAt = 1_000_000)

    @Test
    fun theTimerCountsDownAndRunsOut() {
        val ten = info.expiresAt - 10 * 60_000
        assertEquals("Expires in 10:00", PairingWords.timer(info, ten))
        assertEquals("Expires in 9:42", PairingWords.timer(info, info.expiresAt - 9 * 60_000 - 42_000))
        // rounded up: the last second still shows
        assertEquals("Expires in 0:01", PairingWords.timer(info, info.expiresAt - 400))
        assertEquals("9:42", PairingWords.clock(info, info.expiresAt - 9 * 60_000 - 41_500))
        assertFalse(PairingWords.expired(info, info.expiresAt - 1))
        assertTrue(PairingWords.expired(info, info.expiresAt))
        assertEquals("Expired.", PairingWords.timer(info, info.expiresAt))
        assertEquals("Expired.", PairingWords.timer(info, info.expiresAt + 60_000))
    }

    @Test
    fun theCommandsCarryTheCodesAddress() {
        assertEquals(
            listOf(
                PairingWords.INSTALL,
                "conclave daemon pair https://hub.example.com ABCD-EFGH",
                "conclave daemon install --start",
            ),
            PairingWords.commands(info, "http://192.168.1.20:7777"),
        )
        // a hub that sent no address: the one this app uses
        assertEquals("conclave daemon pair http://192.168.1.20:7777 ABCD-EFGH", PairingWords.commands(info.copy(url = ""), "http://192.168.1.20:7777/")[1])
    }

    @Test
    fun wordsForEachKind() {
        assertEquals("client", PairKind.APP.wire)
        assertEquals("device", PairKind.COMPUTER.wire)
        assertEquals("Waiting for the app", PairingWords.waiting(PairKind.APP))
        assertEquals("Waiting for the computer", PairingWords.waiting(PairKind.COMPUTER))
        assertTrue("signs in as you" in PairingWords.help(PairKind.APP))
        assertTrue("without the desktop app" in PairingWords.help(PairKind.COMPUTER))
        PairKind.entries.forEach { k ->
            listOf(PairingWords.help(k), PairingWords.waiting(k), PairingWords.pairedNote(k)).forEach { assertFalse('\u2014' in it, it) }
        }
    }
}

class PairingClientTest {
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

    private fun client() = ConclaveClient(server.url("/").toString(), "member-token")

    @Test
    fun makesACodeOfAKind() = runBlocking {
        server.enqueue(
            MockResponse(
                body = """{"code":"ABCD-EFGH","url":"https://hub.example.com","deepLink":"conclave://pair?url=x&code=ABCD-EFGH&fp=ab","qrSvg":"<svg/>",
                    "expiresAt":600000,"addresses":["https://hub.example.com","http://192.168.1.20:7777"],"fingerprint":"21fe31dfa154"}""",
            ),
        )
        val info = client().createPairing(PairKind.COMPUTER.wire)
        assertEquals("ABCD-EFGH", info.code)
        assertEquals("21fe31dfa154", info.fingerprint)
        assertEquals(2, info.addresses.size)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/pairing", req.url.encodedPath)
        assertEquals("""{"kind":"device"}""", req.body?.utf8())
        assertEquals("Bearer member-token", req.headers["Authorization"])
    }

    @Test
    fun listsTheAccountsApps() = runBlocking {
        server.enqueue(
            MockResponse(
                body = """[{"id":"c1","name":"Pixel 8","platform":"android","createdAt":5,"revoked":false,"accountId":"m1","online":true},
                    {"id":"c2","name":"Old","createdAt":1,"revoked":true,"accountId":"m1","extra":1}]""",
            ),
        )
        val apps = client().apps()
        assertEquals(listOf("c1", "c2"), apps.map { it.id })
        assertTrue(apps[0].online)
        assertEquals("android", apps[0].platform)
        assertTrue(apps[1].revoked)
        assertNull(apps[1].platform)
        assertEquals("/api/clients", server.takeRequest().url.encodedPath)
    }

    @Test
    fun decodesAppUpdated() {
        val frame = """{"type":"app.updated","seq":7,"ts":1,"app":{"id":"c3","name":"Windows app","platform":"desktop","createdAt":9,"revoked":false,"accountId":"m1"}}"""
        val ev = (Frame.parse(frame) as Frame.Event).envelope.event
        assertIs<EngineEvent.AppUpdated>(ev)
        assertEquals("Windows app", ev.app.name)
        assertEquals("m1", ev.app.accountId)
    }
}
