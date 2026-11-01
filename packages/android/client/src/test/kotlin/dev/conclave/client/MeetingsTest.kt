package dev.conclave.client

import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.Meetings
import dev.conclave.client.logic.StateTone
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Meeting
import dev.conclave.client.model.MeetingInput
import dev.conclave.client.model.PrepProgress
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import java.time.Instant
import java.time.ZoneId
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Scheduled meetings on the phone (docs/design/MEETING-MODE.md 11.2, 11.9). */
class MeetingsTest {
    private lateinit var server: MockWebServer
    private val la = ZoneId.of("America/Los_Angeles")
    private val min = 60_000L
    private val hour = 60 * min
    private val day = 24 * hour

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
    private fun m(id: String, status: String, at: Long? = null, started: Long? = null, created: Long = 1) =
        Meeting(id = id, status = status, scheduledAt = at, startedAt = started, createdAt = created, cwd = "/home/me/capstone", device = "dev_mac")

    @Test
    fun sectionsFollowTheRulesOf11_2() {
        val now = 1_000 * day
        val list = listOf(
            m("live", "live", started = now - hour),
            m("soon", "ready", at = now + 10 * min),
            m("armedLater", "ready", at = now + hour),
            m("ready0451", "ready"),
            m("later", "scheduled", at = now + 2 * day),
            m("next", "scheduled", at = now + day),
            m("late", "scheduled", at = now - 2 * hour),
            m("notHeld", "scheduled", at = now - 4 * hour),
            m("ended", "ended", started = now - day),
            m("failed", "failed", created = now - 3 * day),
            m("newer", "someday"),
        )
        val s = Meetings.sections(list, now)
        assertEquals(setOf("live", "soon", "ready0451", "newer"), s.now.map { it.id }.toSet())
        assertEquals(listOf("late", "armedLater", "next", "later"), s.upcoming.map { it.id })
        assertEquals(listOf("notHeld", "ended", "failed"), s.past.map { it.id })
        assertTrue(Meetings.notHeld(list[7], now))
        assertEquals("Not held" to StateTone.DIM, Meetings.statusWord(list[7], now))
        assertEquals("Listening" to StateTone.FAULT, Meetings.statusWord(list[0], now))
    }

    @Test
    fun countdownMatchesTheTable() {
        // Mon 2 Nov 2026 10:00 in Los Angeles
        val start = Instant.parse("2026-11-02T18:00:00Z").toEpochMilli()
        assertEquals("in 3 days", Meetings.countdown(3 * day + 5 * hour, start, la))
        assertEquals("tomorrow 10:00", Meetings.countdown(30 * hour, start, la))
        assertEquals("in 14h 05m", Meetings.countdown(14 * hour + 5 * min + 30_000))
        assertEquals("in 42m", Meetings.countdown(42 * min + 10_000))
        assertEquals("in 4:12", Meetings.countdown(4 * min + 12_000))
        assertEquals("now", Meetings.countdown(0))
        assertEquals("now", Meetings.countdown(-15 * min))
        assertEquals("started 22m ago", Meetings.countdown(-22 * min))
        assertEquals(1_000, Meetings.tickMs(4 * min))
        assertEquals(60_000, Meetings.tickMs(42 * min))
        assertEquals("Mon 2 Nov, 10:00 to 11:00", Meetings.whenWords(start, 60, la))
    }

    @Test
    fun prepWordsAndProgress() {
        val base = m("a", "scheduled", at = 1)
        assertEquals("Not prepared" to StateTone.DIM, Meetings.prepWord(base))
        assertEquals("Preparing 34/120" to StateTone.SIGNAL, Meetings.prepWord(base.copy(prepState = "running", prepProgress = PrepProgress("map", 34, 120))))
        assertEquals("Prepared", Meetings.prepWord(base.copy(prepState = "done")).first)
        assertEquals("Edited", Meetings.prepWord(base.copy(prepState = "done", prepEditedAt = 5)).first)
        assertEquals("Prep failed" to StateTone.FAULT, Meetings.prepWord(base.copy(prepState = "failed")))
        // 34 done in 34 minutes: 86 left at a minute each
        val p = PrepProgress("map", 34, 120, startedAt = 0)
        assertEquals("Reading chats 34 of 120 · about 86 min left", Meetings.progressLine(p, 34 * min))
        assertEquals("Writing the prep", Meetings.progressLine(p.copy(phase = "reduce"), 0))
    }

