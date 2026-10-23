package dev.conclave.client

import dev.conclave.client.MapFixture.I
import dev.conclave.client.map.LLink
import dev.conclave.client.map.MapDeltas
import dev.conclave.client.map.MapGlide
import dev.conclave.client.map.MapOpen
import dev.conclave.client.map.MapStreams
import dev.conclave.client.map.MapViewport
import dev.conclave.client.map.MapViews
import dev.conclave.client.map.MapWords
import dev.conclave.client.map.StreamMode
import dev.conclave.client.map.StreamQuality
import dev.conclave.client.map.StreamSource
import dev.conclave.client.map.Streams
import dev.conclave.client.map.Working
import dev.conclave.client.map.LBox
import dev.conclave.client.map.Insets
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.MapDelta
import dev.conclave.client.model.MapNode
import dev.conclave.client.model.MapNodeKind
import dev.conclave.client.model.MapSnapshot
import dev.conclave.client.model.MapState
import dev.conclave.client.motion.KnotState
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Map on the phone (map/MapModel.kt, MapView.kt, MapStreams.kt), the
 * same cases as the web's test/map-model.test.ts: deltas on a snapshot, the
 * words it shows, pan and zoom, and the streams.
 */
class MapModelTest {
    private val now = Instant.parse("2026-10-20T15:00:00Z").toEpochMilli()
    private val snap = MapFixture.snapshot(now)

    private fun byId(s: MapSnapshot): Map<String, MapNode> = s.nodes.associateBy { it.id }

    private fun delta(json: String): MapDelta = MapDeltas.parse(ConclaveJson.parseToJsonElement(json) as JsonObject)!!

    // ----- deltas ---------------------------------------------------------------------

    @Test
    fun `a token rate, a tool that started and one that finished`() {
        val before = byId(snap).getValue(I.login)
        val old = before.tool!!
        val next = MapDeltas.apply(
            snap,
            delta(
                """{"at":${now + 1000},"nodes":[{"id":"${I.login}","rate":51.5,"tokensPerMin":3000,"tool":{"id":"tu_new","name":"Bash","target":"bun test src/auth","startedAt":${now + 1000}},"done":[{"id":"${old.id}","name":"${old.name}","target":"${old.target}","startedAt":${old.startedAt},"durationMs":900}],"lastActivityAt":${now + 1000}}]}""",
            ),
        )
        val n = byId(next).getValue(I.login)
        assertEquals(51.5, n.rate)
        assertEquals(3000.0, n.tokensPerMin)
        assertEquals("tu_new", n.tool?.id)
        assertEquals(old.id, n.tools.first().id)
        assertEquals(900L, n.tools.first().durationMs)
        assertTrue(n.tools.size <= 5)
        assertEquals(now + 1000, n.lastActivityAt)
        // the snapshot it came from is untouched
        assertEquals(before.rate, byId(snap).getValue(I.login).rate)
        assertEquals(now + 1000, next.at)
    }

    @Test
    fun `usage that grew adds to today`() {
        val n = byId(snap).getValue(I.auth)
        val u = n.usage
        val next = MapDeltas.apply(
            snap,
            delta("""{"at":$now,"nodes":[{"id":"${I.auth}","usage":{"inputTokens":${u.inputTokens + 1000},"outputTokens":${u.outputTokens + 200},"cacheReadTokens":${u.cacheReadTokens},"cacheWriteTokens":${u.cacheWriteTokens},"costUsd":${u.costUsd + 0.05}}}]}"""),
        )
        assertEquals(snap.totals.today.tokens + 1200, next.totals.today.tokens)
        assertEquals(snap.totals.today.costUsd + 0.05, next.totals.today.costUsd, 1e-6)
    }

    @Test
    fun `a tool that ends with nothing after it clears the current one, and a missing field keeps it`() {
        val cleared = MapDeltas.apply(snap, delta("""{"at":$now,"nodes":[{"id":"${I.auth}","tool":null}]}"""))
        assertNull(byId(cleared).getValue(I.auth).tool)
        val kept = MapDeltas.apply(snap, delta("""{"at":$now,"nodes":[{"id":"${I.auth}","rate":3}]}"""))
        assertNotNull(byId(kept).getValue(I.auth).tool)
    }

