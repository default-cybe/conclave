package dev.conclave.client.map

import dev.conclave.client.model.MapDevice
import dev.conclave.client.model.MapGroup
import dev.conclave.client.model.MapNode
import dev.conclave.client.model.MapNodeKind
import dev.conclave.client.model.MapSnapshot
import dev.conclave.client.model.MapState
import java.text.Collator
import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/*
 * Where everything sits on the Map (docs/DESIGN.md 29), the same as the
 * web's features/map/layout.ts. Pure: the same snapshot always gives the
 * same picture, and MapLayoutTest checks that no two marks or labels touch.
 *
 * The hub is at (0, 0), in dp. Its children (devices, and the groups on the
 * hub itself) stack in bands to its left and right, and each subtree grows
 * outward in columns: device, project, session, subagent. Every leaf has a
 * row of its own and a parent sits at the middle of its children, so rows
 * never collide. A node with children carries its label above it; a leaf
 * carries it beside, on the outer side. Last, each side bends gently around
 * the hub; when a bend would make two things touch, it is made smaller
 * until nothing does.
 */

enum class LKind { HUB, DEVICE, GROUP, NODE }

/** A box in map units (dp at zoom 1). */
data class LBox(val x: Double, val y: Double, val w: Double, val h: Double)

enum class LabelPlace { BESIDE, ABOVE, BELOW }

data class LLabel(
    val x: Double,
    val y: Double,
    val w: Double,
    val h: Double,
    val place: LabelPlace,
    val title: String,
    val meta: String,
) {
    val box: LBox get() = LBox(x, y, w, h)
}

class LNode(
    val id: String,
    val kind: LKind,
    val node: MapNode?,
    val group: MapGroup?,
    val device: MapDevice?,
    val x: Double,
    val y: Double,
    /** Radius of the mark. */
    val r: Double,
    /** 1: right of the hub, -1: left. The hub is 0. */
    val side: Int,
    val depth: Int,
    /** The node it hangs off on the map (the hub for the first ring). */
    val parent: String?,
    val leaf: Boolean,
    val label: LLabel,
)

/** One link per child: a cubic from the child to the parent, x0 y0, c1, c2, x3 y3. */
class LLink(val id: String, val from: String, val to: String, val p: DoubleArray)

class MapLayout(val nodes: List<LNode>, val byId: Map<String, LNode>, val links: List<LLink>, val bounds: LBox)

/** Text fonts the labels use: title 13 medium, meta 12, name 14 semibold (the hub and groups). */
enum class LFont { TITLE, META, NAME }

/** Text width in dp. */
typealias Measure = (text: String, font: LFont) -> Double

enum class Sides { BOTH, RIGHT }

data class LayoutOptions(
    val measure: Measure = MapLayouts.approxMeasure,
    /** BOTH: subtrees left and right of the hub. RIGHT: all on the right, for a tall phone screen. */
    val sides: Sides = Sides.BOTH,
    /** Phones: tighter columns. */
    val compact: Boolean = false,
    /** The screen's width over its height: rows spread apart (up to 1.7 times) until the map is about that shape. */
    val aspect: Double? = null,
    val now: Long = System.currentTimeMillis(),
)

/** A box of a mark or a label, with the node it belongs to. */
data class MarkBox(val id: String, val label: Boolean, val x: Double, val y: Double, val w: Double, val h: Double)

object MapLayouts {
    const val ROW = 40.0
    const val LABEL_H = 32.0

    /** Room above a node with children for its label. */
    const val LABEL_PAD = 38.0
    const val TITLE_MAX = 184.0
    const val NAME_MAX = 200.0
    private const val GAP = 10.0
    private const val BAND_GAP = 14.0
    const val HUB_R = 34.0
    private const val MARGIN = 2.0