    @Test
    fun panelMetaSaysLiveOrTheNextCountdown() {
        val now = 1_000 * day
        assertEquals("Live", Meetings.panelMeta(listOf(m("a", "live"), m("b", "scheduled", at = now + hour)), now))
        assertEquals("in 42m", Meetings.panelMeta(listOf(m("b", "scheduled", at = now + 42 * min)), now))
        assertNull(Meetings.panelMeta(listOf(m("b", "scheduled", at = now + 3 * day)), now))
        assertNull(Meetings.panelMeta(emptyList(), now))
    }

    @Test
    fun startTimeRules() {
        val now = 1_000 * day
        assertNotNullText(Meetings.startProblem(now + 4 * min, now))
        assertNull(Meetings.startProblem(now + 6 * min, now))
        assertNotNullText(Meetings.startProblem(now + 366 * day, now))
        assertTrue(Meetings.canReschedule(m("a", "ready")))
        assertFalse(Meetings.canReschedule(m("a", "ready").copy(audioClientId = "app_1")))
    }

    private fun assertNotNullText(s: String?) = assertTrue(!s.isNullOrBlank())

    @Test
    fun reminderLinksOpenTheMeeting() {
        assertEquals(DeepLink.Meetings("mtg_1"), DeepLink.parse("/meetings/mtg_1"))
        assertEquals(DeepLink.Meetings("mtg_1"), DeepLink.parse("/meetings/mtg_1?open=1"))
        assertEquals(DeepLink.Meetings(null), DeepLink.parse("/meetings"))
        assertEquals(DeepLink.Meetings("mtg_1"), DeepLink.parse("conclave://meetings/mtg_1"))
        assertEquals(DeepLink.Session("ses_1"), DeepLink.parse("/s/ses_1"))
    }

    @Test
    fun oldHubRowsAndEventsDecode() {
        // a 0.4.51 row: none of the scheduling fields
        val old = ConclaveJson.decodeFromString(Meeting.serializer(), """{"id":"mtg_1","status":"ended","cwd":"/x","title":"T","autoAnswer":"questions"}""")
        assertNull(old.scheduledAt)
        assertEquals("none", old.prepState)
        assertEquals(listOf(1440, 15), old.reminders)
        val frame = """{"type":"meeting.prep","seq":0,"ts":1,"sessionId":"ses_1","meetingId":"mtg_1","state":"running","progress":{"phase":"map","done":3,"total":9}}"""
        val e = (Frame.parse(frame) as Frame.Event).envelope.event
        assertEquals(EngineEvent.MeetingPrep("ses_1", "mtg_1", "running", PrepProgress("map", 3, 9)), e)
    }

    @Test
    fun createSendsOnlyTheFieldsSet() = runBlocking {
        server.enqueue(MockResponse(code = 201, body = """{"id":"mtg_2","status":"scheduled","scheduledAt":5}"""))
        val made = client().createMeeting(MeetingInput(device = "dev_mac", cwd = "/home/me/capstone", title = "Capstone defence", scheduledAt = 5, reminders = listOf(1440, 15)))
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/meetings", req.url.encodedPath)
        val body = req.body!!.utf8()
        assertTrue("\"scheduledAt\":5" in body && "\"reminders\":[1440,15]" in body)
        assertFalse("steering" in body)
        assertEquals("scheduled", made.status)

        server.enqueue(MockResponse(body = """{"meetings":[{"id":"mtg_2","status":"scheduled"}]}"""))
        assertEquals(1, client().meetings(view = "all").size)
        assertEquals("view=all", server.takeRequest().url.encodedQuery)
    }
}