    @Test
    fun `whole nodes come and go, with the groups they need, counts and the hub follow`() {
        val login = byId(snap).getValue(I.login)
        val fresh = ConclaveJson.encodeToString(MapNode.serializer(), login.copy(id = "ses_new", title = "New one", group = "f:local:/srv", state = MapState.WAITING, waitingOn = "question"))
        val next = MapDeltas.apply(
            snap,
            delta("""{"at":$now,"nodes":[{"id":"ses_new","node":$fresh},{"id":"${I.push}","removed":true}],"groups":[{"id":"f:local:/srv","kind":"folder","name":"srv","device":"local","path":"/srv"}]}"""),
        )
        assertEquals(MapState.WAITING, byId(next).getValue("ses_new").state)
        assertNull(byId(next)[I.push])
        assertTrue(next.groups.any { it.id == "f:local:/srv" })
        assertEquals(1, next.totals.waiting)
        assertEquals(MapState.WAITING, next.hub.state)
        // the node that waited is gone and the new one waits: still one
        val calm = MapDeltas.apply(next, delta("""{"at":$now,"nodes":[{"id":"ses_new","state":"running","waitingOn":null}]}"""))
        assertEquals(0, calm.totals.waiting)
        assertEquals(MapState.RUNNING, calm.hub.state)
        assertNull(byId(calm).getValue("ses_new").waitingOn)
    }

    @Test
    fun `a child whose parent left stands on its own, patches for unknown nodes are skipped`() {
        val next = MapDeltas.apply(snap, delta("""{"at":$now,"nodes":[{"id":"${I.auth}","removed":true},{"id":"nobody","rate":9}]}"""))
        assertNull(byId(next).getValue(I.paths).parentId)
        assertNull(byId(next)["nobody"])
    }

    @Test
    fun `the event decodes from the socket, and a broken delta is none`() {
        val frame = """{"type":"map.delta","seq":0,"ts":1,"delta":{"at":5,"nodes":[{"id":"x","state":"failed","error":"boom"}],"hub":{"state":"waiting"}}}"""
        val e = (Frame.parse(frame) as Frame.Event).envelope.event
        assertTrue(e is EngineEvent.MapDeltaEvent)
        val d = MapDeltas.parse((e as EngineEvent.MapDeltaEvent).delta)!!
        assertEquals(5L, d.at)
        assertEquals(MapState.FAILED, d.nodes.single().state)
        assertEquals("boom", d.nodes.single().error)
        assertEquals(MapState.WAITING, d.hubState)
        assertNull(MapDeltas.parse(ConclaveJson.parseToJsonElement("""{"nodes":[]}""") as JsonObject))
    }

    @Test
    fun `a snapshot decodes, with a replay's devices that have no online`() {
        val s = ConclaveJson.decodeFromString(
            MapSnapshot.serializer(),
            """{"at":1,"live":false,"from":0,"hub":{"name":"madx","state":"idle"},"devices":[{"id":"mac","name":"MacBook"}],"groups":[{"id":"chats","kind":"chats","name":"Chats","device":"local"}],"nodes":[{"id":"s1","kind":"chat","title":"A","state":"sleeping","device":"local","group":"chats","startedAt":1,"lastActivityAt":1,"tools":[],"usage":{"inputTokens":1,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0.1},"tokensPerMin":0,"rate":0}],"totals":{"running":0,"waiting":0,"today":{"from":0,"tokens":3,"costUsd":0.1}},"conflicts":[{"a":"s1","b":"s2","file":"auth.ts","since":3}]}""",
        )
        assertFalse(s.live)
        assertNull(s.devices.single().online)
        assertEquals(MapState.IDLE, s.nodes.single().state)
        assertEquals("auth.ts", s.conflicts.single().file)
    }

    // ----- words ------------------------------------------------------------------------

    @Test
    fun `short ids are the last four of the random part`() {
        assertEquals("5rq4", MapWords.shortId("ses_mgwk9p34y6n3wd25rq4"))
        assertEquals("b9u7", MapWords.shortId("wf:wfr_mgwqw8y9xw1sb09b9u7"))
    }

