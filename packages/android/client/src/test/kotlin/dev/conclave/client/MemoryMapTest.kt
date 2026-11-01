package dev.conclave.client

import dev.conclave.client.logic.BRAIN
import dev.conclave.client.logic.HoloMode
import dev.conclave.client.logic.LinkFilter
import dev.conclave.client.logic.MTKind
import dev.conclave.client.logic.MTNode
import dev.conclave.client.logic.MemoryLayout
import dev.conclave.client.logic.MemoryLinks
import dev.conclave.client.logic.MemoryMapState
import dev.conclave.client.logic.MemoryMaps
import dev.conclave.client.logic.areaId
import dev.conclave.client.model.MemoryGraph
import dev.conclave.client.model.MemoryGraphNode
import dev.conclave.client.model.MemoryGraphStore
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Memory > Map's models (logic/MemoryGraphModel.kt, logic/MemoryLinks.kt),
 * the key cases of the web's test/memory-map.test.ts: short labels, areas
 * from the data, labels that never overlap, a search path that hangs inside
 * the tree, rings and 3D places, and a capped link set that gives every
 * item its strongest link first.
 */
class MemoryMapTest {
    private fun node(id: String, kind: String = "note", source: String = "basic-memory", title: String = id, area: String = "Other", folder: String? = null, at: Long? = null, degree: Int = 0) =
        MemoryGraphNode(id = id, kind = kind, source = source, title = title, area = area, folder = folder, at = at, degree = degree)

    /** A graph from nodes and (from, to, label) links; degrees filled in. */
    private fun graph(nodes: List<MemoryGraphNode>, links: List<Triple<String, String, String>>): MemoryGraph {
        val ix = nodes.withIndex().associate { it.value.id to it.index }
        val labels = links.map { it.third }.distinct()
        val deg = IntArray(nodes.size)
        for ((a, b) in links) {
            deg[ix[a]!!]++
            deg[ix[b]!!]++
        }
        return MemoryGraph(
            nodes = nodes.mapIndexed { i, n -> n.copy(degree = deg[i]) },
            edges = links.map { (a, b, l) -> listOf(ix[a]!!, ix[b]!!, labels.indexOf(l)) },
            labels = labels,
            basicMemory = MemoryGraphStore("ok", "Basic Memory"),
        )
    }

    /** A hub with many relations, people, a homelab chain and a far note. */
    private fun world(): MemoryGraph {
        val nodes = arrayListOf(node("me", title = "Kaivalya Ahir", area = "People", folder = "entities/people"))
        val links = ArrayList<Triple<String, String, String>>()
        val rels = listOf("links to", "owns", "member of", "advises", "works at", "located at", "runs in", "depends on", "mentions", "studies", "uses", "knows", "owes")
        rels.forEachIndexed { i, r ->
            for (j in 0 until 30 - i * 2) {
                val id = "$r-$j"
                nodes.add(node(id, title = "$r thing $j", area = if (j % 2 == 1) "Homelab" else "Projects"))
                links.add(Triple("me", id, r))
            }
        }
        for (i in 0 until 40) nodes.add(node("p$i", title = "Person $i", area = "People"))
        nodes.add(node("madx", title = "Madx", area = "Homelab"))
        nodes.add(node("ct", title = "CT 127", area = "Homelab"))
        nodes.add(node("immich", title = "Immich", area = "Services"))
        nodes.add(node("ferox", title = "feroxbuster", area = "Projects"))
        links.add(Triple("ct", "madx", "hosted on"))
        links.add(Triple("immich", "ct", "runs in"))
        links.add(Triple("ferox", "immich", "links to"))
        links.add(Triple("madx", "owns-0", "owns"))
        nodes.add(node("mem:x", kind = "fact", source = "both", title = "The user deploys Conclave with bun run build on the hub", area = "Conclave"))
        return graph(nodes, links)
    }

    private fun flat(t: MTNode): List<MTNode> = listOf(t) + t.children.flatMap { flat(it) }

