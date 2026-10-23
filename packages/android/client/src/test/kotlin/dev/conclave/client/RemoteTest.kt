package dev.conclave.client

import dev.conclave.client.logic.AddressRecovery
import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.HubAddresses
import dev.conclave.client.logic.RemoteWords
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.RemoteAddress
import dev.conclave.client.model.RemoteLan
import dev.conclave.client.model.RemoteMode
import dev.conclave.client.model.RemoteState
import dev.conclave.client.model.RemoteStatus
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val QUICK = "https://calm-river-1234.trycloudflare.com"
private const val QUICK2 = "https://bright-sky-9876.trycloudflare.com"
private const val LAN = "http://192.168.1.20:7777"
private const val OWN = "https://hub.example.com"

private fun status(
    mode: RemoteMode = RemoteMode.QUICK,
    state: RemoteState = RemoteState.ON,
    url: String? = QUICK,
    previous: String? = null,
    addresses: List<RemoteAddress> = listOf(RemoteAddress(QUICK, "quick", "Cloudflare tunnel"), RemoteAddress(LAN, "lan", "Wi-Fi 192.168.1.20")),
    lan: RemoteLan = RemoteLan(on = true, listening = true),
) = RemoteStatus(mode = mode, state = state, url = url, previousUrl = previous, addresses = addresses, lan = lan)

class HubAddressesTest {
    @Test
    fun normalizesAndRefusesOddUrls() {
        assertEquals(QUICK, HubAddresses.normalize("  $QUICK/ "))
        assertEquals("https://hub.example.com/hub", HubAddresses.normalize("https://hub.example.com/hub/"))
        assertNull(HubAddresses.normalize("ftp://x.example.com"))
        assertNull(HubAddresses.normalize("https://x.example.com/?token=1"))
        assertNull(HubAddresses.normalize("https://user:pw@x.example.com"))
        assertNull(HubAddresses.normalize("not a url"))
        assertNull(HubAddresses.normalize(null))
        assertTrue(HubAddresses.same("HTTPS://Calm-River-1234.trycloudflare.com/", QUICK))
    }

    @Test
    fun savesTheHubListAtPairingNeverTheCodesAlts() {
        // the reply's list is the hub's own order
        assertEquals(listOf(QUICK, LAN), HubAddresses.atPairing(LAN, listOf("$QUICK/", LAN, LAN)))
        // an older hub sends no list: only the address the code worked on
        assertEquals(listOf(QUICK), HubAddresses.atPairing(QUICK, emptyList()))
    }

    @Test
    fun followsTheHubToANewTunnelOnlyFromTheOldOne() {
        val moved = status(url = QUICK2, previous = QUICK)
        assertEquals(QUICK2, HubAddresses.moveTo(QUICK, moved))
        assertEquals(QUICK2, HubAddresses.moveTo("$QUICK/", moved))
        // this phone uses the same network: it stays
        assertNull(HubAddresses.moveTo(LAN, moved))
        // the new tunnel is not up yet
        assertNull(HubAddresses.moveTo(QUICK, moved.copy(state = RemoteState.STARTING)))
        // nothing replaced
        assertNull(HubAddresses.moveTo(QUICK, status()))
    }

    @Test
    fun fallsBackInTheHubOrderAndAsksForANewCodeOnlyForQuickTunnels() {
        assertEquals(listOf(LAN), HubAddresses.fallbacks(QUICK, listOf(QUICK, LAN)))
        assertEquals(listOf(OWN, QUICK), HubAddresses.fallbacks(LAN, listOf(OWN, QUICK, LAN)))
        assertTrue(HubAddresses.needsNewCode(QUICK))
        assertFalse(HubAddresses.needsNewCode(LAN))
        assertFalse(HubAddresses.needsNewCode(OWN))
    }

    @Test
    fun listFromStatusDropsAQuickAddressTheHubNoLongerHas() {
        val now = status(url = QUICK2, previous = QUICK, addresses = listOf(RemoteAddress(QUICK2, "quick"), RemoteAddress(LAN, "lan")))
        val saved = HubAddresses.fromStatus(now)
        assertEquals(listOf(QUICK2, LAN), saved)
        assertFalse(QUICK in HubAddresses.fallbacks(LAN, saved))
    }
}

class AddressRecoveryTest {
    private class Fake(var up: Set<String>) {
        val asked = ArrayList<String>()
        suspend fun answers(url: String): Boolean {
            asked += url
            return url in up
        }
    }

    @Test
    fun staysWhenTheAddressStillAnswers() = runBlocking {
        val f = Fake(setOf(QUICK))
        val r = AddressRecovery(f::answers, now = { 0L })
        assertEquals(AddressRecovery.Outcome.Fine, r.recover(QUICK, listOf(QUICK, LAN)))
        assertEquals(listOf(QUICK), f.asked)
    }

    @Test
    fun movesToTheFirstSavedAddressThatAnswers() = runBlocking {
        val f = Fake(setOf(LAN))
        val r = AddressRecovery(f::answers, now = { 1_000L })
        assertEquals(AddressRecovery.Outcome.Move(LAN), r.recover(QUICK, listOf(OWN, QUICK, LAN)))
        assertEquals(listOf(QUICK, OWN, LAN), f.asked)
    }

    @Test
    fun nothingAnswersThenWaitsBeforeTheNextRound() = runBlocking {
        var t = 1_000L
        val f = Fake(emptySet())
        val r = AddressRecovery(f::answers, now = { t }, minGapMs = 15_000)
        assertEquals(AddressRecovery.Outcome.Lost(newCode = true), r.recover(QUICK, listOf(QUICK, LAN)))
        t += 5_000
        assertEquals(AddressRecovery.Outcome.Later, r.recover(QUICK, listOf(QUICK, LAN)))
        t += 11_000
        assertEquals(AddressRecovery.Outcome.Lost(newCode = true), r.recover(QUICK, listOf(QUICK, LAN)))
        // the same network or an own URL can come back: no new code
        r.reset()
        assertEquals(AddressRecovery.Outcome.Lost(newCode = false), r.recover(LAN, listOf(LAN)))
    }
}