    @Test
    fun `the hub waits before it runs, and runs count through agents, not runs`() {
        fun n(state: MapState, kind: MapNodeKind = MapNodeKind.SESSION) = MapNode(id = "x", state = state, kind = kind)
        assertEquals(MapState.WAITING, MapWords.hubState(listOf(n(MapState.RUNNING), n(MapState.WAITING))))
        assertEquals(MapState.RUNNING, MapWords.hubState(listOf(n(MapState.RUNNING), n(MapState.IDLE))))
        assertEquals(MapState.IDLE, MapWords.hubState(listOf(n(MapState.RUNNING, MapNodeKind.WORKFLOW), n(MapState.DONE))))
        val withTool = n(MapState.RUNNING).copy(tool = dev.conclave.client.model.MapTool(name = "Bash"))
        assertEquals(KnotState.TOOL, MapWords.hubKnot(MapState.RUNNING, listOf(withTool), true))
        assertEquals(KnotState.THINKING, MapWords.hubKnot(MapState.RUNNING, listOf(n(MapState.RUNNING)), true))
        assertEquals(KnotState.WAITING, MapWords.hubKnot(MapState.WAITING, emptyList(), true))
        assertEquals(KnotState.DONE, MapWords.hubKnot(MapState.IDLE, emptyList(), true))
        assertEquals(KnotState.PAUSED, MapWords.hubKnot(MapState.RUNNING, emptyList(), false))
    }

    @Test
    fun `group lines, where a node opens, stop and stuck`() {
        assertEquals("4 agents, 2 running, 1 waiting", MapWords.groupLine(dev.conclave.client.map.GroupStats(4, 2, 1)))
        assertEquals("1 agent", MapWords.groupLine(dev.conclave.client.map.GroupStats(1, 0, 0)))
        assertEquals("2 chats", MapWords.groupLine(dev.conclave.client.map.GroupStats(2, 0, 0), true))
        val s = byId(snap)
        assertEquals(MapOpen.Chat(I.week), MapWords.open(s.getValue(I.week)))
        assertEquals(MapOpen.Session(I.auth), MapWords.open(s.getValue(I.auth)))
        assertEquals(MapOpen.Run(I.run), MapWords.open(s.getValue("wf:${I.run}")))
        assertTrue(MapWords.canStop(s.getValue(I.auth)))
        assertTrue(MapWords.canStop(s.getValue(I.push)))
        assertFalse(MapWords.canStop(s.getValue(I.review)))
        assertEquals("No progress 6m", MapWords.stuckWords(s.getValue(I.backup).copy(stuckSince = now - 6 * 60_000), now))
        assertEquals("No progress 1h 15m", MapWords.stuckWords(s.getValue(I.backup).copy(stuckSince = now - 75 * 60_000), now))
        assertNull(MapWords.stuckWords(s.getValue(I.backup), now))
        assertEquals(listOf(I.explore, I.paths), MapWords.childrenOf(snap.nodes, I.auth).map { it.id })
    }

    @Test
    fun `the sentence over the map`() {
        val clock: (Long) -> String = { "14:05" }
        assertEquals("Six running, one waiting on you. 3.4M tokens and $8.12 today.", MapWords.sentenceText(MapWords.sentence(snap, null, true, clock, now)))
        val quiet = snap.copy(nodes = snap.nodes.map { it.copy(state = MapState.IDLE) })
        assertEquals("Nothing running. 3.4M tokens and $8.12 today.", MapWords.sentenceText(MapWords.sentence(quiet, null, true, clock, now)))
        val waits = snap.copy(nodes = snap.nodes.filter { it.state != MapState.RUNNING })
        assertEquals("One waiting on you. 3.4M tokens and $8.12 today.", MapWords.sentenceText(MapWords.sentence(waits, null, true, clock, now)))
        assertEquals("Replay of 14:05. Six running, one waiting on you. 3.4M tokens and $8.12 by then.", MapWords.sentenceText(MapWords.sentence(snap, now - 3_600_000, true, clock, now)))
        assertEquals("madx is offline. Six running, one waiting on you. 3.4M tokens and $8.12 today.", MapWords.sentenceText(MapWords.sentence(snap, null, false, clock, now)))
    }

