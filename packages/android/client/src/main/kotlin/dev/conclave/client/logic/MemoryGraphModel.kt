package dev.conclave.client.logic

import dev.conclave.client.map.LFont
import dev.conclave.client.map.MapLabels
import dev.conclave.client.map.Measure
import dev.conclave.client.model.MapNodeKind
import dev.conclave.client.model.MemoryGraph
import dev.conclave.client.model.MemoryGraphNode
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * Memory > Map's Tree view, the web's features/memory/graph-model.ts in
 * Kotlin so MemoryMapTest checks it on the JVM. The brain in the middle,
 * the areas of the owner's life and work around it (People, Homelab, ...
 * from GET /api/memory/graph), an open area's items, an item's links. Any
 * item can be the center; then its links stand around it in groups by
 * relation. Every node is a label: each subtree grows outward in columns
 * as wide as their widest label, every leaf has a row of its own and a
 * parent sits in the middle of its children, so two labels never overlap.
 */

const val BRAIN = "brain"

fun areaId(name: String) = "area:$name"

/** An item's link: who, and the relation in words. */
data class MNbr(val id: String, val label: String)

data class MArea(val name: String, val ids: List<String>)

/** The graph indexed: each item's links most linked first, relations by count, areas biggest first with Other last. */
class MemoryIndex(
    val byId: Map<String, MemoryGraphNode>,
    val nbrs: Map<String, List<MNbr>>,
    val labels: List<Pair<String, Int>>,
    val areas: List<MArea>,
)

/** What the owner opened, hid and pulled in: the tree's input. */
data class MemoryMapState(
    val center: String = BRAIN,
    /** Rings around an item center, 1 to 3. */
    val depth: Int = 1,
    val hidden: Set<String> = setOf("mentions"),
    val dismissed: Set<String> = emptySet(),
    val open: Set<String> = emptySet(),
    val more: Map<String, Int> = emptyMap(),
    /** Links pulled in by a path: parent on the map to item. */
    val extra: List<Pair<String, String>> = emptyList(),
    val unfold: Boolean = false,
    /** Rows that fit the screen where labels read. */
    val budget: Int = 40,
)

enum class MTKind { BRAIN, AREA, FOCUS, GROUP, NODE, MORE }

class MTNode(
    val id: String,
    val kind: MTKind,
    val item: String?,
    val depth: Int,
    val via: String? = null,
    var count: Int? = null,
    val key: String? = null,
) {
    val children = ArrayList<MTNode>()
}

class MemoryTree(val root: MTNode, val items: Set<String>)

/** A label on the map: left edge, middle line, size, which side of the center it grows on. */
class MPNode(
    val id: String,
    val t: MTNode,
    val item: MemoryGraphNode?,
    val x: Double,
    val y: Double,
    val w: Double,
    val h: Double,
    val side: Int,
    val parent: String?,
    val title: String,
    val count: String?,
    val font: LFont,
) {
    /** Where a link meets it: its inner edge. */
    val inX: Double get() = if (side == -1) x + w else x

    fun outX(toward: Int): Double = if ((if (side != 0) side else toward) == -1) x else x + w
}

class MemoryLayout(
    val nodes: List<MPNode>,
    val byId: Map<String, MPNode>,
    val links: List<Pair<String, String>>,
    /** x, y, w, h. */
    val bounds: DoubleArray,
)

object MemoryMaps {
    const val CAP_AREA = 8
    const val CAP_GROUP = 8
    private const val CAP_GROUP_MIN = 3
    const val CAP_OPEN = 8
    private val CAP_DEEP = intArrayOf(0, 3, 2, 2)
    const val MORE_STEP = 20
    const val BUDGET = 240
    const val ROW = 28.0
    const val ROW_PHONE = 36.0
    private const val LABEL_H = 20.0
    private const val TITLE_MAX = 220.0
    private const val TITLE_MAX_PHONE = 170.0
    private const val COL_GAP = 44.0
    private const val COL_GAP_PHONE = 30.0

    private val KIND_WORD = mapOf("fact" to "Fact", "profile" to "Profile", "procedure" to "Procedure", "episode" to "Episode", "note" to "Note", "tag" to "Tag", "session" to "Session")
    private val OWNER = Regex("^the (user|owner)('s)?\\s+", RegexOption.IGNORE_CASE)

