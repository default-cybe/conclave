package dev.conclave.client

import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.FriendInboxItem
import dev.conclave.client.logic.FriendTone
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.logic.QrCode
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.FriendAddress
import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.FriendReachability
import dev.conclave.client.model.InboxItemDto
import dev.conclave.client.model.OutboxItemDto
import dev.conclave.client.model.ReceivedShareDto
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Friends (docs/design/FRIENDS.md): the invite link, keys and codes, a friend in words, the Inbox, and the invite's QR code. */
class FriendsTest {
    private val now = Instant.parse("2026-10-20T15:00:00Z").toEpochMilli()
    private val utc = ZoneOffset.UTC
    private val clock: (Long) -> String = { ts -> Instant.ofEpochMilli(ts).atZone(utc).toLocalTime().toString().take(5) }

    private val fp = "3f9a12c08e4107b2aa55cc66dd77ee88"
    private val link = "conclave://friend?fp=$fp&url=https%3A%2F%2Fhub.example.com%2F&alt=http%3A%2F%2F192.168.1.4%3A7777&alt=https%3A%2F%2Fhub.example.com&s=abcdefghijklmnopqrstuvwxyz012&exp=1792500000"

    private fun friend(status: String = "active", direction: String = "out", vararg extra: Pair<String, Any?>): FriendDto =
        FriendDto(id = "f1", name = "Alice", fingerprint = fp, status = status, direction = direction, safetyCode = "18342 90311 55120 07718", createdAt = now - 3 * 3_600_000)
            .let { f ->
                var g = f
                for ((k, v) in extra) g = when (k) {
                    "lastSeen" -> g.copy(lastSeen = v as Long?)
                    "lastError" -> g.copy(lastError = v as String?)
                    "queued" -> g.copy(queued = v as Int)
                    "unread" -> g.copy(unread = v as Int?)
                    "unreadNotes" -> g.copy(unreadNotes = v as Int?)
                    "readAt" -> g.copy(readAt = v as Long?)
                    "blockedReason" -> g.copy(blockedReason = v as String?)
                    else -> g
                }
                g
            }

    // ----- the invite link -----

    @Test
    fun `an invite in a message is found, cleaned and checked`() {
        val l = FriendWords.parseLink("Here is my invite: $link.")!!
        assertEquals(link, l.link)
        assertEquals(fp, l.fp)
        assertEquals("https://hub.example.com", l.url)
        assertEquals(listOf("http://192.168.1.4:7777"), l.alts)
        assertEquals(1_792_500_000_000L, l.expiresAt)
        assertEquals("3f9a 12c0", FriendWords.shortFingerprint(l.fp, 2))
        assertEquals("hub.example.com", FriendWords.hostWords(l.url))
    }

    @Test
    fun `a broken invite is none`() {
        assertNull(FriendWords.parseLink(null))
        assertNull(FriendWords.parseLink("conclave://pair?url=x&code=1"))
        assertNull(FriendWords.parseLink(link.replace("fp=$fp", "fp=xyz")))
        assertNull(FriendWords.parseLink(link.replace("s=abcdefghijklmnopqrstuvwxyz012", "s=short")))
        assertNull(FriendWords.parseLink(link.replace("exp=1792500000", "exp=soon")))
        assertNull(FriendWords.parseLink(link.replace("url=https%3A%2F%2Fhub.example.com%2F", "url=ftp%3A%2F%2Fhub")))
        assertNull(FriendWords.parseLink(link.replace("url=https%3A%2F%2Fhub.example.com%2F", "url=https%3A%2F%2Fhub.example.com%2F%3Fx%3D1")))
    }

    @Test
    fun `an invite opens Friends, and friend notices open it too`() {
        assertEquals(DeepLink.FriendInvite(link), DeepLink.parse(link))
        assertNull(DeepLink.parse("conclave://friend?fp=nope"))
        assertEquals(DeepLink.Friends(null), DeepLink.parse("/settings/friends"))
        assertEquals(DeepLink.Friends("f 1"), DeepLink.parse("/settings/friends/f%201"))
        assertEquals(DeepLink.Shares("sh1"), DeepLink.parse("/shares/sh1"))
        assertEquals(DeepLink.Shares(null), DeepLink.parse("/shares"))
        assertEquals(DeepLink.MapPage, DeepLink.parse("/map"))
        assertEquals(DeepLink.MapPage, DeepLink.parse("conclave://map"))
        assertEquals(DeepLink.MemoryMap(), DeepLink.parse("/memory/map"))
        assertEquals(DeepLink.MemoryMap("clusters", "mem:m 1"), DeepLink.parse("conclave://memory-map?view=clusters&item=mem%3Am%201"))
        assertEquals(DeepLink.Shares("sh2"), DeepLink.parse("conclave://shares/sh2"))
    }