    @Test
    fun `numbers and money the web way`() {
        assertEquals("3.4M", MapWords.compact(3_412_000.0))
        assertEquals("120K", MapWords.compact(120_400.0))
        assertEquals("1.2K", MapWords.compact(1_200.0))
        assertEquals("1M", MapWords.compact(999_950.0))
        assertEquals("980", MapWords.compact(980.0))
        assertEquals("$8.12", MapWords.usd(8.12))
        assertEquals("<$0.01", MapWords.usd(0.004))
        assertEquals("$0", MapWords.usd(0.0))
        assertEquals("$1.2K", MapWords.usd(1_234.0))
        assertEquals("140ms", MapWords.duration(140))
        assertEquals("1.8s", MapWords.duration(1_800))
        assertEquals("48s", MapWords.duration(48_000))
        assertEquals("5m 12s", MapWords.duration(312_000))
        assertEquals("1h 23m", MapWords.countdown(now + 83 * 60_000, now))
    }

    @Test
    fun `the drawer's words`() {
        val s = byId(snap)
        val clock: (Long) -> String = { "14:05" }
        assertEquals("for 38m", MapWords.stateDetail(s.getValue(I.auth), now, clock))
        assertEquals("resumes in 1h 23m", MapWords.stateDetail(s.getValue(I.bench), now, clock))
        assertEquals("at 14:05", MapWords.stateDetail(s.getValue(I.review), now, clock))
        assertEquals("Writing", MapWords.nowWords(s.getValue(I.auth)))
        assertEquals("Nothing running", MapWords.nowWords(s.getValue(I.review)))
        assertEquals("It waits for your approval.", MapWords.waitingWords(s.getValue(I.push)))
        assertNull(MapWords.waitingWords(s.getValue(I.auth)))
        assertEquals("just now", MapWords.lastActivity(s.getValue(I.auth), now))
        assertEquals("50m ago", MapWords.lastActivity(s.getValue(I.review), now))
        assertEquals("Session", MapWords.kindWord(MapNodeKind.SESSION))
        assertEquals("Workflow run", MapWords.kindWord(MapNodeKind.WORKFLOW))
    }

    @Test
    fun `replay ticks fall on the hour, every three hours`() {
        val zone = ZoneId.of("Europe/Berlin")
        val from = java.time.ZonedDateTime.of(2026, 10, 19, 15, 20, 0, 0, zone).toInstant().toEpochMilli()
        val ticks = MapWords.replayTicks(from, from + 24 * 3_600_000, 3, zone)
        assertEquals(8, ticks.size)
        for (t in ticks) {
            val z = Instant.ofEpochMilli(t).atZone(zone)
            assertEquals(0, z.minute)
            assertEquals(0, z.hour % 3)
        }
    }

    @Test
    fun `the time zone offset is the web's`() {
        assertEquals(-120, MapWords.tzOffset(ZoneOffset.ofHours(2)))
        assertEquals(300, MapWords.tzOffset(ZoneOffset.ofHours(-5)))
    }

    // ----- pan and zoom -----------------------------------------------------------------

    private val box = LBox(-500.0, -200.0, 1000.0, 400.0)

    @Test
    fun `fit puts the whole map inside the screen, centered between the overlays`() {
        val v = MapViews.fit(box, 1200.0, 800.0, Insets(100.0, 0.0, 100.0, 0.0), 2.0)
        assertEquals(1.2, v.k, 1e-6)
        val (x0, y0) = MapViews.toScreen(v, box.x, box.y)
        val (x1, y1) = MapViews.toScreen(v, box.x + box.w, box.y + box.h)
        assertEquals(0.0, x0, 1e-6)
        assertEquals(1200.0, x1, 1e-6)
        assertEquals(400.0, (y0 + y1) / 2, 1e-6)
        // never past the zoom it may fit at
        assertEquals(1.25, MapViews.fit(LBox(0.0, 0.0, 10.0, 10.0), 1200.0, 800.0, Insets.NONE, 1.25).k)
    }