    /** Mark radius by kind. */
    fun markRadius(kind: LKind, n: MapNode? = null): Double = when {
        kind == LKind.HUB -> HUB_R
        kind == LKind.DEVICE -> 7.0
        kind == LKind.GROUP -> 11.0
        n?.kind == MapNodeKind.WORKFLOW -> 7.0
        n?.kind == MapNodeKind.SUBAGENT || n?.kind == MapNodeKind.AGENT -> 4.5
        else -> 6.0
    }

    /** A width guess per character for Mona Sans; the app passes a real measure. */
    val approxMeasure: Measure = { text, font ->
        val size = when (font) {
            LFont.NAME -> 14.0
            LFont.TITLE -> 13.0
            LFont.META -> 12.0
        }
        var w = 0.0
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            w += when {
                cp < 128 && "il.,:;!|'`".indexOf(cp.toChar()) >= 0 -> 0.27
                cp == ' '.code -> 0.28
                cp < 128 && "mwMW@".indexOf(cp.toChar()) >= 0 -> 0.82
                cp in 'A'.code..'Z'.code -> 0.66
                cp in '0'.code..'9'.code -> 0.58
                else -> 0.53
            }
        }
        ceil(w * size * (if (font == LFont.NAME) 1.04 else 1.0))
    }

    /** The words a node's label shows: its title, then its short id and state (or how long it has been stuck). */
    fun labelWords(n: MapNode, now: Long): Pair<String, String> =
        n.title to "${MapWords.shortId(n.id)}  ${MapWords.stuckWords(n, now) ?: MapWords.stateWord(n.state)}"

    /** The hub's label: its name, then what waits or runs. */
    fun hubWords(hubName: String, nodes: List<MapNode>, online: Boolean = true): Pair<String, String> {
        val counted = nodes.filter { it.kind != MapNodeKind.WORKFLOW }
        val running = counted.count { it.state == MapState.RUNNING }
        val waiting = counted.count { it.state == MapState.WAITING }
        val meta = when {
            !online -> "offline"
            waiting > 0 -> "$waiting waiting on you"
            running > 0 -> "$running running"
            else -> "idle"
        }
        return hubName to meta
    }

    private class T(
        val id: String,
        val kind: LKind,
        val depth: Int,
        val title: String,
        val meta: String,
        val lw: Double,
        val r: Double,
        val node: MapNode? = null,
        val group: MapGroup? = null,
        val device: MapDevice? = null,
    ) {
        var children: List<T> = emptyList()
        var side: Int = 1
        var extent: Double = 0.0
        var x: Double = 0.0
        var y: Double = 0.0
    }

    private val collator: Collator = Collator.getInstance(Locale.ROOT)

    /** The map's picture for a snapshot. */
    fun layout(snap: MapSnapshot, opts: LayoutOptions = LayoutOptions()): MapLayout =
        layout(snap.hub.name, snap.nodes, snap.groups, snap.devices, opts)

    fun layout(hubName: String, nodes: List<MapNode>, groupList: List<MapGroup>, deviceList: List<MapDevice>, opts: LayoutOptions = LayoutOptions()): MapLayout {
        val measure = opts.measure
        val now = opts.now
        val compact = opts.compact

        // ----- the tree ---------------------------------------------------------------
        val nodeIds = nodes.map { it.id }.toHashSet()
        val groupIds = groupList.map { it.id }.toHashSet()
        val kids = LinkedHashMap<String, MutableList<MapNode>>()
        val tops = LinkedHashMap<String, MutableList<MapNode>>()
        for (n in nodes) {
            val p = n.parentId
            if (p != null && p in nodeIds) kids.getOrPut(p) { ArrayList() }.add(n) else tops.getOrPut(n.group) { ArrayList() }.add(n)
        }
        val byStart = compareBy<MapNode>({ it.startedAt }, { it.id })

        // the widest the second line can get, so a state that changes never moves the map
        fun mk(id: String, kind: LKind, depth: Int, title: String, meta: String, wide: String, font: LFont, node: MapNode? = null, group: MapGroup? = null, device: MapDevice? = null): T {
            val cap = if (kind == LKind.NODE) TITLE_MAX else NAME_MAX
            val lw = max(
                max(min(cap, measure(title, font)), min(cap, max(measure(meta, LFont.META), measure(wide, LFont.META)))),
                if (kind == LKind.NODE) 118.0 else 60.0,
            ) + 4
            return T(id, kind, depth, title, meta, lw, markRadius(kind, node), node, group, device)
        }

        val seen = HashSet<String>()
        fun nodeT(n: MapNode, depth: Int): T {
            seen.add(n.id)
            val (title, meta) = labelWords(n, now)
            val t = mk(n.id, LKind.NODE, depth, title, meta, "${MapWords.shortId(n.id)}  ${MapWords.stateWord(MapState.WAITING)}", LFont.TITLE, node = n)
            t.children = (kids[n.id] ?: emptyList()).filter { it.id !in seen }.sortedWith(byStart).map { nodeT(it, depth + 1) }
            return t
        }
        fun groupT(g: MapGroup, depth: Int): T {
            val line = MapWords.groupLine(MapWords.groupStats(g.id, nodes), g.isChats)
            val t = mk("grp:${g.id}", LKind.GROUP, depth, g.name, line, line, LFont.NAME, group = g)
            t.children = (tops[g.id] ?: emptyList()).sortedWith(byStart).map { nodeT(it, depth + 1) }
            return t
        }

        // nodes whose group is missing from the snapshot still get one
        val groups = ArrayList(groupList)
        for (g in tops.keys) {
            if (g !in groupIds) groups.add(MapGroup(id = g, kind = "folder", name = g.split(':').last().ifEmpty { g }, device = "local"))
        }
        val byName = Comparator<MapGroup> { a, b ->
            val chats = (if (a.isChats) 1 else 0) - (if (b.isChats) 1 else 0)
            if (chats != 0) return@Comparator chats
            val names = collator.compare(a.name, b.name)
            if (names != 0) return@Comparator names
            a.id.compareTo(b.id)
        }
        val devices = LinkedHashMap<String, MapDevice>()
        for (d in deviceList) devices[d.id] = d
        for (g in groups) if (g.device != "local" && g.device !in devices) devices[g.device] = MapDevice(id = g.device, name = g.device)

        val first = ArrayList<T>()
        for (g in groups.filter { it.device == "local" && !it.isChats }.sortedWith(byName)) first.add(groupT(g, 1))
        val deviceOrder = Comparator<MapDevice> { a, b ->
            val names = collator.compare(a.name, b.name)
            if (names != 0) names else a.id.compareTo(b.id)
        }
        for (d in devices.values.filter { it.id != "local" }.sortedWith(deviceOrder)) {
            val meta = when (d.online) {
                null -> "device"
                true -> "online"
                false -> "offline"
            }
            val t = mk("dev:${d.id}", LKind.DEVICE, 1, d.name, meta, "offline", LFont.NAME, device = d)
            t.children = groups.filter { it.device == d.id }.sortedWith(byName).map { groupT(it, 2) }
            first.add(t)
        }
        for (g in groups.filter { it.isChats }) first.add(groupT(g, 1))

        // ----- bands: every leaf a row, a parent above its children -------------------
        fun extent(t: T): Double {
            if (t.children.isEmpty()) {
                t.extent = ROW
                return ROW
            }
            var h = LABEL_PAD
            t.children.forEachIndexed { i, c ->
                h += extent(c) + (if (i > 0 && (c.children.isNotEmpty() || t.children[i - 1].children.isNotEmpty())) 8.0 else 0.0)
            }
            t.extent = h
            return h
        }
        for (t in first) extent(t)

        val right = ArrayList<T>()
        val left = ArrayList<T>()
        var loadRight = 0.0
        var loadLeft = 0.0
        for (t in first) {
            if (opts.sides == Sides.RIGHT || loadRight <= loadLeft) {
                right.add(t)
                loadRight += t.extent + BAND_GAP
            } else {
                left.add(t)
                loadLeft += t.extent + BAND_GAP
            }
        }

        // ----- columns ---------------------------------------------------------------------
        val all = ArrayList<T>()
        fun walk(t: T, side: Int) {
            t.side = side
            all.add(t)
            for (c in t.children) walk(c, side)
        }
        for (t in right) walk(t, 1)
        for (t in left) walk(t, -1)
        val (hubTitle, hubMeta) = hubWords(hubName, nodes, true)
        val hubW = max(max(measure(hubTitle, LFont.NAME), measure("$hubMeta   ", LFont.META)), 2 * HUB_R) + 4
        val maxDepth = all.maxOfOrNull { it.depth } ?: 0
        fun halfAbove(d: Int): Double = all.filter { it.depth == d && it.children.isNotEmpty() }.maxOfOrNull { it.lw / 2 } ?: 0.0
        val minGap = if (compact) 100.0 else 112.0
        val colX = DoubleArray(maxDepth + 2)
        colX[1] = max(max(if (compact) 132.0 else 150.0, hubW / 2 + halfAbove(1) + 28), HUB_R + 60)
        for (d in 1 until maxDepth) colX[d + 1] = colX[d] + max(max(minGap, halfAbove(d) + halfAbove(d + 1) + 24), halfAbove(d) + 52)

        fun place(t: T, top: Double) {
            t.x = t.side * colX[t.depth]
            if (t.children.isEmpty()) {
                t.y = top + ROW / 2
                return
            }
            var y = top + LABEL_PAD
            t.children.forEachIndexed { i, c ->
                if (i > 0 && (c.children.isNotEmpty() || t.children[i - 1].children.isNotEmpty())) y += 8
                place(c, y)
                y += c.extent
            }
            t.y = (t.children.first().y + t.children.last().y) / 2
        }
        for (band in listOf(right, left)) {
            val total = band.sumOf { it.extent } + max(0, band.size - 1) * BAND_GAP
            var y = -total / 2
            for (t in band) {
                place(t, y)
                y += t.extent + BAND_GAP
            }
        }

        // ----- a wide screen and a flat map: spread the rows, never closer, so nothing new can touch ---
        val aspect = opts.aspect
        if (aspect != null && aspect > 0 && all.isNotEmpty()) {
            var x0 = -hubW / 2
            var x1 = hubW / 2
            var y0 = -HUB_R
            var y1 = HUB_R + 10 + LABEL_H
            for (t in all) {
                x0 = min(x0, t.x - (if (t.side == -1) t.lw + 20 else t.lw / 2))
                x1 = max(x1, t.x + (if (t.side == 1) t.lw + 20 else t.lw / 2))
                y0 = min(y0, t.y - ROW)
                y1 = max(y1, t.y + ROW)
            }
            val stretch = min(1.7, max(1.0, (x1 - x0) / aspect / max(1.0, y1 - y0)))
            if (stretch > 1.02) for (t in all) t.y *= stretch
        }

        // each side bends by its own height, so one side growing leaves the other where it was
        val bendRight = bend(all.filter { it.side == 1 }.maxOfOrNull { abs(it.y) } ?: 1.0, colX[1], compact)
        val bendLeft = bend(all.filter { it.side == -1 }.maxOfOrNull { abs(it.y) } ?: 1.0, colX[1], compact)

        // ----- the result, with the largest bend that keeps everything apart ---------------
        fun build(k: Double): MapLayout {
            val out = ArrayList<LNode>()
            out.add(
                LNode(
                    id = "hub", kind = LKind.HUB, node = null, group = null, device = null, x = 0.0, y = 0.0, r = HUB_R, side = 0, depth = 0, parent = null, leaf = false,
                    label = LLabel(-hubW / 2, HUB_R + 10, hubW, LABEL_H, LabelPlace.BELOW, hubTitle, hubMeta),
                ),
            )
            val parentOf = HashMap<String, String>()
            for (t in first) parentOf[t.id] = "hub"
            for (t in all) for (c in t.children) parentOf[c.id] = t.id
            for (t in all) {
                val bendBy = if (t.side == 1) bendRight else bendLeft
                val x = t.x - t.side * k * bendBy * t.y * t.y
                val leaf = t.children.isEmpty()
                val label = if (leaf) {
                    LLabel(if (t.side == 1) x + t.r + GAP else x - t.r - GAP - t.lw, t.y - LABEL_H / 2, t.lw, LABEL_H, LabelPlace.BESIDE, t.title, t.meta)
                } else {
                    LLabel(x - t.lw / 2, t.y - t.r - 6 - LABEL_H, t.lw, LABEL_H, LabelPlace.ABOVE, t.title, t.meta)
                }
                out.add(LNode(t.id, t.kind, t.node, t.group, t.device, x, t.y, t.r, t.side, t.depth, parentOf[t.id], leaf, label))
            }
            val byId = LinkedHashMap<String, LNode>()
            for (n in out) byId[n.id] = n
            val links = ArrayList<LLink>()
            for (n in out) {
                val pid = n.parent ?: continue
                val p = byId[pid] ?: continue
                val dx = p.x - n.x
                links.add(LLink(n.id, n.id, p.id, doubleArrayOf(n.x, n.y, n.x + dx * 0.5, n.y, p.x - dx * 0.5, p.y, p.x, p.y)))
            }
            var bx0 = Double.POSITIVE_INFINITY
            var by0 = Double.POSITIVE_INFINITY
            var bx1 = Double.NEGATIVE_INFINITY
            var by1 = Double.NEGATIVE_INFINITY
            for (b in boxes(out)) {
                bx0 = min(bx0, b.x)
                by0 = min(by0, b.y)
                bx1 = max(bx1, b.x + b.w)
                by1 = max(by1, b.y + b.h)
            }
            return MapLayout(out, byId, links, LBox(bx0, by0, bx1 - bx0, by1 - by0))
        }

        var k = 1.0
        while (k > 0.02) {
            val l = build(k)
            if (overlaps(l.nodes).isEmpty()) return l
            k /= 2
        }
        return build(0.0)
    }

    private fun bend(maxY: Double, col1: Double, compact: Boolean): Double {
        val m = max(1.0, maxY)
        return min(if (compact) 0.0005 else 0.0007, (0.3 * col1) / (m * m))
    }

    /** Every mark and label as a box, with the node it belongs to. */
    fun boxes(nodes: List<LNode>): List<MarkBox> {
        val out = ArrayList<MarkBox>(nodes.size * 2)
        for (n in nodes) {
            out.add(MarkBox(n.id, false, n.x - n.r, n.y - n.r, 2 * n.r, 2 * n.r))
            out.add(MarkBox(n.id, true, n.label.x, n.label.y, n.label.w, n.label.h))
        }
        return out
    }

    /** Pairs of marks or labels of different nodes that touch (2 apart at least), as "id:mark" and "id:label". */
    fun overlaps(nodes: List<LNode>): List<Pair<String, String>> {
        val b = boxes(nodes)
        val out = ArrayList<Pair<String, String>>()
        for (i in b.indices) {
            for (j in i + 1 until b.size) {
                val p = b[i]
                val q = b[j]
                if (p.id == q.id) continue
                if (p.x < q.x + q.w + MARGIN && q.x < p.x + p.w + MARGIN && p.y < q.y + q.h + MARGIN && q.y < p.y + p.h + MARGIN) {
                    out.add("${p.id}:${if (p.label) "label" else "mark"}" to "${q.id}:${if (q.label) "label" else "mark"}")
                }
            }
        }
        return out
    }

    /**
     * Where a phone opens the map: the hub and its busiest project (the most
     * running and waiting, then the most agents). The hub's knot, and the
     * project's mark and label. A hub with no project gives its chats, and an
     * empty hub the hub alone.
     */
    fun focusBox(l: MapLayout, nodes: List<MapNode>): LBox {
        val groups = l.nodes.filter { it.kind == LKind.GROUP && it.group != null }
        fun score(n: LNode): IntArray {
            val g = n.group!!
            val s = MapWords.groupStats(g.id, nodes)
            return intArrayOf(if (g.isChats) 0 else 1, s.running + s.waiting, s.agents)
        }
        fun better(a: LNode, b: LNode): Boolean {
            val x = score(a)
            val y = score(b)
            for (i in x.indices) if (x[i] != y[i]) return x[i] > y[i]
            return a.id < b.id
        }
        var top: LNode? = null
        for (n in groups) if (top == null || better(n, top)) top = n
        val parts = boxes(listOfNotNull(l.byId["hub"], top)).filter { it.id != "hub" || !it.label }
        if (parts.isEmpty()) return l.bounds
        val x0 = parts.minOf { it.x }
        val y0 = parts.minOf { it.y }
        return LBox(x0, y0, parts.maxOf { it.x + it.w } - x0, parts.maxOf { it.y + it.h } - y0)
    }

    /** A point on a link's cubic at t (0 at the child, 1 at the parent), into [out]. */
    fun cubicAt(p: DoubleArray, t: Double, out: DoubleArray = DoubleArray(2)): DoubleArray {
        val u = 1 - t
        val a = u * u * u
        val b = 3 * u * u * t
        val c = 3 * u * t * t
        val d = t * t * t
        out[0] = a * p[0] + b * p[2] + c * p[4] + d * p[6]
        out[1] = a * p[1] + b * p[3] + c * p[5] + d * p[7]
        return out
    }

    /**
     * The node a tap at the map point (x, y) lands on: a mark within [slop]
     * (a finger needs more than a 12dp dot), else a label. The hub, devices
     * and groups are not picked; nodes nearest first.
     */
    fun hit(l: MapLayout, x: Double, y: Double, slop: Double): LNode? {
        var best: LNode? = null
        var bestD = Double.POSITIVE_INFINITY
        for (n in l.nodes) {
            if (n.kind != LKind.NODE) continue
            val dx = x - n.x
            val dy = y - n.y
            val d = kotlin.math.sqrt(dx * dx + dy * dy)
            if (d <= n.r + slop && d < bestD) {
                best = n
                bestD = d
            }
        }
        if (best != null) return best
        return l.nodes.firstOrNull { n ->
            n.kind == LKind.NODE && x >= n.label.x && x <= n.label.x + n.label.w && y >= n.label.y && y <= n.label.y + n.label.h
        }
    }

    /**
     * What changes where things sit: ids, parents, groups, titles, devices,
     * and a stuck node's minutes in steps of ten. States do not move the map,
     * so a layout keyed on this stays put while work runs.
     */
    fun structureKey(s: MapSnapshot, now: Long): String = buildString {
        append(s.hub.name).append('|')
        for (d in s.devices) append(d.id).append(',').append(d.name).append(',').append(d.online).append(';')
        append('|')
        for (g in s.groups) {
            append(g.id).append(',').append(g.name).append(',').append(g.device).append(',')
            append(MapWords.groupLine(MapWords.groupStats(g.id, s.nodes), g.isChats)).append(';')
        }
        append('|')
        for (n in s.nodes) {
            append(n.id).append(',').append(n.parentId).append(',').append(n.group).append(',').append(n.kind.wire).append(',').append(n.title).append(',')
            append(n.stuckSince?.let { Math.round((now - it) / 600_000.0) } ?: 0).append(';')
        }
    }
}