    // ----- keys, codes and times -----

    @Test
    fun `keys and safety codes in groups`() {
        assertEquals("3f9a 12c0 8e41 07b2", FriendWords.shortFingerprint("3F9A12C0-8E4107B2AA55"))
        assertEquals(listOf("3f9a 12c0 8e41 07b2", "aa55 cc66 dd77 ee88"), FriendWords.fingerprintLines(fp))
        assertEquals(listOf("18342", "90311", "55120", "07718"), FriendWords.safetyGroups("1834290311 55120-07718"))
    }

    @Test
    fun `times in words`() {
        assertEquals("just now", FriendWords.agoText(now - 10_000, now))
        assertEquals("4m ago", FriendWords.agoText(now - 4 * 60_000, now))
        assertEquals("3h ago", FriendWords.agoText(now - 3 * 3_600_000, now))
        assertEquals("2d ago", FriendWords.agoText(now - 2 * 86_400_000, now))
        assertEquals("on 10 Oct", FriendWords.agoText(now - 10 * 86_400_000L, now, utc))
        assertEquals("Today 14:02", FriendWords.stampText(now - 58 * 60_000, now, clock, utc))
        assertEquals("Yesterday 15:00", FriendWords.stampText(now - 86_400_000, now, clock, utc))
        assertEquals("until 18:00 today", FriendWords.untilText(now + 3 * 3_600_000, now, clock, utc))
        assertEquals("until 15:00 tomorrow", FriendWords.untilText(now + 86_400_000, now, clock, utc))
        assertEquals("in 6 min", FriendWords.inTime(now + 6 * 60_000, now))
        assertEquals("now", FriendWords.inTime(now + 10_000, now))
    }

    // ----- can friends reach this hub -----

    @Test
    fun `whether friends reach this hub`() {
        assertNull(FriendWords.reachWords(null))
        val ok = FriendWords.reachWords(FriendReachability(ok = true, mode = "quick", best = FriendAddress("https://x.trycloudflare.com", "quick")))!!
        assertTrue(ok.ok)
        assertEquals("Friends reach this hub at x.trycloudflare.com.", ok.title)
        assertNotNull(ok.detail)
        val off = FriendWords.reachWords(FriendReachability(ok = false, mode = "off"))!!
        assertEquals("Friends cannot reach this hub.", off.title)
        assertEquals("Remote access is off.", off.why)
        assertEquals("Tailscale serves only your tailnet.", FriendWords.reachWords(FriendReachability(ok = false, mode = "tailscale"))!!.why)
        assertEquals("The tunnel is starting.", FriendWords.reachWords(FriendReachability(ok = false, mode = "quick", reason = "The tunnel is starting."))!!.detail)
    }

    // ----- a friend in words -----

    @Test
    fun `a friend's state in one line`() {
        assertEquals("Wants to be friends", FriendWords.state(friend("pending", "in"), now).word)
        assertEquals(FriendTone.WARN, FriendWords.state(friend("pending", "in"), now).tone)
        assertEquals("You asked 3h ago. You are friends once their owner accepts.", FriendWords.state(friend("pending", "out"), now).line)
        assertEquals("New key", FriendWords.state(friend("blocked"), now).word)
        assertEquals(FriendTone.FAULT, FriendWords.state(friend("blocked"), now).tone)
        assertEquals("Not seen yet", FriendWords.state(friend(), now).word)
        assertEquals("Seen 4m ago", FriendWords.state(friend("active", "out", "lastSeen" to now - 4 * 60_000), now).word)
        val stuck = FriendWords.state(friend("active", "out", "lastError" to "Their hub did not answer.", "queued" to 2), now)
        assertEquals(FriendTone.WARN, stuck.tone)
        assertEquals("Their hub did not answer. 2 waiting to go.", stuck.line)
    }

