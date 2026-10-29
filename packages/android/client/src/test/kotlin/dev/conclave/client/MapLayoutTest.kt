package dev.conclave.client

import dev.conclave.client.MapFixture.I
import dev.conclave.client.map.Insets
import dev.conclave.client.map.LKind
import dev.conclave.client.map.LabelPlace
import dev.conclave.client.map.LayoutOptions
import dev.conclave.client.map.MapLayout
import dev.conclave.client.map.MapLayouts
import dev.conclave.client.map.MapViews
import dev.conclave.client.map.MapWords
import dev.conclave.client.map.Sides
import dev.conclave.client.model.MapDevice
import dev.conclave.client.model.MapHub
import dev.conclave.client.model.MapSnapshot
import dev.conclave.client.model.MapState
import java.time.Instant
import kotlin.math.abs
import kotlin.math.round
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The Map's layout (map/MapLayout.kt), the same cases as the web's
 * test/map-layout.test.ts: no two marks or labels overlap, whatever the hub
 * holds, the same snapshot always gives the same picture, and a phone opens
 * where labels read.
 */
class MapLayoutTest {
    private val now = Instant.parse("2026-10-20T15:00:00Z").toEpochMilli()

    private fun xy(l: MapLayout): List<String> = l.nodes.map { "${it.id} ${round(it.x * 100) / 100} ${round(it.y * 100) / 100}" }.sorted()

    private val phone = LayoutOptions(now = now, sides = Sides.RIGHT, compact = true, aspect = 0.6)

    // ----- nothing overlaps --------------------------------------------------------

    @Test
    fun `the mock hub, on a desktop and on a phone`() {
        val snap = MapFixture.snapshot(now)
        for (opts in listOf(LayoutOptions(now = now), LayoutOptions(now = now, aspect = 1.9), phone)) {
            val l = MapLayouts.layout(snap, opts)
            assertEquals(emptyList(), MapLayouts.overlaps(l.nodes))
            // the hub, four devices, four groups and every node
            assertEquals(1 + 4 + 4 + snap.nodes.size, l.nodes.size)
        }
    }

    @Test
    fun `300 random hubs, both layouts`() {
        val options = listOf(
            LayoutOptions(now = now),
            LayoutOptions(now = now, aspect = 1.9),
            LayoutOptions(now = now, sides = Sides.RIGHT, compact = true),
            LayoutOptions(now = now, sides = Sides.RIGHT, compact = true, aspect = 0.55),
        )
        for (seed in 1..300) {
            val snap = MapFixture.random(seed, now)
            for (opts in options) {
                val l = MapLayouts.layout(snap, opts)
                val bad = MapLayouts.overlaps(l.nodes)
                if (bad.isNotEmpty()) fail("seed $seed ${opts.sides}: ${bad.take(3)}")
            }
        }
    }

    @Test
    fun `an empty hub is the hub and its devices`() {
        val l = MapLayouts.layout(MapSnapshot(hub = MapHub("madx", MapState.IDLE), devices = listOf(MapDevice("local", "madx", true), MapDevice("mac", "MacBook", false))))
        assertEquals(listOf("hub", "dev:mac"), l.nodes.map { it.id })
        assertEquals(listOf("dev:mac" to "hub"), l.links.map { it.from to it.to })
        assertEquals(emptyList(), MapLayouts.overlaps(l.nodes))
    }

    // ----- a stable picture ------------------------------------------------------------

    @Test
    fun `the same snapshot gives the same layout, whatever order its nodes come in`() {
        val snap = MapFixture.snapshot(now)
        val a = MapLayouts.layout(snap, LayoutOptions(now = now))
        val b = MapLayouts.layout(snap.copy(nodes = snap.nodes.reversed(), groups = snap.groups.reversed()), LayoutOptions(now = now))
        assertEquals(xy(a), xy(b))
    }