    fun num(n: Int): String = String.format(Locale.US, "%,d", n)

    /** Text widths without fonts, as the web's approx. */
    val approx: Measure = { text, font -> ceil(text.length * (if (font == LFont.NAME) 8.0 else if (font == LFont.TITLE) 7.0 else 6.4)) + 12 }

    /** "Fact in Conclave and Basic Memory", "Note in Basic Memory, entities/people". */
    fun nodeWords(n: MemoryGraphNode): String {
        if (n.kind == "tag") return "Tag two or more memories share"
        if (n.kind == "session") return "Session memories came from"
        val where = when (n.source) {
            "both" -> "in Conclave and Basic Memory"
            "basic-memory" -> "in Basic Memory"
            else -> "in Conclave"
        }
        val folder = if (n.kind == "note" && !n.folder.isNullOrEmpty()) ", ${n.folder}" else ""
        return "${KIND_WORD[n.kind] ?: "Item"} $where$folder"
    }

    /** A short name: 2 to 5 words, no ids, dates or slugs. A tag reads as the tag. */
    fun nodeLabel(n: MemoryGraphNode): String {
        if (n.kind == "tag") return "#${n.title}"
        val base = n.title.replaceFirst(OWNER, "")
        val l = MapLabels.mapLabel(base, MapNodeKind.CHAT)
        return if (l == "Chat") KIND_WORD[n.kind] ?: "Item" else l
    }

    private val byRank = Comparator<MemoryGraphNode> { a, b ->
        when {
            b.degree != a.degree -> b.degree - a.degree
            (b.at ?: 0) != (a.at ?: 0) -> (b.at ?: 0).compareTo(a.at ?: 0)
            else -> a.id.compareTo(b.id)
        }
    }

    fun index(g: MemoryGraph): MemoryIndex {
        val byId = LinkedHashMap<String, MemoryGraphNode>()
        for (n in g.nodes) byId[n.id] = n
        val nbrs = LinkedHashMap<String, MutableList<MNbr>>()
        for (n in g.nodes) nbrs[n.id] = ArrayList()
        val counts = LinkedHashMap<String, Int>()
        for (e in g.edges) {
            if (e.size < 3) continue
            val from = g.nodes.getOrNull(e[0]) ?: continue
            val to = g.nodes.getOrNull(e[1]) ?: continue
            val label = g.labels.getOrNull(e[2]) ?: continue
            nbrs[from.id]!!.add(MNbr(to.id, label))
            nbrs[to.id]!!.add(MNbr(from.id, label))
            counts[label] = (counts[label] ?: 0) + 1
        }
        val deg = { id: String -> byId[id]?.degree ?: 0 }
        for (list in nbrs.values) list.sortWith { a, b -> if (deg(b.id) != deg(a.id)) deg(b.id) - deg(a.id) else a.id.compareTo(b.id) }
        val labels = counts.entries.map { it.key to it.value }.sortedWith { a, b -> if (b.second != a.second) b.second - a.second else a.first.compareTo(b.first) }
        val members = LinkedHashMap<String, MutableList<MemoryGraphNode>>()
        for (n in g.nodes) members.getOrPut(n.area.ifEmpty { "Other" }) { ArrayList() }.add(n)
        // Other last whatever its size: it is what no area took
        val areas = members.map { (name, ns) -> MArea(name, ns.sortedWith(byRank).map { it.id }) }
            .sortedWith(compareBy<MArea> { if (it.name == "Other") 1 else 0 }.thenByDescending { it.ids.size }.thenBy { it.name })
        return MemoryIndex(byId, nbrs, labels, areas)
    }