    @Test
    fun `friends in order, what needs you first`() {
        val list = listOf(
            friend("active").copy(id = "a", name = "Zoe"),
            friend("pending", "out").copy(id = "b", name = "Ben"),
            friend("pending", "in").copy(id = "c", name = "Yan"),
            friend("blocked").copy(id = "d", name = "Xia"),
            friend("active").copy(id = "e", name = "Ann"),
        )
        assertEquals(listOf("d", "c", "e", "a", "b"), FriendWords.order(list).map { it.id })
        assertEquals(listOf("e", "a"), FriendWords.shareTargets(list).map { it.id })
    }

    @Test
    fun `how a sent note is doing`() {
        fun out(state: String, attempts: Int = 0, err: String? = null, via: String? = null) = OutboxItemDto("o1", "f1", "note", state, attempts, nextTry = now + 6 * 60_000, via = via, lastError = err, preview = "note: hi")
        assertEquals("Delivered", FriendWords.delivery(out("delivered"), "Alice", now).word)
        assertEquals("Alice's hub fetched it", FriendWords.delivery(out("delivered", via = "pull"), "Alice", now).word)
        assertTrue(FriendWords.delivery(out("queued"), "Alice", now).cancel)
        val waiting = FriendWords.delivery(out("queued", 2, "connection refused"), "Alice", now)
        assertEquals("Waiting", waiting.word)
        assertEquals("connection refused Trying again in 6 min.", waiting.line)
        val failed = FriendWords.delivery(out("failed"), "Alice", now)
        assertTrue(failed.retry)
        assertEquals("Alice's hub could not be reached for 7 days.", failed.line)
        assertEquals("Cancelled", FriendWords.delivery(out("cancelled"), "Alice", now).word)
    }

    @Test
    fun `why there is no composer`() {
        assertEquals("Accept Alice's request to write to them.", FriendWords.cannotWrite(friend("pending", "in")))
        assertEquals("You can write once Alice accepts.", FriendWords.cannotWrite(friend("pending", "out")))
        assertNull(FriendWords.cannotWrite(friend()))
    }

    // ----- the Inbox and read marks -----

    private fun note(id: String, at: Long, text: String = "hi", read: Boolean? = null) = InboxItemDto(id, "f1", "Alice", "note", "received", text, at, read)

    private fun share(id: String, state: String = "offered", read: Boolean = false, update: Boolean = false) =
        ReceivedShareDto(id = id, friendId = "f1", friendName = "Alice", title = "Fix flaky auth test", state = state, receivedAt = now - 60_000, read = read, updateWaiting = update, revision = 2)

    @Test
    fun `requests, key changes, notes not read yet and share cards, newest first`() {
        val friends = listOf(
            friend("active", "out", "unread" to 2, "unreadNotes" to 2, "readAt" to now - 10 * 60_000),
            friend("pending", "in").copy(id = "f2", name = "Ben", createdAt = now - 30 * 60_000),
            friend("blocked").copy(id = "f3", name = "Chen", lastSeen = now - 5 * 60_000),
        )
        val notes = listOf(note("n1", now - 20 * 60_000, "old"), note("n2", now - 5 * 60_000, "Lunch\non Friday?"), note("n3", now - 2 * 60_000, "  see   you "))
        val items = FriendWords.inbox(friends, notes, listOf(share("s1"), share("s2", "accepted", read = true), share("s3", "accepted", update = true)))
        assertEquals(listOf("share:s1", "share:s3", "note:f1", "key:f3", "request:f2"), items.map { it.id })
        val n = items.first { it.kind == FriendInboxItem.Kind.NOTE }
        assertEquals(2, n.count)
        assertEquals("see you", n.line)
        assertEquals("Sent revision 2 of 'Fix flaky auth test'", items.first { it.id == "share:s3" }.line)
        assertEquals(6, FriendWords.waiting(items))
    }

    @Test
    fun `a hub from before read marks counts each note's own flag`() {
        val old = friend()
        assertEquals(listOf("n2"), FriendWords.unreadNotes(old, listOf(note("n1", now, read = true), note("n2", now, read = false), note("n3", now))).map { it.id })
    }