    @Test
    fun `zoom keeps the point under the finger, within its limits`() {
        val v = MapViewport(30.0, -20.0, 1.0)
        val (wx, wy) = MapViews.toWorld(v, 400.0, 300.0)
        val z = MapViews.zoomAt(v, 400.0, 300.0, 1.5)
        val (sx, sy) = MapViews.toScreen(z, wx, wy)
        assertEquals(400.0, sx, 1e-6)
        assertEquals(300.0, sy, 1e-6)
        assertEquals(MapViews.ZOOM_MAX, MapViews.zoomAt(v, 0.0, 0.0, 100.0).k)
        assertEquals(MapViews.ZOOM_MIN, MapViews.zoomAt(v, 0.0, 0.0, 0.001).k)
    }

    @Test
    fun `a pinch zooms by the fingers' distance and follows their middle`() {
        val v = MapViewport(0.0, 0.0, 1.0)
        val p = MapViews.pinch(v, 100.0 to 100.0, 200.0 to 100.0, 80.0 to 120.0, 280.0 to 120.0)
        assertEquals(2.0, p.k, 1e-6)
        // the map point under the old middle (150, 100) is under the new middle (180, 120)
        val (sx, sy) = MapViews.toScreen(p, 150.0, 100.0)
        assertEquals(180.0, sx, 1e-6)
        assertEquals(120.0, sy, 1e-6)
    }

    @Test
    fun `a transform gesture keeps the point under its centroid`() {
        val v = MapViewport(10.0, 20.0, 1.0)
        // the fingers moved 30 right and spread to twice the zoom around (200, 200)
        val g = MapViews.gesture(v, 200.0, 200.0, 30.0, 0.0, 2.0)
        assertEquals(2.0, g.k, 1e-9)
        val (wx, wy) = MapViews.toWorld(v, 170.0, 200.0)
        val (sx, sy) = MapViews.toScreen(g, wx, wy)
        assertEquals(200.0, sx, 1e-6)
        assertEquals(200.0, sy, 1e-6)
    }

    @Test
    fun `a drag cannot lose the map off screen, and a picked node comes into sight`() {
        val v = MapViews.clamp(MapViewport(5_000.0, 0.0, 1.0), box, 1200.0, 800.0)
        val (x0, _) = MapViews.toScreen(v, box.x, 0.0)
        assertTrue(x0 <= 1200.0 - 80 + 1e-6)
        val l = dev.conclave.client.map.MapLayouts.layout(snap, dev.conclave.client.map.LayoutOptions(now = now))
        val n = l.byId.getValue(I.auth)
        val view = MapViewport(0.0, 0.0, 1.0)
        val (dx, dy) = MapViews.reveal(view, n, 390.0, 700.0, Insets(80.0, 12.0, 400.0, 12.0))
        val moved = MapViewport(view.x + dx, view.y + dy, 1.0)
        assertEquals(0.0 to 0.0, MapViews.reveal(moved, n, 390.0, 700.0, Insets(80.0, 12.0, 400.0, 12.0)).let { (a, b) -> Math.round(a).toDouble() to Math.round(b).toDouble() })
    }

    @Test
    fun `marks glide to their new places, and new ones are told apart`() {
        val g = MapGlide()
        g.set(mapOf("a" to doubleArrayOf(0.0, 0.0)), 0.0, MapGlide.MOVE_MS)
        // the first layout does not glide
        assertFalse(g.moving(0.0))
        g.set(mapOf("a" to doubleArrayOf(100.0, 0.0), "b" to doubleArrayOf(5.0, 5.0)), 1000.0, MapGlide.MOVE_MS)
        assertTrue(g.moving(1100.0))
        assertEquals(setOf("b"), g.fresh)
        val mid = g.at(1000.0 + MapGlide.MOVE_MS / 2).getValue("a")[0]
        assertTrue(mid > 50 && mid < 100, "eased out: past half way at half time ($mid)")
        assertEquals(100.0, g.at(2000.0).getValue("a")[0])
        assertFalse(g.moving(2000.0))
        assertEquals(1.0, MapGlide.easeOut(1.0), 1e-6)
        assertEquals(0.0, MapGlide.easeOut(0.0), 1e-6)
    }

    // ----- streams -----------------------------------------------------------------------