    private fun overlaps(l: MemoryLayout): List<String> {
        val out = ArrayList<String>()
        val ps = l.nodes
        for (i in ps.indices) for (j in i + 1 until ps.size) {
            val a = ps[i]
            val b = ps[j]
            if (a.x < b.x + b.w && b.x < a.x + a.w && a.y - a.h / 2 < b.y + b.h / 2 && b.y - b.h / 2 < a.y + a.h / 2) out.add("${a.id} / ${b.id}")
        }
        return out
    }

    // ----- words -----------------------------------------------------------------

    @Test
    fun labelsAreShortTitlesNeverIdsOrSlugs() {
        assertEquals("Deploys Conclave with bun run", MemoryMaps.nodeLabel(node("mem:a", kind = "fact", title = "The user deploys Conclave with bun run build on the hub")))
        assertEquals("Proxmox backup server notes", MemoryMaps.nodeLabel(node("n", title = "proxmox-backup-server-notes")))
        assertEquals("Fact", MemoryMaps.nodeLabel(node("n", kind = "fact", title = "ses_0mvq85rdvwmerqzy6gy")))
        assertEquals("#homelab", MemoryMaps.nodeLabel(node("t", kind = "tag", title = "homelab")))
        assertEquals("Note in Basic Memory, entities/nodes", MemoryMaps.nodeWords(node("n", folder = "entities/nodes")))
        assertEquals("Fact in Conclave and Basic Memory", MemoryMaps.nodeWords(node("m", kind = "fact", source = "both")))
    }

    // ----- the tree --------------------------------------------------------------

    @Test
    fun brainInTheMiddleAreasBiggestFirstOtherLast() {
        val ix = MemoryMaps.index(world())
        val t = MemoryMaps.buildTree(ix, MemoryMapState())
        assertEquals(MTKind.BRAIN, t.root.kind)
        assertEquals(ix.byId.size, t.root.count)
        assertEquals(listOf("Homelab", "Projects", "People", "Conclave", "Services"), t.root.children.map { it.via })
        assertTrue(t.root.children.all { it.kind == MTKind.AREA && it.children.isEmpty() })
        assertEquals(41, t.root.children.first { it.via == "People" }.count)
        assertTrue(t.items.isEmpty())
        // Other goes last whatever its size
        val other = MemoryMaps.index(graph(List(5) { node("o$it") } + node("a", area = "People"), emptyList()))
        assertEquals(listOf("People", "Other"), other.areas.map { it.name })
    }

    @Test
    fun anOpenAreaShowsItsMostLinkedItemsAndAMoreRow() {
        val ix = MemoryMaps.index(world())
        val s = MemoryMapState(open = setOf(areaId("People")))
        val people = MemoryMaps.buildTree(ix, s).root.children.first { it.via == "People" }
        assertEquals("me", people.children.first().item)
        assertEquals(MTKind.MORE, people.children.last().kind)
        assertEquals(41 - MemoryMaps.CAP_AREA, people.children.last().count)
        val more = MemoryMaps.buildTree(ix, s.copy(more = mapOf(areaId("People") to 20))).root.children.first { it.via == "People" }
        assertEquals(MemoryMaps.CAP_AREA + 20, more.children.count { it.kind == MTKind.NODE })
    }

    @Test
    fun aBigHubCapsEachGroupAndKeepsRingOneWithinTheBudget() {
        val ix = MemoryMaps.index(world())
        for (budget in listOf(12, 38)) {
            val root = MemoryMaps.buildTree(ix, MemoryMapState(center = "me", budget = budget)).root
            assertEquals(MTKind.FOCUS, root.kind)
            assertFalse(root.children.any { it.via == "mentions" })
            for (g in root.children) {
                val shown = g.children.count { it.kind == MTKind.NODE }
                val more = g.children.firstOrNull { it.kind == MTKind.MORE }
                if (shown > 0) assertEquals(g.count, shown + (more?.count ?: 0)) else assertTrue(g.children.isEmpty())
            }
            assertTrue(flat(root).count { it.children.isEmpty() } <= budget + 2)
        }
    }

