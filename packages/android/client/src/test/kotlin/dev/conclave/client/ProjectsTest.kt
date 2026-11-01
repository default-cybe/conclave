package dev.conclave.client

import dev.conclave.client.logic.BannerAction
import dev.conclave.client.logic.Locations
import dev.conclave.client.logic.MoveOutcome
import dev.conclave.client.logic.StateTone
import dev.conclave.client.model.Device
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.LocationState
import dev.conclave.client.model.LocationVia
import dev.conclave.client.model.MachineInfo
import dev.conclave.client.model.MatchLevel
import dev.conclave.client.model.MoveInput
import dev.conclave.client.model.MoveRefusal
import dev.conclave.client.model.MoveResult
import dev.conclave.client.model.SessionLocation
import dev.conclave.client.model.SessionPatch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Folders across devices: the hub's replies decode, the calls match the routes, and the banner picks its actions. */
class ProjectsTest {
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

    private fun client() = ConclaveClient(server.url("/").toString(), "t")

    @Test
    fun moveSendsOnlyTheFieldsSetAndDecodesBothAnswers() = runBlocking {
        server.enqueue(
            MockResponse(
                body = """{"resolved":true,"cwd":"/Users/kai/Developer/portfolio","via":"syncthing","level":"exact",
                "freshness":{"stale":true,"line":"The macbook copy is 1 commit behind.","behind":1},
                "session":{"id":"s1","device":"mac","cwd":"/Users/kai/Developer/portfolio"},
                "line":"Moved to macbook at ~/Developer/portfolio (Syncthing)."}""",
            ),
        )
        val r = client().moveSession("s 1", MoveInput(device = "mac"))
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/sessions/s%201/move", req.url.encodedPath)
        assertEquals("""{"device":"mac"}""", req.body?.utf8())
        assertTrue(r.resolved)
        assertEquals(LocationVia.SYNCTHING, r.via)
        assertEquals(MatchLevel.EXACT, r.level)
        assertEquals(1, r.freshness?.behind)
        assertEquals("mac", r.session?.device)
        assertEquals(MoveOutcome.MOVED, Locations.outcome(r))

        server.enqueue(
            MockResponse(
                body = """{"resolved":false,"reason":"not-found","line":"No folder for portfolio on macbook.",
                "candidates":[{"device":"mac","path":"/Users/kai/src/portfolio","level":"weak","via":"search","line":"Same folder name only"}],
                "cloneUrl":"https://github.com/kai/portfolio.git","browseFrom":"/Users/kai/Developer"}""",
            ),
        )
        val no = client().moveSession("s1", MoveInput(device = "mac", cwd = "/Users/kai/src/portfolio", remember = true, allowMismatch = true))
        val body = ConclaveJson.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject
        assertEquals(setOf("device", "cwd", "remember", "allowMismatch"), body.keys)
        assertFalse(no.resolved)
        assertEquals(MoveRefusal.NOT_FOUND, no.reason)
        assertEquals(MatchLevel.WEAK, no.candidates.single().level)
        assertEquals("/Users/kai/Developer", no.browseFrom)
        assertEquals(MoveOutcome.CHOOSE, Locations.outcome(no))
        assertEquals(MoveOutcome.OFFLINE, Locations.outcome(MoveResult(reason = MoveRefusal.OFFLINE)))
        assertEquals(MoveOutcome.MISMATCH, Locations.outcome(MoveResult(reason = MoveRefusal.MISMATCH)))
    }

    @Test
    fun aLevelOrViaTheAppDoesNotKnowFallsBack() {
        val r = ConclaveJson.decodeFromString(MoveResult.serializer(), """{"resolved":false,"reason":"gone","candidates":[{"path":"/x","level":"perfect","via":"telepathy","line":"?"}]}""")
        assertNull(r.reason)
        assertEquals(MatchLevel.NONE, r.candidates.single().level)
        assertNull(r.candidates.single().via)
        // an unknown reason still opens Choose folder
        assertEquals(MoveOutcome.CHOOSE, Locations.outcome(r))
        val loc = ConclaveJson.decodeFromString(SessionLocation.serializer(), """{"sessionId":"s1","state":"teleported"}""")
        assertEquals(LocationState.OK, loc.state)
    }