    @Test
    fun `a new agent goes under its older siblings and leaves the other side alone`() {
        val snap = MapFixture.snapshot(now)
        val before = MapLayouts.layout(snap, LayoutOptions(now = now))
        val added = snap.nodes.first { it.id == I.login }.copy(id = "s_new", title = "A new one", startedAt = now, tool = null)
        val after = MapLayouts.layout(snap.copy(nodes = snap.nodes + added), LayoutOptions(now = now))
        fun at(l: MapLayout, id: String) = l.byId.getValue(id)
        assertTrue(at(after, "s_new").y > at(after, I.bundle).y)
        assertEquals(at(after, I.login).side, at(after, "s_new").side)
        // nodes on the other side of the hub do not move
        val other = before.nodes.filter { it.side != 0 && it.side != at(before, I.login).side }
        assertTrue(other.isNotEmpty())
        for (n in other) {
            assertEquals(n.y, at(after, n.id).y, 1e-5)
            assertEquals(n.x, at(after, n.id).x, 1e-5)
        }
    }

    @Test
    fun `children sit outside their parent, a row apart, oldest first`() {
        val l = MapLayouts.layout(MapFixture.snapshot(now), LayoutOptions(now = now))
        val run = l.byId.getValue("wf:${I.run}")
        val agents = l.nodes.filter { it.parent == run.id }
        assertEquals(listOf(I.correct, I.security, I.tests, I.docs, I.refute), agents.map { it.id })
        for (a in agents) assertTrue(abs(a.x) > abs(run.x))
        for (i in 1 until agents.size) assertTrue(agents[i].y - agents[i - 1].y >= MapLayouts.ROW - 0.01)
        // a parent with children carries its label above it, a leaf beside it
        assertEquals(LabelPlace.ABOVE, run.label.place)
        assertEquals(LabelPlace.BESIDE, agents[0].label.place)
    }

    @Test
    fun `links run from each child to its parent, and the hub is the root`() {
        val l = MapLayouts.layout(MapFixture.snapshot(now), LayoutOptions(now = now))
        assertEquals(l.nodes.size - 1, l.links.size)
        val roots = l.links.filter { it.to == "hub" }.map { it.from }.sorted()
        assertEquals(listOf("dev:arch-desktop", "dev:kali-vm", "dev:macbook", "dev:pve", "grp:chats").sorted(), roots)
        val k = l.links.first { it.from == I.auth }
        val start = MapLayouts.cubicAt(k.p, 0.0)
        assertEquals(l.byId.getValue(I.auth).x, start[0], 1e-9)
        assertEquals(l.byId.getValue(I.auth).y, start[1], 1e-9)
        val end = MapLayouts.cubicAt(k.p, 1.0)
        assertEquals(l.byId.getValue(k.to).x, end[0], 1e-6)
    }

    @Test
    fun `labels hold the short name, the mode and the state, stuck words first`() {
        val snap = MapFixture.snapshot(now)
        val l = MapLayouts.layout(snap, LayoutOptions(now = now))
        val auth = l.byId.getValue(I.auth)
        // the whole title is 185dp at the guessed measure, past TITLE_MAX: cut at a word, "to" dropped
        assertEquals("Move auth middleware", auth.label.title)
        assertEquals("Code · running", auth.label.meta)
        assertEquals("madx", l.byId.getValue("hub").label.title)
        assertEquals("1 waiting on you", l.byId.getValue("hub").label.meta)
        val stuck = snap.copy(nodes = snap.nodes.map { if (it.id == I.backup) it.copy(stuckSince = now - 6 * 60_000) else it })
        assertEquals("Sysadmin · No progress 6m", MapLayouts.layout(stuck, LayoutOptions(now = now)).byId.getValue(I.backup).label.meta)
        assertEquals("4 agents, 1 running, 1 waiting", l.byId.getValue("grp:p:prj_fernway@macbook").label.meta)
        assertEquals("2 chats", l.byId.getValue("grp:chats").label.meta)
        assertEquals("offline", l.byId.getValue("dev:kali-vm").label.meta)
    }