    @Test
    fun ringsPastTheFirstFoldIntoCountsUntilTheyFit() {
        val ix = MemoryMaps.index(world())
        val tight = MemoryMaps.buildTree(ix, MemoryMapState(center = "ct", depth = 3, budget = 2))
        val madx = flat(tight.root).first { it.item == "madx" }
        assertTrue(madx.children.isEmpty())
        assertEquals(1, madx.count)
        val zoomed = MemoryMaps.buildTree(ix, MemoryMapState(center = "ct", depth = 3, budget = 2, unfold = true))
        assertEquals(listOf("owns-0"), flat(zoomed.root).first { it.item == "madx" }.children.map { it.item })
    }

    @Test
    fun treeLayoutLabelsNeverOverlapAndChildrenSitFurtherOut() {
        val ix = MemoryMaps.index(world())
        val states = listOf(
            MemoryMapState(open = setOf(areaId("People"), areaId("Homelab"), areaId("Projects"))),
            MemoryMapState(center = "me", budget = 38, depth = 2, unfold = true),
            MemoryMapState(center = "ct", depth = 3, unfold = true),
        )
        for (s in states) for (phone in listOf(false, true)) {
            val l = MemoryMaps.layoutTree(MemoryMaps.buildTree(ix, s).root, ix, rightOnly = phone, phone = phone)
            assertEquals(emptyList(), overlaps(l), "state $s phone $phone")
            for (p in l.nodes) {
                val par = p.parent?.let { l.byId[it] } ?: continue
                if (par.side != 0) assertTrue(if (p.side == 1) p.x > par.x + par.w else p.x + p.w < par.x, "${p.id} is not outside ${par.id}")
            }
        }
    }

    @Test
    fun searchReachesEveryItemAndThePathHangsInsideTheTree() {
        val ix = MemoryMaps.index(world())
        val s = MemoryMapState(center = "madx")
        val t = MemoryMaps.buildTree(ix, s)
        assertFalse("ferox" in t.items)
        assertEquals(listOf("ferox"), MemoryMaps.search(ix, "ferox", t.items).map { it.id })
        val pairs = MemoryMaps.pathInto(ix, "madx", t.items, "ferox")!!
        assertEquals(listOf("ct" to "immich", "immich" to "ferox"), pairs)
        val l = MemoryMaps.layoutTree(MemoryMaps.buildTree(ix, s.copy(extra = pairs)).root, ix)
        assertEquals(listOf("madx", "grp:hosted on", "ct", "immich", "ferox"), MemoryMaps.chainTo(l, "ferox"))
        assertEquals(emptyList(), overlaps(l))
        // around the brain the path is the item's area
        assertEquals(listOf(areaId("Projects") to "ferox"), MemoryMaps.pathInto(ix, BRAIN, emptySet(), "ferox"))
        val b = MemoryMaps.layoutTree(MemoryMaps.buildTree(ix, MemoryMapState(extra = listOf(areaId("Projects") to "ferox"))).root, ix)
        assertEquals(listOf(BRAIN, areaId("Projects"), "ferox"), MemoryMaps.chainTo(b, "ferox"))
        // a tap finds the label under the finger
        val ferox = b.byId["ferox"]!!
        assertEquals("ferox", MemoryMaps.hit(b, ferox.x + 2, ferox.y, 4.0)?.id)
    }

    // ----- links, rings and 3D ---------------------------------------------------

