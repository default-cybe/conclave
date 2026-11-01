package dev.conclave.client

import dev.conclave.client.logic.TodayWords
import dev.conclave.client.model.Proposal
import dev.conclave.client.model.ProposedEvent
import dev.conclave.client.model.ProposedMail
import dev.conclave.client.model.Today
import dev.conclave.client.model.TodayEvent
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The day plan with the calendar and proposal cards on the phone (docs/DESIGN.md, Calendar and mail). */
class TodayTest {
    private lateinit var server: MockWebServer
    private val berlin = TodayWords.zone("Europe/Berlin")

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
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    private val todayJson = """
        {"date":"2026-10-22","timezone":"Europe/Berlin","goals":[],"tasks":{"dueToday":1,"overdue":0},
         "plan":{"date":"2026-10-22","summary":"Thesis first, then the gym.","items":[{"time":"09:30","text":"Chapter 3","kind":"focus"}],"savedAt":1},
         "events":[{"id":"ev_b","title":"Gym","start":${ms("2026-10-22T16:00:00Z")},"end":${ms("2026-10-22T17:00:00Z")},"allDay":false,"calendar":"Personal","color":"#2e7d32"},
                   {"id":"ev_a","title":"Holiday","start":${ms("2026-10-21T22:00:00Z")},"end":${ms("2026-10-22T22:00:00Z")},"allDay":true,"calendar":"Holidays"},
                   {"id":"ev_c","title":"Lecture","start":${ms("2026-10-22T08:15:00Z")},"end":${ms("2026-10-22T09:45:00Z")},"allDay":false,"calendar":"Uni","newField":1}],
         "proposals":[{"id":"prop_1","kind":"event","action":"create","status":"pending","summary":"Workout: run, Fri 23 Oct 07:00 in Personal","createdAt":1,"sessionId":"ses_1",
            "event":{"title":"Workout: run","start":${ms("2026-10-23T05:00:00Z")},"end":${ms("2026-10-23T05:45:00Z")},"allDay":false,"calendarId":"cal_1","calendar":"Personal","account":"Nextcloud","attendees":["ana@example.com"],"invites":"server"}},
          {"id":"prop_2","kind":"mail","action":"draft","status":"pending","summary":"Draft to ana","createdAt":2,
            "mail":{"accountId":"a","account":"sam@outlook.com","from":"sam@outlook.com","to":["ana@example.com"],"cc":[],"subject":"Re: Lunch","body":"Thursday works."}}],
         "somethingNew":true}
    """.trimIndent()

    @Test
    fun todayDecodesWithEventsAndProposals() = runBlocking {
        server.enqueue(MockResponse(body = todayJson))
        val t = client().today()
        assertEquals("/api/assistant/today", server.takeRequest().url.encodedPath)
        assertEquals("Thesis first, then the gym.", t.plan?.summary)
        assertEquals(listOf("Holiday", "Lecture", "Gym"), TodayWords.events(t).map { it.title })
        assertEquals(listOf("prop_1", "prop_2"), t.proposals.map { it.id })
        assertEquals("2 proposals to approve", TodayWords.waiting(t))
        assertEquals(listOf("ana@example.com"), t.proposals[0].event?.attendees)
    }

    @Test
    fun noCalendarMeansNoEventsField() {
        val t = ConclaveJson.decodeFromString(Today.serializer(), """{"date":"2026-10-22","timezone":"UTC","goals":[],"tasks":{"dueToday":0,"overdue":0}}""")
        assertNull(t.events)
        assertTrue(t.proposals.isEmpty())
        assertNull(TodayWords.waiting(t))
        assertNull(TodayWords.nextLine(t, 0))
    }

    @Test
    fun approveAndDeclineHitTheRoutes() = runBlocking {
        server.enqueue(MockResponse(body = """{"id":"prop_1","kind":"event","action":"create","status":"applied","summary":"s","createdAt":1,"result":"It is in Personal."}"""))
        val ok = client().approveProposal("prop_1")
        val r1 = server.takeRequest()
        assertEquals("POST", r1.method)
        assertEquals("/api/proposals/prop_1/approve", r1.url.encodedPath)
        assertEquals("Added", TodayWords.outcome(ok))

        server.enqueue(MockResponse(body = """{"id":"prop_2","kind":"mail","action":"draft","status":"declined","summary":"s","createdAt":1}"""))
        val no = client().declineProposal("prop_2", "not now")
        val r2 = server.takeRequest()
        assertEquals("/api/proposals/prop_2/decline", r2.url.encodedPath)
        assertEquals("""{"note":"not now"}""", r2.body?.utf8())
        assertEquals("Declined", TodayWords.outcome(no))

        server.enqueue(MockResponse(body = "[]"))
        client().proposals()
        assertEquals("status=pending", server.takeRequest().url.encodedQuery)
    }