    @Test
    fun locationIdentifyPinAndUnpinUseTheRoutes() = runBlocking {
        server.enqueue(MockResponse(body = """{"sessionId":"s1","device":"pc","deviceName":"arch-desktop","online":false,"cwd":"/home/kai/code/portfolio","state":"offline","line":"arch-desktop is offline.","history":[{"fromSeq":4,"device":"pc","root":"/home/kai/code/portfolio"}],"suggestion":{"device":"mac","deviceName":"macbook","cwd":"/Users/kai/Developer/portfolio","via":"syncthing","level":"exact"}}"""))
        val loc = client().sessionLocation("s1", refresh = true)
        val r1 = server.takeRequest()
        assertEquals("/api/sessions/s1/location", r1.url.encodedPath)
        assertEquals("1", r1.url.queryParameter("refresh"))
        assertEquals(LocationState.OFFLINE, loc.state)
        assertEquals("macbook", loc.suggestion?.deviceName)
        assertNull(loc.exists)

        server.enqueue(MockResponse(body = """{"device":"mac","path":"/Users/kai/x","identity":{"path":"/Users/kai/x","exists":true,"isGit":true,"roots":["abc"],"remotes":["github.com/kai/x"],"shallow":false,"name":"x"},"level":"mismatch","line":"Another git history than the arch-desktop copy"}"""))
        val id = client().identifyFolder("mac", "/Users/kai/x", sessionId = "s1")
        val body = ConclaveJson.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject
        assertEquals("s1", body["sessionId"]?.jsonPrimitive?.content)
        assertEquals(false, body.containsKey("projectId"))
        assertEquals(MatchLevel.MISMATCH, id.level)
        assertTrue(id.identity.isGit)

        server.enqueue(MockResponse(body = """{"id":"p1","name":"portfolio","locations":[{"projectId":"p1","device":"mac","path":"/Users/kai/Developer/portfolio","via":"pinned","pinned":true}]}"""))
        val p = client().pinLocation("p1", "mac", "/Users/kai/Developer/portfolio")
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/api/projects/p1/locations", put.url.encodedPath)
        assertTrue(p.locations.single().pinned)

        server.enqueue(MockResponse(body = """{"id":"p1","name":"portfolio","locations":[]}"""))
        client().unpinLocation("p1", "mac", "/Users/kai/Developer/portfolio")
        val del = server.takeRequest()
        assertEquals("DELETE", del.method)
        assertEquals("mac", del.url.queryParameter("device"))
        assertEquals("/Users/kai/Developer/portfolio", del.url.queryParameter("path"))
    }

    @Test
    fun movedEventDecodes() {
        val frame = Frame.parse("""{"type":"session.moved","seq":9,"ts":1,"sessionId":"s1","from":{"device":"pc","cwd":"/a"},"to":{"device":"mac","cwd":"/b"},"via":"prefix","level":"strong"}""")
        val e = (frame as Frame.Event).envelope.event as EngineEvent.SessionMoved
        assertEquals("s1", e.sessionKey)
        assertEquals("mac", e.to.device)
        assertEquals(LocationVia.PREFIX, e.via)
    }