    @Test
    fun `a tap finds the node under the finger, mark first, then label`() {
        val l = MapLayouts.layout(MapFixture.snapshot(now), LayoutOptions(now = now))
        val auth = l.byId.getValue(I.auth)
        assertEquals(I.auth, MapLayouts.hit(l, auth.x + 3, auth.y - 2, 12.0)?.id)
        assertEquals(I.auth, MapLayouts.hit(l, auth.label.x + auth.label.w / 2, auth.label.y + auth.label.h / 2, 0.0)?.id)
        assertEquals(null, MapLayouts.hit(l, 0.0, 0.0, 12.0))
        assertEquals(null, MapLayouts.hit(l, 10_000.0, 10_000.0, 12.0))
    }

    @Test
    fun `the layout key changes with the shape, not with states`() {
        val snap = MapFixture.snapshot(now)
        val key = MapLayouts.structureKey(snap, now)
        val busier = snap.copy(nodes = snap.nodes.map { if (it.id == I.review) it.copy(rate = 40.0, tokensPerMin = 900.0) else it })
        assertEquals(key, MapLayouts.structureKey(busier, now))
        val renamed = snap.copy(nodes = snap.nodes.map { if (it.id == I.review) it.copy(title = "Another title") else it })
        assertTrue(key != MapLayouts.structureKey(renamed, now))
    }

    // ----- the phone opens where labels read ---------------------------------------------

    // a 390x844 phone: the map under the 56dp top bar, less the sentence above it and Fit and the scrubber below
    private val w = 390.0
    private val h = 844.0 - 56
    private val insets = Insets(top = 84.0, right = 12.0, bottom = 120.0, left = 12.0)

    @Test
    fun `at 12dp words or more, on the hub and its busiest project, Fit still shows it all`() {
        val snap = MapFixture.snapshot(now)
        val l = MapLayouts.layout(snap, phone)
        val busiest = l.nodes
            .filter { it.kind == LKind.GROUP && it.group?.isChats == false }
            .map { it to MapWords.groupStats(it.group!!.id, snap.nodes) }
            .sortedWith(compareByDescending<Pair<dev.conclave.client.map.LNode, dev.conclave.client.map.GroupStats>> { it.second.running + it.second.waiting }.thenByDescending { it.second.agents })
            .first().first
        val v = MapViews.start(l.bounds, MapLayouts.focusBox(l, snap.nodes), w, h, insets)
        // the whole map at Fit has labels far under 12dp; the opening view does not
        val fit = MapViews.fit(l.bounds, w, h, insets, 1.0)
        assertTrue(fit.k * MapViews.LABEL_SMALLEST < 8, "fit ${fit.k}")
        assertEquals(MapViews.READ_K, v.k)
        assertTrue(v.k * MapViews.LABEL_SMALLEST >= 12)
        fun sx(x: Double) = x * v.k + v.x
        fun sy(y: Double) = y * v.k + v.y
        val hub = l.byId.getValue("hub")
        for (n in listOf(hub, busiest)) {
            assertTrue(sx(n.x - n.r) >= insets.left, "${n.id} left")
            assertTrue(sx(n.x + n.r) <= w - insets.right, "${n.id} right")
            assertTrue(sy(n.y - n.r) >= insets.top, "${n.id} top")
            assertTrue(sy(n.y + n.r) <= h - insets.bottom, "${n.id} bottom")
        }
        assertTrue(w - sx(busiest.label.x) > busiest.label.w * v.k * 0.75)
    }

    @Test
    fun `a map that fits at that zoom opens whole, as on a desktop`() {
        // a new hub: the hub and a laptop
        val l = MapLayouts.layout(
            MapSnapshot(hub = MapHub("madx", MapState.IDLE), devices = listOf(MapDevice("local", "madx", true), MapDevice("mac", "MacBook", true))),
            LayoutOptions(sides = Sides.RIGHT, compact = true),
        )
        val v = MapViews.start(l.bounds, MapLayouts.focusBox(l, emptyList()), w, h, insets)
        assertEquals(MapViews.fit(l.bounds, w, h, insets, MapViews.READ_K), v)
        assertEquals(MapViews.READ_K, v.k)
    }
}