class RemoteWordsTest {
    @Test
    fun saysTheStateWithWhatToDo() {
        assertEquals("Phones and computers reach the hub at $QUICK.", RemoteWords.state(status()).rest)
        assertEquals(RemoteWords.Tone.OK, RemoteWords.state(status()).tone)
        val starting = status(state = RemoteState.STARTING, url = null).copy(detail = "Downloading cloudflared, 14 of 38 MB")
        assertEquals("Downloading cloudflared, 14 of 38 MB.", RemoteWords.state(starting).rest)
        val broken = status(state = RemoteState.ERROR, url = null).copy(error = "Cloudflare did not answer. Check the hub's internet connection.")
        assertEquals("Not working.", RemoteWords.state(broken).word)
        assertEquals("Cloudflare did not answer. Check the hub's internet connection.", RemoteWords.state(broken).rest)
        val off = status(mode = RemoteMode.OFF, state = RemoteState.OFF, url = null, addresses = listOf(RemoteAddress(LAN, "lan")))
        assertEquals("Only devices on the same network can reach the hub.", RemoteWords.state(off).rest)
        assertEquals("Phones on the hub's Wi-Fi use $LAN. It is plain http, so keep it to networks you trust.", RemoteWords.lanHelp(off))
        assertTrue(RemoteWords.lanHelp(off.copy(lan = RemoteLan(on = true, fixedHost = "127.0.0.1"))).startsWith("The hub listens on 127.0.0.1"))
    }

    @Test
    fun warnsBeforeAChangeCutsThisPhoneOff() {
        val s = status()
        assertTrue(RemoteWords.cutsOff(QUICK, s, RemoteMode.OFF))
        // the hub brings the new address up first and the app follows
        assertFalse(RemoteWords.cutsOff(QUICK, s, RemoteMode.TAILSCALE))
        assertFalse(RemoteWords.cutsOff(QUICK, s, RemoteMode.QUICK))
        assertFalse(RemoteWords.cutsOff(LAN, s, RemoteMode.OFF))
        assertTrue(RemoteWords.lanOffCutsOff(LAN, s))
        assertFalse(RemoteWords.lanOffCutsOff(QUICK, s))
    }

    @Test
    fun refusalsSayWhatToDoNext() {
        assertEquals("The hub no longer accepts this phone. Pair again in Settings.", RemoteWords.refusal(401, "unauthorized", null))
        assertEquals("Only this computer and private networks can connect.", RemoteWords.refusal(403, "Only this computer and private networks can connect.", null))
        assertEquals("Too many failed tries from this network. Wait 40 seconds, then try again.", RemoteWords.refusal(429, null, 40))
        assertEquals("Too many failed tries from this network. Wait 3 minutes, then try again.", RemoteWords.waitText(150))
        assertEquals("Too many failed tries from this network. Wait a minute, then try again.", RemoteWords.waitText(null))
    }
}

class RemoteModelsTest {
    @Test
    fun parsesPairLinksWithEveryAlt() {
        val link = DeepLink.parse("conclave://pair?url=${enc(QUICK)}&code=482913&alt=${enc(LAN)}&alt=${enc(OWN)}&alt=${enc(LAN)}")
        assertEquals(DeepLink.Pair(QUICK, "482913", listOf(LAN, OWN)), link)
        // an old link without alts
        assertEquals(DeepLink.Pair(QUICK, "1"), DeepLink.parse("conclave://pair?url=${enc(QUICK)}&code=1"))
    }

    @Test
    fun decodesRemoteUpdatedAndNoticeAlert() {
        val frame = """{"type":"remote.updated","seq":3,"ts":1,"remote":{"mode":"quick","state":"on","url":"$QUICK2","previousUrl":"$QUICK","since":5,
            "addresses":[{"url":"$QUICK2","kind":"quick","label":"Cloudflare tunnel"},{"url":"$LAN","kind":"lan","label":"Wi-Fi"}],
            "lan":{"on":true,"listening":true},"cloudflareToken":false,"cloudflared":{"path":"/x","managed":true,"verified":false}}}"""
        val ev = (Frame.parse(frame) as Frame.Event).envelope.event
        assertIs<EngineEvent.RemoteUpdated>(ev)
        assertEquals(QUICK2, ev.remote.url)
        assertEquals(listOf("quick", "lan"), ev.remote.addresses.map { it.kind })
        assertEquals(false, ev.remote.cloudflared?.verified)

        val notice = (Frame.parse("""{"type":"notice","seq":4,"ts":1,"notice":{"id":"n","title":"Done","body":"","alert":true,"approvalId":"a1"}}""") as Frame.Event).envelope.event
        assertIs<EngineEvent.NoticeEvent>(notice)
        assertTrue(notice.notice.alert)
        val toast = (Frame.parse("""{"type":"notice","seq":5,"ts":1,"notice":{"id":"n2","title":"Saved"}}""") as Frame.Event).envelope.event
        assertFalse((toast as EngineEvent.NoticeEvent).notice.alert)
        // a mode a newer hub adds falls back instead of failing
        val newer = (Frame.parse("""{"type":"remote.updated","seq":6,"ts":1,"remote":{"mode":"mesh","state":"on","addresses":[]}}""") as Frame.Event).envelope.event
        assertEquals(RemoteMode.OFF, (newer as EngineEvent.RemoteUpdated).remote.mode)
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
}