    private fun loc(state: LocationState, exists: Boolean? = null, suggestion: Boolean = false, clone: Boolean = false, line: String? = "x") =
        ConclaveJson.decodeFromString(
            SessionLocation.serializer(),
            buildString {
                append("""{"sessionId":"s1","device":"mac","deviceName":"macbook","cwd":"/Users/kai/p","state":"${state.name.lowercase()}"""")
                if (line != null) append(""","line":"$line"""")
                if (exists != null) append(""","exists":$exists""")
                if (suggestion) append(""","suggestion":{"device":"pc","deviceName":"arch-desktop","cwd":"/home/kai/p"}""")
                if (clone) append(""","cloneUrl":"https://github.com/kai/p.git"""")
                append("}")
            },
        )

    @Test
    fun bannerActionsFollowTheState() {
        assertEquals(listOf(BannerAction.RUN_ON_SUGGESTION, BannerAction.WAIT), Locations.bannerActions(loc(LocationState.OFFLINE, suggestion = true), otherComputers = 2))
        assertEquals(listOf(BannerAction.RUN_ON_OTHER, BannerAction.WAIT), Locations.bannerActions(loc(LocationState.OFFLINE), otherComputers = 1))
        assertEquals(listOf(BannerAction.WAIT), Locations.bannerActions(loc(LocationState.OFFLINE), otherComputers = 0))
        assertEquals(
            listOf(BannerAction.CHOOSE_FOLDER, BannerAction.RUN_ON_SUGGESTION, BannerAction.CONTINUE_WITHOUT_FILES, BannerAction.CLONE_HERE),
            Locations.bannerActions(loc(LocationState.MISSING, exists = false, suggestion = true, clone = true), 0),
        )
        // after Continue without files the session runs in the home folder: look again, or set the line aside
        assertEquals(listOf(BannerAction.CHOOSE_FOLDER, BannerAction.LOOK_AGAIN, BannerAction.HIDE), Locations.bannerActions(loc(LocationState.MISSING, exists = true), 0))
        assertEquals(listOf(BannerAction.CONTINUE, BannerAction.CHECK_AGAIN), Locations.bannerActions(loc(LocationState.STALE), 0))
        assertEquals(listOf(BannerAction.CHOOSE_FOLDER), Locations.bannerActions(loc(LocationState.MISMATCH), 0))
        assertEquals(emptyList(), Locations.bannerActions(loc(LocationState.OK), 0))
        assertEquals("Run on arch-desktop", Locations.actionLabel(BannerAction.RUN_ON_SUGGESTION, loc(LocationState.OFFLINE, suggestion = true)))
        assertTrue(BannerAction.WAIT.hides && BannerAction.CONTINUE.hides && BannerAction.HIDE.hides && !BannerAction.CHOOSE_FOLDER.hides)
    }

    @Test
    fun aHiddenStateComesBackWhenItChanges() {
        val stale = loc(LocationState.STALE, line = "The macbook copy is 3 commits behind.")
        val hidden = setOf(Locations.hiddenKey(stale))
        assertFalse(Locations.shows(stale, "s1", hidden))
        assertTrue(Locations.shows(loc(LocationState.STALE, line = "The macbook copy is 4 commits behind."), "s1", hidden))
        assertFalse(Locations.shows(stale, "other", emptySet()))
        assertFalse(Locations.shows(loc(LocationState.OK), "s1", emptySet()))
        // no line from the hub still says something
        val bare = loc(LocationState.OFFLINE, line = null)
        assertTrue(Locations.shows(bare, "s1", emptySet()))
        assertEquals("macbook is offline.", Locations.bannerLine(bare))
    }

    @Test
    fun pathHelpers() {
        assertEquals("~/code/portfolio", Locations.tildePath("/home/kai/code/portfolio", "/home/kai"))
        assertEquals("~", Locations.tildePath("/home/kai", "/home/kai/"))
        assertEquals("/home/kaiser/x", Locations.tildePath("/home/kaiser/x", "/home/kai"))
        assertEquals("/srv/x", Locations.tildePath("/srv/x", null))
        assertEquals("/home/kai/code", Locations.expandTilde(" ~/code ", "/home/kai"))
        assertEquals("/home/kai", Locations.expandTilde("~", "/home/kai/"))
        assertEquals("~/code", Locations.expandTilde("~/code", null))
        assertEquals("/home/kai", Locations.parentOf("/home/kai/code/"))
        assertEquals("/", Locations.parentOf("/home"))
        assertNull(Locations.parentOf("/"))
        assertEquals("portfolio", Locations.baseName("/home/kai/code/portfolio/"))
        assertEquals("/Users/kai/Developer/portfolio", Locations.cloneInto("/Users/kai/Developer/", "portfolio"))
        assertEquals("/portfolio", Locations.cloneInto("/", "portfolio"))
        assertEquals("/Users/kai/Developer", Locations.browseStart("/Users/kai/Developer", listOf("~/code"), "/Users/kai"))
        assertEquals("/Users/kai/code", Locations.browseStart(null, listOf("~/code"), "/Users/kai"))
        assertEquals("/Users/kai", Locations.browseStart("", emptyList(), "/Users/kai"))
        assertEquals("site", Locations.projectName(loc(LocationState.MISSING).copy(projectName = "site"), "/x/site/src"))
        assertEquals("src", Locations.projectName(null, "/x/site/src"))
    }

    @Test
    fun levelWordsAndTargets() {
        assertEquals("different history", Locations.levelWord(MatchLevel.MISMATCH))
        assertEquals(StateTone.WARN, Locations.levelTone(MatchLevel.MISMATCH))
        assertEquals(StateTone.OK, Locations.levelTone(MatchLevel.STRONG))
        val devices = listOf(
            Device("phone", "Pixel", online = true, info = MachineInfo(platform = "android")),
            Device("mac", "macbook", online = true, info = MachineInfo(platform = "darwin")),
            Device("pc", "arch-desktop", online = true, info = MachineInfo(platform = "linux")),
            Device("pve", "pve", online = false),
            Device("local", "madx", online = true),
        )
        assertEquals(listOf("local", "mac"), Locations.moveTargets(devices, current = "pc").map { it.id })
    }

    @Test
    fun ultraGoesInTheSessionPatch() = runBlocking {
        server.enqueue(MockResponse(body = """{"id":"s1","ultra":true}"""))
        val s = client().setUltra("s1", true)
        assertEquals("""{"ultra":true}""", server.takeRequest().body?.utf8())
        assertEquals(true, s.ultra)
        assertEquals("""{"ultra":false}""", ConclaveJson.encodeToString(SessionPatch.serializer(), SessionPatch(ultra = false)))
    }
}