    @Test
    fun `what a friend's page marks read`() {
        val f = friend("active", "out", "unread" to 3, "readAt" to now - 10 * 60_000)
        val notes = listOf(note("n1", now - 20 * 60_000), note("n2", now - 5 * 60_000), note("n3", now - 2 * 60_000))
        assertEquals(listOf("n3", "s1"), FriendWords.readTargets(f, notes, listOf(share("s1"), share("s2", read = true))))
        assertEquals(emptyList(), FriendWords.readTargets(f.copy(unread = 0), notes, listOf(share("s1"))))
    }

    // ----- events -----

    @Test
    fun `friend events decode`() {
        val e = (Frame.parse("""{"type":"friend.updated","seq":3,"ts":1,"friend":{"id":"f1","name":"Alice","fingerprint":"$fp","status":"active","direction":"out","verified":true,"safetyCode":"1","grants":{"receiveShares":true},"addresses":[{"url":"https://a","kind":"stable"}],"createdAt":1,"queued":0,"unread":1}}""") as Frame.Event).envelope.event
        assertTrue(e is EngineEvent.FriendUpdated)
        assertEquals(1, (e as EngineEvent.FriendUpdated).friend.unread)
        val s = (Frame.parse("""{"type":"friend.share","seq":4,"ts":1,"change":"received","share":{"id":"r1","shareId":"s1","friendId":"f1","friendName":"Alice","fingerprint":"$fp","kind":"session","title":"T","revision":1,"updateWaiting":false,"summary":{"messages":4,"sessions":1,"code":{"kind":"diff","files":2},"bytes":100},"line":"Alice sent 'T' (session, 4 messages, diff 2 files)","state":"offered","receivedAt":2,"sessions":[],"read":false}}""") as Frame.Event).envelope.event
        assertTrue(s is EngineEvent.FriendShare)
        assertEquals("received", (s as EngineEvent.FriendShare).change)
        assertEquals(2, s.share.summary.code?.files)
        val m = (Frame.parse("""{"type":"friend.message","seq":5,"ts":1,"message":{"id":"n1","friendId":"f1","friendName":"Alice","type":"note","state":"received","text":"hi","receivedAt":3}}""") as Frame.Event).envelope.event
        assertEquals("hi", (m as EngineEvent.FriendMessage).message.text)
    }

    // ----- the invite's QR code -----

    @Test
    fun `the hub's QR code reads back module for module`() {
        val sample = ConclaveJson.parseToJsonElement(javaClass.getResource("/friend-invite-qr.json")!!.readText()) as JsonObject
        val svg = (sample["svg"] as JsonPrimitive).content
        val rows = (sample["rows"] as JsonArray).map { (it as JsonPrimitive).content }
        val q = QrCode.parse(svg)!!
        // the hub's code has a one module margin
        assertEquals(rows.size + 2, q.size)
        for (y in rows.indices) for (x in rows.indices) assertEquals(rows[y][x] == '1', q[x + 1, y + 1], "module $x,$y")
        for (i in 0 until q.size) {
            assertFalse(q[i, 0])
            assertFalse(q[0, i])
        }
        // the finder pattern's dark ring
        for (i in 0 until 7) assertTrue(q[1 + i, 1])
        assertNull(QrCode.parse("<svg/>"))
    }

    @Test(timeout = 5_000)
    fun `odd numbers in a QR code's path neither throw nor run for long`() {
        // runs far past the code on every row: each marks only the modules inside it, at once
        val rows = (0 until 21).joinToString("") { "M0 $it.5h2147483000" }
        val q = QrCode.parse("""<svg viewBox="0 0 21 21"><path stroke="#000" d="$rows"/></svg>""")!!
        assertEquals(21 * 21, q.count)
        // backwards, far below zero, huge rows and numbers too big for a double are left out or refused
        val odd = QrCode.parse("""<svg viewBox="0 0 21 21"><path stroke="#000" d="M20 2.5h-2147483000M0 2147483000.5h20M3 4.5H2147483000"/></svg>""")!!
        assertEquals(20 + 18, odd.count)
        assertNull(QrCode.parse("""<svg viewBox="0 0 21 21"><path stroke="#000" d="M0 0.5h1${"0".repeat(400)}"/></svg>"""))
    }
}