    fun buildTree(ix: MemoryIndex, s: MemoryMapState): MemoryTree {
        val brain = s.center == BRAIN || !ix.byId.containsKey(s.center)
        val root = if (brain) MTNode(BRAIN, MTKind.BRAIN, null, 0, count = ix.byId.size) else MTNode(s.center, MTKind.FOCUS, s.center, 0)
        val items = LinkedHashSet<String>()
        if (!brain) items.add(s.center)
        // links pulled in hang under the parent they were pulled from
        val forced = LinkedHashMap<String, MutableList<String>>()
        val reserved = HashSet<String>()
        for ((a, b) in s.extra) {
            if (b == s.center || !ix.byId.containsKey(b)) continue
            forced.getOrPut(a) { ArrayList() }.add(b)
            reserved.add(b)
        }
        fun labelOf(a: String, b: String) = ix.nbrs[a]?.firstOrNull { it.id == b }?.label ?: "path"
        fun free(id: String) = id !in s.dismissed && id !in items && id !in reserved
        fun ok(n: MNbr) = n.label !in s.hidden && free(n.id)
        fun shownOf(key: String, cap: Int) = cap + (s.more[key] ?: 0)
        val queue = ArrayDeque<Pair<MTNode, Int>>()
        var rows = 0
        fun add(parent: MTNode, id: String, hop: Int, via: String?) {
            val t = MTNode(id, MTKind.NODE, id, parent.depth + 1, via)
            if ((parent.kind == MTKind.NODE || parent.kind == MTKind.GROUP) && parent.children.isEmpty()) rows--
            rows++
            items.add(id)
            reserved.remove(id)
            parent.children.add(t)
            queue.addLast(t to hop)
        }
        fun moreRow(parent: MTNode, key: String, left: Int) {
            if (left <= 0) return
            rows++
            parent.children.add(MTNode("more:$key", MTKind.MORE, null, parent.depth + 1, count = left, key = key))
        }

        if (brain) {
            for (a in ix.areas) {
                val id = areaId(a.name)
                val t = MTNode(id, MTKind.AREA, null, 1, via = a.name, count = a.ids.size)
                root.children.add(t)
                for (v in (forced[id] ?: emptyList()).filter { it !in items }) add(t, v, 2, null)
                if (id !in s.open) continue
                val rest = a.ids.filter { free(it) }
                val cap = shownOf(id, CAP_AREA)
                for (v in rest.take(cap)) add(t, v, 2, null)
                moreRow(t, id, rest.size - min(cap, rest.size))
            }
        } else {
            queue.addLast(root to 0)
        }

        while (queue.isNotEmpty()) {
            val (t, hop) = queue.removeFirst()
            val u = t.item!!
            val opened = u in s.open
            val pulled = (forced[u] ?: emptyList()).filter { it !in items }.map { MNbr(it, labelOf(u, it)) }
            val seen = pulled.map { it.id }.toHashSet()
            val cand = ArrayList<MNbr>()
            for (n in ix.nbrs[u] ?: emptyList()) if (n.id !in seen && ok(n)) {
                seen.add(n.id)
                cand.add(n)
            }

            if (t.kind == MTKind.FOCUS) {
                val groups = LinkedHashMap<String, Pair<MutableList<MNbr>, MutableList<MNbr>>>()
                fun group(l: String) = groups.getOrPut(l) { ArrayList<MNbr>() to ArrayList() }
                for (n in pulled) group(n.label).first.add(n)
                for (n in cand) group(n.label).second.add(n)
                val order = groups.entries.sortedWith { a, b ->
                    val na = a.value.first.size + a.value.second.size
                    val nb = b.value.first.size + b.value.second.size
                    if (nb != na) nb - na else a.key.compareTo(b.key)
                }
                // a hub with many relations shows fewer of each, so ring 1 stays about `budget` rows
                val budget = s.budget
                val per = max(CAP_GROUP_MIN, min(CAP_GROUP, floor(budget.toDouble() / max(1, order.size)).toInt() - 2))
                var spare = budget - order.size
                for ((label, g) in order) {
                    val gid = "grp:$label"
                    val n = g.first.size + g.second.size
                    val grp = MTNode(gid, MTKind.GROUP, null, 1, via = label, count = n)
                    root.children.add(grp)
                    rows++
                    val cost = min(per, n) + (if (n > per) 1 else 0) - 1
                    if (gid !in s.open && g.first.isEmpty() && !s.more.containsKey(gid) && cost > spare) continue
                    spare -= cost
                    for (p in g.first) add(grp, p.id, 1, label)
                    val cap = max(0, shownOf(gid, per) - g.first.size)
                    for (p in g.second.take(cap)) add(grp, p.id, 1, label)
                    moreRow(grp, gid, g.second.size - min(cap, g.second.size))
                }
                continue
            }
            for (n in pulled) add(t, n.id, hop + 1, n.label)
            val deep = CAP_DEEP.getOrElse(hop) { 2 }
            val grow = opened || (!brain && hop < s.depth && (s.unfold || rows + min(cand.size, deep) <= s.budget))
            if (!grow || items.size >= BUDGET) {
                // folded: the links say how many there are
                if (cand.isNotEmpty()) t.count = cand.size
                continue
            }
            val cap = shownOf(u, if (opened) CAP_OPEN else deep)
            val shown = cand.take(cap)
            for (n in shown) add(t, n.id, hop + 1, n.label)
            if (opened || hop <= 1) moreRow(t, u, cand.size - shown.size)
            else if (cand.size > shown.size) t.count = cand.size - shown.size
        }
        return MemoryTree(root, items)
    }