    /** Hub, a project, two agents: one fast, one quiet. */
    private val links = listOf(
        LLink("grp", "grp", "hub", doubleArrayOf(200.0, 0.0, 100.0, 0.0, 100.0, 0.0, 0.0, 0.0)),
        LLink("a", "a", "grp", doubleArrayOf(400.0, -40.0, 300.0, -40.0, 300.0, 0.0, 200.0, 0.0)),
        LLink("b", "b", "grp", doubleArrayOf(400.0, 40.0, 300.0, 40.0, 300.0, 0.0, 200.0, 0.0)),
    )

    @Test
    fun `the rate follows tokens a second, quiet is a third, lines is none`() {
        assertEquals(0.0, Streams.emitRate(0.0, StreamMode.FULL))
        assertTrue(Streams.emitRate(40.0, StreamMode.FULL) > Streams.emitRate(10.0, StreamMode.FULL))
        assertEquals(Streams.emitRate(40.0, StreamMode.FULL) * 0.3, Streams.emitRate(40.0, StreamMode.QUIET), 1e-6)
        assertEquals(0.0, Streams.emitRate(40.0, StreamMode.LINES))
        assertEquals(72.0, Streams.emitRate(500.0, StreamMode.FULL))
        // a tool running, or a request in flight, still trickles
        assertTrue(Streams.emitRate(0.0, StreamMode.FULL, Working.TOOL) > 0)
        assertTrue(Streams.emitRate(0.0, StreamMode.FULL, Working.WAITING) > 0)
        val sources = Streams.sources(snap.nodes)
        assertTrue(sources.none { it.id == "wf:${I.run}" })
        assertEquals(Working.TOKENS, sources.first { it.id == I.auth }.working)
        assertEquals(6, sources.size)
    }

    @Test
    fun `particles leave the agent, pass the project and end at the hub`() {
        val s = MapStreams(Random(7))
        s.setLinks(links)
        s.setSources(listOf(StreamSource("a", 40.0, Working.TOKENS)))
        repeat(30) { s.step(1 / 30.0) }
        assertTrue(s.count > 20, "${s.count}")
        assertTrue(s.active)
        val xs = FloatArray(s.capacity)
        val ys = FloatArray(s.capacity)
        val levels = IntArray(s.capacity)
        val drawn = s.dots(xs, ys, levels)
        assertTrue(drawn in 1..s.count)
        for (i in 0 until drawn) {
            assertTrue(xs[i] in -1f..401f && ys[i] in -60f..60f)
            assertTrue(levels[i] in 0..3)
        }
        // the source stops: the ones in flight run out at the hub
        s.setSources(emptyList())
        repeat(400) { s.step(1 / 30.0) }
        assertEquals(0, s.count)
        assertFalse(s.active)
    }

    @Test
    fun `a pulse runs to the hub on its own, lines mode empties the links`() {
        val s = MapStreams(Random(1))
        s.setLinks(links)
        s.pulse("b")
        assertEquals(1, s.count)
        s.step(0.05)
        assertEquals(1, s.count)
        var heads = 0
        s.pulses { _, _, a, head -> if (head) heads++; assertTrue(a in 0.0..1.0) }
        assertEquals(1, heads)
        s.mode = StreamMode.LINES
        s.setSources(listOf(StreamSource("a", 40.0, Working.TOKENS)))
        s.step(0.05)
        assertEquals(0, s.count)
        s.pulse("b")
        assertEquals(0, s.count)
    }

    @Test
    fun `a link that leaves the layout takes its particles with it`() {
        val s = MapStreams(Random(3))
        s.setLinks(links)
        s.setSources(listOf(StreamSource("b", 60.0, Working.TOKENS)))
        repeat(10) { s.step(1 / 30.0) }
        assertTrue(s.count > 0)
        s.setLinks(links.filter { it.id != "b" })
        assertEquals(0, s.count)
    }

    @Test
    fun `over budget, fewer particles, with room again back up slowly`() {
        val q = StreamQuality()
        repeat(40) { q.update(12.0, 40.0) }
        assertTrue(q.q < 0.2)
        repeat(400) { q.update(1.0, 16.0) }
        assertEquals(1.0, q.q)
        assertTrue(Streams.cap(StreamMode.FULL) > Streams.cap(StreamMode.QUIET))
        assertEquals(StreamMode.QUIET, StreamMode.of("quiet"))
        assertEquals(StreamMode.FULL, StreamMode.of("bogus"))
    }
}