    @Test
    fun linksAreEveryItemOnceAndOnlyRealEdges() {
        val g = world()
        val ix = MemoryMaps.index(g)
        val l = MemoryLinks.layoutLinks(g, ix)
        assertEquals(g.nodes.size, l.items.size)
        assertEquals(g.nodes.size, l.items.map { it.id }.toSet().size)
        l.areas.forEachIndexed { k, a -> for (i in a.from until a.to) assertEquals(a.name, g.nodes[l.items[i].node].area).also { assertEquals(k, l.items[i].area) } }
        assertEquals(g.edges.size, l.edges.size)
        for (e in l.edges) assertEquals(l.items[e.a].area != l.items[e.b].area, e.cross)
        val noOwns = l.edges.filter { MemoryLinks.edgeOn(l, it, LinkFilter(setOf("owns"))) }
        assertFalse(noOwns.any { it.label == "owns" })
        assertTrue(l.edges.filter { MemoryLinks.edgeOn(l, it, LinkFilter(emptySet(), crossOnly = true)) }.all { it.cross })
    }

    @Test
    fun ringsOneCurvePerLinkItemsOldestFirstFoundAtTheirAngle() {
        fun n2(id: String, area: String, at: Long) = node(id, kind = "fact", source = "conclave", area = area, at = at)
        val g = MemoryGraph(
            nodes = listOf(n2("a1", "People", 3), n2("a2", "People", 1), n2("b1", "Homelab", 2), n2("c1", "Courses", 5)),
            edges = listOf(listOf(0, 2, 0), listOf(1, 0, 0), listOf(2, 3, 0)),
            labels = listOf("links to"),
        )
        val ix = MemoryMaps.index(g)
        val l = MemoryLinks.layoutLinks(g, ix)
        val h = MemoryLinks.layoutHud(l, ix)
        assertEquals(l.edges.size, h.pts.size)
        l.edges.forEachIndexed { k, e ->
            val p = h.pts[k]
            assertEquals(397.0, hypot(p[0].toDouble(), p[1].toDouble()), 0.5)
            assertEquals(atan2(sin(h.angle[e.a]), cos(h.angle[e.a])), atan2(p[1].toDouble(), p[0].toDouble()), 1e-4)
        }
        assertEquals(listOf("a2", "a1"), h.areas.first { it.name == "People" }.items.map { l.items[it].id })
        for (i in l.items.indices) {
            assertEquals(i, MemoryLinks.itemAtAngle(h, h.angle[i], 0.01))
            assertEquals(l.items[i].area, MemoryLinks.areaAtAngle(h, h.angle[i])?.i)
        }
        assertEquals(4, h.bins.sum())
    }

    private val areas = listOf("People", "Projects", "Homelab", "Conversations", "Courses", "Conclave", "Services", "Vendors", "Devices", "Security", "Topics", "Other")
    private val day = 86_400_000.0
    private val big by lazy {
        val nodes = List(2980) { i -> node("n$i", title = "Item $i", area = areas[(i * 7) % 12], at = if (i % 113 == 0) null else (1.7e12 + ((i * 7919) % 2980) * day * 0.25).toLong()) }
        val links = List(3236) { i ->
            if (i % 2 == 1) Triple("n${i % 2980}", "n${(i * 13 + 5) % 2980}", if (i % 3 != 0) "links to" else "mentions")
            else Triple("n${(i * 5) % 2968}", "n${(i * 5) % 2968 + 12}", "links to")
        }
        graph(nodes, links)
    }

    private fun dist(p: FloatArray, i: Int, c: FloatArray, a: Int) =
        hypot(hypot((p[i * 3] - c[a * 3]).toDouble(), (p[i * 3 + 1] - c[a * 3 + 1]).toDouble()), (p[i * 3 + 2] - c[a * 3 + 2]).toDouble())