    /** The links to pull in so [target] hangs inside the tree under the nearest item already on it. Around the brain, its area. */
    fun pathInto(ix: MemoryIndex, center: String, onMap: Set<String>, target: String): List<Pair<String, String>>? {
        val t = ix.byId[target] ?: return null
        if (target == center) return null
        if (center == BRAIN || !ix.byId.containsKey(center)) return if (target in onMap) emptyList() else listOf(areaId(t.area.ifEmpty { "Other" }) to target)
        if (target in onMap) return emptyList()
        val prev = HashMap<String, String>()
        prev[target] = target
        val queue = ArrayDeque<String>()
        queue.addLast(target)
        while (queue.isNotEmpty()) {
            val u = queue.removeFirst()
            for (n in ix.nbrs[u] ?: emptyList()) {
                if (prev.containsKey(n.id)) continue
                prev[n.id] = u
                if (n.id in onMap) {
                    val out = ArrayList<Pair<String, String>>()
                    var a = n.id
                    while (a != target) {
                        val b = prev[a]!!
                        out.add(a to b)
                        a = b
                    }
                    return out
                }
                queue.addLast(n.id)
            }
        }
        return null
    }

    fun layoutTree(root: MTNode, ix: MemoryIndex, measure: Measure = approx, rightOnly: Boolean = false, phone: Boolean = false): MemoryLayout {
        val row = if (phone) ROW_PHONE else ROW
        val gap = if (phone) COL_GAP_PHONE else COL_GAP
        val titleMax = if (phone) TITLE_MAX_PHONE else TITLE_MAX
        val nodes = ArrayList<MPNode>()
        val byId = HashMap<String, MPNode>()
        val links = ArrayList<Pair<String, String>>()

        class Words(val title: String, val count: String?, val font: LFont)
        fun words(t: MTNode): Words {
            val count = t.count?.takeIf { it != 0 }?.let { num(it) }
            return when (t.kind) {
                MTKind.BRAIN -> Words("Brain", count, LFont.NAME)
                MTKind.AREA -> Words(t.via!!, count, LFont.NAME)
                MTKind.GROUP -> Words(t.via!!, count, LFont.META)
                MTKind.MORE -> Words("${num(t.count!!)} more", null, LFont.TITLE)
                else -> Words(nodeLabel(ix.byId[t.item!!]!!), count, if (t.kind == MTKind.FOCUS) LFont.NAME else LFont.TITLE)
            }
        }
        // the brain's name is 17, measured as a 14 name scaled up
        fun width(wd: Words, t: MTNode) = ceil(min(titleMax, measure(wd.title, wd.font)) * (if (t.kind == MTKind.BRAIN) 1.22 else 1.0)) + (wd.count?.let { measure(it, LFont.META) - 6 } ?: 0.0)

        fun leaves(t: MTNode): Int = if (t.children.isEmpty()) 1 else t.children.sumOf { leaves(it) }
        val side = HashMap<MTNode, Int>()
        val rowsBySide = intArrayOf(0, 0)
        root.children.forEachIndexed { i, g ->
            val sd = if (rightOnly) 1 else if (root.kind == MTKind.BRAIN) (if (i % 2 == 1) -1 else 1) else if (rowsBySide[0] <= rowsBySide[1]) 1 else -1
            side[g] = sd
            rowsBySide[if (sd == 1) 0 else 1] += leaves(g)
        }

        val info = HashMap<MTNode, Pair<Double, Words>>()
        val colW = HashMap<String, Double>()
        fun visit(t: MTNode, sd: Int) {
            val wd = words(t)
            val w = width(wd, t)
            info[t] = w to wd
            if (sd != 0) colW["$sd:${t.depth}"] = max(colW["$sd:${t.depth}"] ?: 0.0, w)
            for (c in t.children) visit(c, if (sd != 0) sd else side[c]!!)
        }
        visit(root, 0)
        val rootW = info[root]!!.first
        fun colX(sd: Int, d: Int): Double {
            var x = rootW / 2 + gap * 0.8
            for (i in 1 until d) x += (colW["$sd:$i"] ?: 0.0) + gap
            return x
        }

        val ys = HashMap<MTNode, Double>()
        fun place(t: MTNode, cursor: Double): Double {
            if (t.children.isEmpty()) {
                ys[t] = cursor + row / 2
                return cursor + row
            }
            var c = cursor
            for (ch in t.children) c = place(ch, c)
            ys[t] = (ys[t.children.first()]!! + ys[t.children.last()]!!) / 2
            return c
        }
        val bandGap = (row * 0.4).roundToInt().toDouble()
        for (sd in intArrayOf(1, -1)) {
            val groups = root.children.filter { side[it] == sd }
            var c = 0.0
            // air only around a group with children: a closed area is one row
            groups.forEachIndexed { i, g -> c = place(g, c + if (i > 0 && (g.children.isNotEmpty() || groups[i - 1].children.isNotEmpty())) bandGap else 0.0) }
            val shift = -c / 2
            fun move(t: MTNode) {
                ys[t] = ys[t]!! + shift
                t.children.forEach { move(it) }
            }
            groups.forEach { move(it) }
        }
        ys[root] = 0.0

        fun emit(t: MTNode, sd: Int, parent: String?) {
            val (w, wd) = info[t]!!
            val y = ys[t]!!
            val x = if (sd == 0) -w / 2 else if (sd == 1) colX(1, t.depth) else -colX(-1, t.depth) - w
            val p = MPNode(t.id, t, t.item?.let { ix.byId[it] }, x, y, w, LABEL_H, sd, parent, wd.title, wd.count, wd.font)
            nodes.add(p)
            byId[p.id] = p
            if (parent != null) links.add(parent to t.id)
            for (c in t.children) emit(c, if (sd != 0) sd else side[c]!!, t.id)
        }
        emit(root, 0, null)

        var x0 = Double.POSITIVE_INFINITY
        var y0 = Double.POSITIVE_INFINITY
        var x1 = Double.NEGATIVE_INFINITY
        var y1 = Double.NEGATIVE_INFINITY
        for (p in nodes) {
            x0 = min(x0, p.x)
            y0 = min(y0, p.y - p.h / 2)
            x1 = max(x1, p.x + p.w)
            y1 = max(y1, p.y + p.h / 2)
        }
        return MemoryLayout(nodes, byId, links, doubleArrayOf(x0 - 8, y0 - 8, x1 - x0 + 16, y1 - y0 + 16))
    }

    /** The ids from the center to a node, both ends included. */
    fun chainTo(l: MemoryLayout, id: String): List<String> {
        val out = ArrayList<String>()
        var p = l.byId[id]
        while (p != null) {
            out.add(0, p.id)
            p = p.parent?.let { l.byId[it] }
        }
        return out
    }

    /** Search: title or folder, any case; items on the map first, then the most linked. */
    fun search(ix: MemoryIndex, q: String, onMap: Set<String>): List<MemoryGraphNode> {
        val t = q.trim().lowercase()
        if (t.length < 2) return emptyList()
        val out = ix.byId.values.filter { it.title.lowercase().contains(t) || (it.folder?.lowercase()?.contains(t) ?: false) }
        return out.sortedWith(compareBy<MemoryGraphNode> { if (it.id in onMap) 0 else 1 }.then(byRank))
    }

    /** The label at a map point, with [slop] map units round each box for a finger. */
    fun hit(l: MemoryLayout, x: Double, y: Double, slop: Double): MPNode? =
        l.nodes.lastOrNull { x >= it.x - slop && x <= it.x + it.w + slop && y >= it.y - it.h / 2 - slop && y <= it.y + it.h / 2 + slop }
}