    @Test
    fun wordsReadInTheOwnersZoneAcrossTheDstChange() {
        // Berlin leaves summer time on 25 October 2026: 18:00 local is 16:00Z before and 17:00Z after
        assertEquals("18:00", TodayWords.clock(ms("2026-10-24T16:00:00Z"), berlin))
        assertEquals("18:00", TodayWords.clock(ms("2026-10-26T17:00:00Z"), berlin))
        assertEquals("18:00 to 19:00", TodayWords.range(ms("2026-10-22T16:00:00Z"), ms("2026-10-22T17:00:00Z"), false, berlin))
        assertEquals("All day", TodayWords.range(0, 1, true, berlin))
        assertEquals("Fri 23 Oct, 07:00 to 07:45", TodayWords.whenWords(ms("2026-10-23T05:00:00Z"), ms("2026-10-23T05:45:00Z"), false, berlin))
        assertEquals("22:00 to Fri 23 Oct 03:00", TodayWords.range(ms("2026-10-22T20:00:00Z"), ms("2026-10-23T01:00:00Z"), false, berlin))
    }

    @Test
    fun anEventOrProposalTwiceIsOneRow() {
        // the Today list keys rows by id: the same id twice would close the app
        val t = ConclaveJson.decodeFromString(
            Today.serializer(),
            """{"date":"2026-10-22","timezone":"UTC","events":[
              {"id":"ev_1","title":"Standup","start":1000,"end":2000},
              {"id":"ev_1","title":"Standup","start":1000,"end":2000},
              {"id":"ev_2","title":"Lunch","start":3000,"end":4000}],
              "proposals":[{"id":"p1","summary":"a"},{"id":"p1","summary":"a"},{"id":"p2","status":"applied"}]}""".trimIndent(),
        )
        assertEquals(listOf("ev_1", "ev_2"), TodayWords.events(t).map { it.id })
        assertEquals(listOf("p1"), TodayWords.pending(t).map { it.id })
        assertEquals("1 proposal to approve", TodayWords.waiting(t))
    }

    @Test
    fun nextLine() {
        val t = ConclaveJson.decodeFromString(Today.serializer(), todayJson)
        assertEquals("Next: Lecture at 10:15", TodayWords.nextLine(t, ms("2026-10-22T06:00:00Z")))
        assertEquals("Now: Lecture, until 11:45", TodayWords.nextLine(t, ms("2026-10-22T09:00:00Z")))
        assertEquals("Today: Holiday", TodayWords.nextLine(t, ms("2026-10-22T20:00:00Z")))
    }

    @Test
    fun proposalCardsSayWhatWillBeWritten() {
        val ev = Proposal(id = "p", event = ProposedEvent(title = "Project sync", start = ms("2026-10-23T12:00:00Z"), end = ms("2026-10-23T12:30:00Z"), calendar = "Personal", account = "Nextcloud", location = "Room 3.12", attendees = listOf("ana@example.com"), invites = "server"))
        assertEquals("Add to Personal?", TodayWords.question(ev))
        assertEquals("Add", TodayWords.approve(ev))
        assertEquals(
            listOf("Project sync", "Fri 23 Oct, 14:00 to 14:30", "Personal, Nextcloud. Room 3.12", "Invites ana@example.com. The calendar sends the invitations."),
            TodayWords.cardLines(ev, berlin),
        )
        val noInvites = ev.copy(event = ev.event!!.copy(invites = "none"))
        assertEquals("With ana@example.com. This calendar sends no invitations.", TodayWords.invites(noInvites))
        assertEquals("Delete from Personal?", TodayWords.question(ev.copy(action = "delete")))
        assertEquals("Change", TodayWords.approve(ev.copy(action = "update")))

        val mail = Proposal(id = "m", kind = "mail", action = "draft", mail = ProposedMail(from = "sam@outlook.com", to = listOf("ana@example.com"), cc = listOf("ben@example.com"), subject = "Re: Lunch", body = "Thursday works."))
        assertEquals("Save this draft?", TodayWords.question(mail))
        assertEquals("Save draft", TodayWords.approve(mail))
        assertEquals(listOf("To ana@example.com, cc ben@example.com", "Re: Lunch", "Thursday works.", "From sam@outlook.com"), TodayWords.cardLines(mail, berlin))
        assertEquals("Failed: The server refused the event (403).", TodayWords.outcome(mail.copy(status = "failed", error = "The server refused the event (403).")))
        assertEquals("Send this message?", TodayWords.question(mail.copy(action = "send")))
        assertEquals(TodayEvent(id = "x").allDay, false)
    }
}