    @Test
    fun clustersEveryItemInItsOwnBallAndNewerHigher() {
        val ix = MemoryMaps.index(big)
        val l = MemoryLinks.layoutLinks(big, ix)
        val h = MemoryLinks.layoutHolo(l, big.nodes, HoloMode.CLUSTERS)
        for (i in l.items.indices) {
            val a = l.items[i].area
            val d = dist(h.pos, i, h.centers, a)
            assertTrue(d <= h.radius[a] + 1e-3, "item $i outside its ball")
            for (b in l.areas.indices) if (b != a) assertTrue(dist(h.pos, i, h.centers, b) > d)
        }
        for (a in l.areas.indices) {
            assertTrue(hypot(hypot(h.centers[a * 3].toDouble(), h.centers[a * 3 + 1].toDouble()), h.centers[a * 3 + 2].toDouble()) - h.radius[a] > MemoryLinks.CORE_R)
        }
        for (ar in l.areas) {
            val ids = (ar.from until ar.to).sortedBy { big.nodes[l.items[it].node].at ?: 0L }
            val half = ids.size / 2
            fun meanY(s: List<Int>) = s.sumOf { h.pos[it * 3 + 1].toDouble() } / s.size
            assertTrue(meanY(ids.drop(half)) > meanY(ids.take(half)) + 0.25 * h.radius[l.items[ar.from].area])
        }
        // the same graph gives the same picture
        assertTrue(MemoryLinks.layoutHolo(l, big.nodes, HoloMode.CLUSTERS).pos.contentEquals(h.pos))
    }

    @Test
    fun timelineFollowsTheDatesUndatedWaitBeforeTheStart() {
        val ix = MemoryMaps.index(big)
        val l = MemoryLinks.layoutLinks(big, ix)
        val h = MemoryLinks.layoutHolo(l, big.nodes, HoloMode.TIMELINE)
        val dated = l.items.indices.mapNotNull { i -> big.nodes[l.items[i].node].at?.let { it to h.pos[i * 3] } }.sortedBy { it.first }
        for (k in 1 until dated.size) assertTrue(dated[k].second >= dated[k - 1].second)
        for (i in l.items.indices) if (big.nodes[l.items[i].node].at == null) assertTrue(h.pos[i * 3] < dated.first().second)
        for (k in 1 until h.ticks.size) assertTrue(h.ticks[k].x >= h.ticks[k - 1].x)
    }

    @Test
    fun pickEdgesGivesEveryItemItsStrongestLinkFirst() {
        val ix = MemoryMaps.index(big)
        val l = MemoryLinks.layoutLinks(big, ix)
        val on = BooleanArray(l.edges.size) { MemoryLinks.edgeOn(l, l.edges[it], LinkFilter(setOf("mentions"))) }
        val deg = IntArray(l.items.size) { big.nodes[l.items[it].node].degree }
        val all = MemoryLinks.pickEdges(l, on, Int.MAX_VALUE, deg)
        assertEquals(on.count { it }, all.size)
        for (e in all) assertNotEquals("mentions", l.edges[e].label)
        // under the cap: the cap holds, only edges the filters leave, and every linked item keeps its strongest link
        val linked = l.items.indices.count { i -> l.edgesOf[i].any { on[it] } }
        val capped = MemoryLinks.pickEdges(l, on, linked, deg)
        assertTrue(capped.size <= linked)
        for (e in capped) assertTrue(on[e])
        val kept = capped.toSet()
        val w = { e: Int -> deg[l.edges[e].a] + deg[l.edges[e].b] }
        for (i in l.items.indices) {
            val mine = l.edgesOf[i].filter { on[it] }
            if (mine.isEmpty()) continue
            val best = mine.maxOf { w(it) }
            assertTrue(mine.any { it in kept && w(it) == best }, "item $i lost its strongest link")
        }
        // a small cap still takes the strongest first
        val tiny = MemoryLinks.pickEdges(l, on, 500, deg)
        assertEquals(500, tiny.size)
        // the curve starts and ends on its items
        val holo = MemoryLinks.layoutHolo(l, big.nodes, HoloMode.CLUSTERS)
        val seg = 6
        val out = FloatArray(seg * 6)
        for (e in all.take(200)) {
            MemoryLinks.linkCurve(holo, l, e, seg, out, 0)
            val edge = l.edges[e]
            for (c in 0..2) assertTrue(abs(out[c] - holo.pos[edge.a * 3 + c]) < 1e-3)
            for (c in 0..2) assertTrue(abs(out[out.size - 3 + c] - holo.pos[edge.b * 3 + c]) < 1e-3)
        }
    }
}
