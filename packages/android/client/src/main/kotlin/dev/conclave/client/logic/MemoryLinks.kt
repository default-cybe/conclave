package dev.conclave.client.logic

import dev.conclave.client.model.MemoryGraph
import dev.conclave.client.model.MemoryGraphNode
import java.time.Instant
import java.time.ZoneId
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Memory > Map's Rings and 3D views, the web's link-model.ts, ring-model.ts
 * and holo-model.ts in Kotlin. Every item once, grouped by area, and every
 * real link once, by index. Rings: each item a tick on one circle, areas in
 * a chain so linked ones sit side by side, links bundled through their
 * area's anchor and the core. 3D: Clusters (each area a ball on a sphere
 * round the core, newer items higher) or Timeline (time along x, areas as
 * lanes). Pure, so MemoryMapTest checks it on the JVM.
 */

class LItem(val id: String, val node: Int, val area: Int)
class LArea(val name: String, val from: Int, val to: Int)
class LEdge(val a: Int, val b: Int, val label: String, val cross: Boolean)

class LinkLayout(
    val items: List<LItem>,
    val byId: Map<String, Int>,
    val areas: List<LArea>,
    val edges: List<LEdge>,
    val edgesOf: List<IntArray>,
)

/** Relations shown, across areas only, and items stepped back (by node index). */
class LinkFilter(val hidden: Set<String>, val crossOnly: Boolean = false, val gone: ((Int) -> Boolean)? = null)

class HudArea(val i: Int, val name: String, val a0: Double, val a1: Double, val items: IntArray, val ax: Double, val ay: Double)

class HudLayout(
    val angle: DoubleArray,
    val at: DoubleArray,
    val areas: List<HudArea>,
    val ringOf: IntArray,
    /** Per edge: x0, y0, then (c1x, c1y, c2x, c2y, x, y) per Bézier segment. */
    val pts: List<FloatArray>,
    val byAngle: IntArray,
    val lo: Double,
    val hi: Double,
    val bins: IntArray,
)

enum class HoloMode { CLUSTERS, TIMELINE }

class HoloTick(val x: Double, val t: Long, val label: String, val year: Boolean)

class HoloLayout(
    val mode: HoloMode,
    /** x, y, z per item. */
    val pos: FloatArray,
    /** Per area: where its label hangs. */
    val centers: FloatArray,
    val radius: FloatArray,
    val extent: Double,
    val times: DoubleArray,
    val lo: Double,
    val hi: Double,
    val ticks: List<HoloTick>,
)

object MemoryLinks {
    const val BETA = 0.85
    const val R = 400.0
    const val CORE = 0.17
    const val ANCHOR = 0.56
    const val GAP = 0.035
    const val SEAM = 0.16
    const val CORE_R = 60.0
    const val SPAN = 1800.0
    private const val TAU = PI * 2
    private const val TOP = -PI / 2
    private val GOLD = PI * (3 - sqrt(5.0))

    fun layoutLinks(g: MemoryGraph, ix: MemoryIndex): LinkLayout {
        val index = HashMap<String, Int>()
        g.nodes.forEachIndexed { i, n -> index[n.id] = i }
        val items = ArrayList<LItem>()
        val areas = ix.areas.mapIndexed { i, a ->
            val from = items.size
            for (id in a.ids.sortedByDescending { ix.byId[it]!!.degree }) items.add(LItem(id, index[id]!!, i))
            LArea(a.name, from, items.size)
        }
        val byId = HashMap<String, Int>()
        items.forEachIndexed { i, it -> byId[it.id] = i }
        val at = IntArray(g.nodes.size) { -1 }
        items.forEachIndexed { i, it -> at[it.node] = i }
        val edges = ArrayList<LEdge>()
        val edgesOf = List(items.size) { ArrayList<Int>() }
        for (e in g.edges) {
            if (e.size < 3) continue
            val ia = at.getOrNull(e[0]) ?: -1
            val ib = at.getOrNull(e[1]) ?: -1
            val label = g.labels.getOrNull(e[2]) ?: continue
            if (ia < 0 || ib < 0 || ia == ib) continue
            edgesOf[ia].add(edges.size)
            edgesOf[ib].add(edges.size)
            edges.add(LEdge(ia, ib, label, items[ia].area != items[ib].area))
        }
        return LinkLayout(items, byId, areas, edges, edgesOf.map { it.toIntArray() })
    }

    fun edgeOn(l: LinkLayout, e: LEdge, f: LinkFilter): Boolean {
        if (e.label in f.hidden) return false
        if (f.crossOnly && !e.cross) return false
        val gone = f.gone ?: return true
        return !gone(l.items[e.a].node) && !gone(l.items[e.b].node)
    }

    /** A bundled curve through control points (Holten 2006), as Bézier segments. */
    fun bundle(ctl: List<DoubleArray>, beta: Double = BETA): FloatArray {
        val n = ctl.size
        val (x0, y0) = ctl[0].let { it[0] to it[1] }
        val (x1, y1) = ctl[n - 1].let { it[0] to it[1] }
        val s = ctl.mapIndexed { i, c ->
            val f = i.toDouble() / (n - 1)
            doubleArrayOf(beta * c[0] + (1 - beta) * (x0 + f * (x1 - x0)), beta * c[1] + (1 - beta) * (y0 + f * (y1 - y0)))
        }
        val p = listOf(s[0], s[0]) + s + listOf(s[n - 1], s[n - 1])
        val out = FloatArray(2 + 6 * (p.size - 3))
        out[0] = s[0][0].toFloat()
        out[1] = s[0][1].toFloat()
        var o = 2
        var i = 1
        while (i + 2 < p.size) {
            val b = p[i]
            val c = p[i + 1]
            val d = p[i + 2]
            for (k in 0..1) {
                out[o + k] = ((2 * b[k] + c[k]) / 3).toFloat()
                out[o + 2 + k] = ((b[k] + 2 * c[k]) / 3).toFloat()
                out[o + 4 + k] = ((b[k] + 4 * c[k] + d[k]) / 6).toFloat()
            }
            o += 6
            i++
        }
        return out
    }

    fun norm(a: Double): Double = ((a % TAU) + TAU) % TAU

    fun timeAngle(t: Double, lo: Double, hi: Double) = TOP + SEAM / 2 + ((t - lo) / max(1.0, hi - lo)) * (TAU - SEAM)

    /** Areas in a chain: the biggest first, each next the one most linked to the last. */
    fun areaChain(l: LinkLayout): List<Int> {
        val n = l.areas.size
        val w = Array(n) { DoubleArray(n) }
        for (e in l.edges) {
            val x = l.items[e.a].area
            val y = l.items[e.b].area
            if (x != y) {
                w[x][y]++
                w[y][x]++
            }
        }
        val size = { i: Int -> l.areas[i].to - l.areas[i].from }
        val left = (0 until n).sortedByDescending(size).toMutableList()
        val chain = ArrayList<Int>()
        while (left.isNotEmpty()) {
            val last = chain.lastOrNull()
            var pick = 0
            if (last != null) for (j in 1 until left.size) if (w[last][left[j]] > w[last][left[pick]]) pick = j
            chain.add(left.removeAt(pick))
        }
        return chain
    }

    fun layoutHud(l: LinkLayout, ix: MemoryIndex, nBins: Int = 120): HudLayout {
        val n = l.items.size
        val at = DoubleArray(n) { (ix.byId[l.items[it].id]?.at ?: 0L).toDouble() }
        val size = { i: Int -> l.areas[i].to - l.areas[i].from }
        val chain = areaChain(l)
        val weight = chain.map { sqrt(max(1, size(it)).toDouble()) }
        val total = weight.sum()
        val room = TAU - GAP * chain.size
        val angle = DoubleArray(n)
        val areas = ArrayList<HudArea>()
        val ringOf = IntArray(l.areas.size) { -1 }
        var a = TOP + GAP / 2
        chain.forEachIndexed { k, i ->
            val span = weight[k] / total * room
            val ids = (l.areas[i].from until l.areas[i].to).sortedWith(compareBy<Int> { at[it] }.thenBy { it })
            ids.forEachIndexed { m, j -> angle[j] = a + (m + 0.5) / ids.size * span }
            val mid = a + span / 2
            ringOf[i] = areas.size
            areas.add(HudArea(i, l.areas[i].name, a, a + span, ids.toIntArray(), cos(mid) * R * ANCHOR, sin(mid) * R * ANCHOR))
            a += span + GAP
        }
        val ri = R - 3
        val pts = l.edges.map { e ->
            val pa = areas[ringOf[l.items[e.a].area]]
            val pb = areas[ringOf[l.items[e.b].area]]
            val ctl = ArrayList<DoubleArray>()
            ctl.add(doubleArrayOf(cos(angle[e.a]) * ri, sin(angle[e.a]) * ri))
            ctl.add(doubleArrayOf(pa.ax, pa.ay))
            if (l.items[e.a].area != l.items[e.b].area) {
                ctl.add(doubleArrayOf(0.0, 0.0))
                ctl.add(doubleArrayOf(pb.ax, pb.ay))
            }
            ctl.add(doubleArrayOf(cos(angle[e.b]) * ri, sin(angle[e.b]) * ri))
            bundle(ctl)
        }
        val byAngle = (0 until n).sortedBy { norm(angle[it]) }.toIntArray()
        var lo = Double.POSITIVE_INFINITY
        var hi = Double.NEGATIVE_INFINITY
        for (t in at) if (t != 0.0) {
            lo = min(lo, t)
            hi = max(hi, t)
        }
        if (!(hi > lo)) {
            lo = 0.0
            hi = 1.0
        }
        val bins = IntArray(nBins)
        for (t in at) if (t != 0.0) bins[min(nBins - 1, floor((t - lo) / (hi - lo) * nBins).toInt())]++
        return HudLayout(angle, at, areas, ringOf, pts, byAngle, lo, hi, bins)
    }

    /** The item whose angle is nearest [a], within [tol] radians. */
    fun itemAtAngle(h: HudLayout, a: Double, tol: Double): Int? {
        val x = norm(a)
        val s = h.byAngle
        if (s.isEmpty()) return null
        var lo = 0
        var hi = s.size
        while (lo < hi) {
            val m = (lo + hi) ushr 1
            if (norm(h.angle[s[m]]) < x) lo = m + 1 else hi = m
        }
        var best: Int? = null
        var bd = tol
        for (k in intArrayOf(lo - 1, lo, lo + 1)) {
            val i = s[((k % s.size) + s.size) % s.size]
            val d = abs(norm(h.angle[i] - x + PI) - PI)
            if (d <= bd) {
                bd = d
                best = i
            }
        }
        return best
    }

    fun areaAtAngle(h: HudLayout, a: Double): HudArea? = h.areas.firstOrNull { norm(a - it.a0) <= it.a1 - it.a0 }

    /** The angle of a point on the Rings plane, for hit tests. */
    fun angleOf(x: Double, y: Double) = atan2(y, x)

    // ----- 3D ---------------------------------------------------------------------

    private fun hash(i: Int, s: Int): Double {
        var x = i * 374761393 + s * 668265263
        x = (x xor (x ushr 13)) * 1274126177
        return ((x xor (x ushr 16)).toLong() and 0xffffffffL).toDouble() / 4294967296.0
    }

    private fun normalize(v: FloatArray, i: Int) {
        val d = sqrt((v[i * 3] * v[i * 3] + v[i * 3 + 1] * v[i * 3 + 1] + v[i * 3 + 2] * v[i * 3 + 2]).toDouble()).takeIf { it != 0.0 } ?: 1.0
        for (c in 0..2) v[i * 3 + c] = (v[i * 3 + c] / d).toFloat()
    }

    private fun hyp(x: Double, y: Double, z: Double) = sqrt(x * x + y * y + z * z)

    fun layoutHolo(l: LinkLayout, nodes: List<MemoryGraphNode>, mode: HoloMode): HoloLayout {
        val n = l.items.size
        val na = l.areas.size
        val pos = FloatArray(n * 3)
        val centers = FloatArray(na * 3)
        val radius = FloatArray(na)
        val deg = DoubleArray(n) { (nodes.getOrNull(l.items[it].node)?.degree ?: 0).toDouble() }
        val at = DoubleArray(n) { (nodes.getOrNull(l.items[it].node)?.at ?: 0L).toDouble() }
        val chain = areaChain(l)
        val size = { a: Int -> max(1, l.areas[a].to - l.areas[a].from) }
        val times = at.filter { it > 0 }.sorted().toDoubleArray()
        val lo = times.firstOrNull() ?: 0.0
        val hi = times.lastOrNull() ?: 1.0
        var extent = 0.0

        if (mode == HoloMode.CLUSTERS) {
            for (a in 0 until na) radius[a] = (8 + 9 * cbrt(size(a).toDouble())).toFloat()
            val unit = areaSphere(l, chain, at)
            var r = CORE_R * 2 + (radius.maxOrNull() ?: 0f)
            for (a in 0 until na) for (b in a + 1 until na) {
                val d = hyp((unit[a * 3] - unit[b * 3]).toDouble(), (unit[a * 3 + 1] - unit[b * 3 + 1]).toDouble(), (unit[a * 3 + 2] - unit[b * 3 + 2]).toDouble())
                r = max(r, (radius[a] + radius[b]) * 1.35 / max(d, 0.05))
            }
            for (k in 0 until na * 3) centers[k] = (unit[k] * r).toFloat()
            val h = FloatArray(n)
            for (a in 0 until na) {
                val ar = l.areas[a]
                val ids = (ar.from until ar.to).sortedWith(compareBy<Int> { at[it] }.thenBy { it })
                ids.forEachIndexed { rank, i -> h[i] = if (ids.size > 1) (2f * rank / (ids.size - 1) - 1) else 0f }
            }
            val dir = FloatArray(n * 3)
            for (a in 0 until na) for (i in l.areas[a].from until l.areas[a].to) {
                val k = i - l.areas[a].from
                dir[i * 3] = cos(k * GOLD).toFloat()
                dir[i * 3 + 1] = 0f
                dir[i * 3 + 2] = sin(k * GOLD).toFloat()
            }
            val bias = FloatArray(n * 3)
            for (e in l.edges) {
                if (!e.cross) continue
                for ((u, v) in listOf(e.a to e.b, e.b to e.a)) {
                    val ca = l.items[u].area * 3
                    val cb = l.items[v].area * 3
                    val dx = (centers[cb] - centers[ca]).toDouble()
                    val dy = (centers[cb + 1] - centers[ca + 1]).toDouble()
                    val dz = (centers[cb + 2] - centers[ca + 2]).toDouble()
                    val d = hyp(dx, dy, dz).takeIf { it != 0.0 } ?: 1.0
                    bias[u * 3] += (dx / d).toFloat()
                    bias[u * 3 + 1] += (dy / d).toFloat()
                    bias[u * 3 + 2] += (dz / d).toFloat()
                }
            }
            for (i in 0 until n) {
                val d = hyp(bias[i * 3].toDouble(), bias[i * 3 + 1].toDouble(), bias[i * 3 + 2].toDouble())
                if (d != 0.0) for (c in 0..2) dir[i * 3 + c] += (0.9 * bias[i * 3 + c] / d).toFloat()
                normalize(dir, i)
            }
            val acc = FloatArray(n * 3)
            val cnt = FloatArray(n)
            repeat(6) {
                acc.fill(0f)
                cnt.fill(0f)
                for (e in l.edges) {
                    if (e.cross) continue
                    for ((u, v) in listOf(e.a to e.b, e.b to e.a)) {
                        for (c in 0..2) acc[u * 3 + c] += dir[v * 3 + c]
                        cnt[u]++
                    }
                }
                for (i in 0 until n) {
                    if (cnt[i] == 0f) continue
                    for (c in 0..2) dir[i * 3 + c] += 0.45f * acc[i * 3 + c] / cnt[i]
                    normalize(dir, i)
                }
            }
            for (a in 0 until na) {
                val ar = l.areas[a]
                val ids = (ar.from until ar.to).sortedWith(compareByDescending<Int> { deg[it] }.thenBy { it })
                ids.forEachIndexed { rank, i ->
                    val rr = radius[a] * (0.12 + 0.88 * cbrt((rank + 0.5) / ids.size))
                    val y = max(-0.98, min(0.98, 0.85 * h[i] + 0.15 * dir[i * 3 + 1]))
                    val k = i - ar.from
                    val bx = dir[i * 3] + 0.7 * cos(k * GOLD)
                    val bz = dir[i * 3 + 2] + 0.7 * sin(k * GOLD)
                    val s = sqrt(1 - y * y) / (sqrt(bx * bx + bz * bz).takeIf { it != 0.0 } ?: 1.0)
                    pos[i * 3] = (centers[a * 3] + bx * s * rr).toFloat()
                    pos[i * 3 + 1] = (centers[a * 3 + 1] + y * rr).toFloat()
                    pos[i * 3 + 2] = (centers[a * 3 + 2] + bz * s * rr).toFloat()
                }
                extent = max(extent, hyp(centers[a * 3].toDouble(), centers[a * 3 + 1].toDouble(), centers[a * 3 + 2].toDouble()) + radius[a])
            }
            return HoloLayout(mode, pos, centers, radius, extent, times, lo, hi, emptyList())
        }

        val ring = 210.0
        val lane = DoubleArray(na)
        chain.forEachIndexed { k, a -> lane[a] = k.toDouble() / na * TAU }
        for (i in 0 until n) {
            val a = l.items[i].area
            val x = if (at[i] != 0.0) timeX(times, lo, hi, at[i]) else -SPAN / 2 - 70 - hash(i, 3) * 40
            val rho = 40 + (ring - 40) * sqrt(hash(i, 1)) / (1 + 0.12 * ln(1 + deg[i]) / ln(2.0))
            val th = lane[a] + (hash(i, 2) - 0.5) * (TAU / na) * 0.8
            pos[i * 3] = x.toFloat()
            pos[i * 3 + 1] = (cos(th) * rho).toFloat()
            pos[i * 3 + 2] = (sin(th) * rho).toFloat()
        }
        for (a in 0 until na) {
            radius[a] = ring.toFloat()
            centers[a * 3] = (-SPAN / 2 - 40).toFloat()
            centers[a * 3 + 1] = (cos(lane[a]) * (ring + 40)).toFloat()
            centers[a * 3 + 2] = (sin(lane[a]) * (ring + 40)).toFloat()
        }
        val ticks = monthTicks(lo.toLong(), hi.toLong()).map { (t, label, year) -> HoloTick(timeX(times, lo, hi, t.toDouble()), t, label, year) }
        return HoloLayout(mode, pos, centers, radius, SPAN / 2 + 120, times, lo, hi, ticks)
    }

    private fun areaSphere(l: LinkLayout, chain: List<Int>, at: DoubleArray): DoubleArray {
        val na = l.areas.size
        val u = DoubleArray(na * 3)
        chain.forEachIndexed { k, a ->
            val y = if (na > 1) 1 - 2 * (k + 0.5) / na else 0.0
            val r = sqrt(1 - y * y)
            u[a * 3] = cos(k * GOLD) * r
            u[a * 3 + 1] = y
            u[a * 3 + 2] = sin(k * GOLD) * r
        }
        if (na < 2) return u
        val w = Array(na) { DoubleArray(na) }
        var top = 0.0
        for (e in l.edges) {
            val x = l.items[e.a].area
            val y = l.items[e.b].area
            if (x != y) {
                w[x][y]++
                w[y][x]++
                top = max(top, w[x][y])
            }
        }
        val f = DoubleArray(na * 3)
        val d = DoubleArray(3)
        repeat(160) {
            f.fill(0.0)
            for (a in 0 until na) for (b in 0 until na) {
                if (a == b) continue
                for (c in 0..2) d[c] = u[b * 3 + c] - u[a * 3 + c]
                val len = hyp(d[0], d[1], d[2]).takeIf { it != 0.0 } ?: 1e-3
                val k = (if (top > 0) 0.3 * sqrt(w[a][b] / top) else 0.0) * len - 0.1 / (len * len)
                for (c in 0..2) f[a * 3 + c] += k * d[c] / len
            }
            for (a in 0 until na) for (c in 0..2) u[a * 3 + c] += 0.05 * f[a * 3 + c]
            for (c in 0..2) {
                var m = 0.0
                for (a in 0 until na) m += u[a * 3 + c] / na
                for (a in 0 until na) u[a * 3 + c] -= m
            }
            for (a in 0 until na) {
                val len = hyp(u[a * 3], u[a * 3 + 1], u[a * 3 + 2]).takeIf { it != 0.0 } ?: 1.0
                for (c in 0..2) u[a * 3 + c] /= len
            }
        }
        val mean = l.areas.map { ar ->
            var s = 0.0
            var m = 0
            for (i in ar.from until ar.to) if (at[i] != 0.0) {
                s += at[i]
                m++
            }
            if (m > 0) s / m else 0.0
        }
        val dated = mean.filter { it != 0.0 }
        val avg = dated.sum() / max(1, dated.size)
        var cov = 0.0
        for (a in 0 until na) if (mean[a] != 0.0) cov += (mean[a] - avg) * u[a * 3 + 1]
        if (cov < 0) for (a in 0 until na) u[a * 3 + 1] *= -1
        return u
    }

    /** Timeline x of a time: half its place in the span, half its rank among the dated items. */
    fun timeX(times: DoubleArray, lo: Double, hi: Double, t: Double): Double {
        var a = 0
        var b = times.size
        while (a < b) {
            val m = (a + b) ushr 1
            if (times[m] < t) a = m + 1 else b = m
        }
        val lin = if (hi > lo) (t - lo) / (hi - lo) else 0.5
        val rank = if (times.size > 1) a.toDouble() / (times.size - 1) else 0.5
        return -SPAN / 2 + (0.5 * max(0.0, min(1.0, lin)) + 0.5 * min(1.0, rank)) * SPAN
    }

    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    private fun monthTicks(lo: Long, hi: Long): List<Triple<Long, String, Boolean>> {
        val out = ArrayList<Triple<Long, String, Boolean>>()
        if (hi <= lo) return out
        val zone = ZoneId.systemDefault()
        var d = Instant.ofEpochMilli(lo).atZone(zone).toLocalDate().withDayOfMonth(1).plusMonths(1)
        while (out.size < 240) {
            val t = d.atStartOfDay(zone).toInstant().toEpochMilli()
            if (t >= hi) break
            val year = d.monthValue == 1
            out.add(Triple(t, if (year) d.year.toString() else "${MONTHS[d.monthValue - 1]} ${d.year.toString().takeLast(2)}", year))
            d = d.plusMonths(1)
        }
        return out
    }

    /**
     * The links to draw: those the filters leave, and on a phone at most
     * [cap]. Each item first gets its strongest link (the one to the most
     * linked neighbour), so no item is left bare, then the rest by the
     * degrees of both ends.
     */
    fun pickEdges(l: LinkLayout, on: BooleanArray, cap: Int, deg: IntArray): IntArray {
        val ids = (l.edges.indices).filter { on[it] }
        if (ids.size <= cap) return ids.toIntArray()
        val w = { e: Int -> deg[l.edges[e].a] + deg[l.edges[e].b] }
        val strongest = LinkedHashSet<Int>()
        for (i in l.items.indices) {
            var best = -1
            for (e in l.edgesOf[i]) if (on[e] && (best < 0 || w(e) > w(best) || (w(e) == w(best) && e < best))) best = e
            if (best >= 0) strongest.add(best)
        }
        val byWeight = compareByDescending<Int> { w(it) }.thenBy { it }
        val first = strongest.sortedWith(byWeight)
        val rest = ids.filter { it !in strongest }.sortedWith(byWeight)
        return (first + rest).take(cap).sorted().toIntArray()
    }

    /** One link as [seg] straight pieces of a quadratic curve, into [out] at [o] as segment pairs (6 * seg floats). */
    fun linkCurve(h: HoloLayout, l: LinkLayout, e: Int, seg: Int, out: FloatArray, o0: Int) {
        val edge = l.edges[e]
        val p = h.pos
        val a = edge.a * 3
        val b = edge.b * 3
        val mx = (p[a] + p[b]) / 2.0
        val my = (p[a + 1] + p[b + 1]) / 2.0
        val mz = (p[a + 2] + p[b + 2]) / 2.0
        val cx: Double
        val cy: Double
        val cz: Double
        if (h.mode == HoloMode.CLUSTERS) {
            val ca = l.items[edge.a].area * 3
            val cb = l.items[edge.b].area * 3
            val k = if (edge.cross) 0.32 else 0.5
            val tx = if (edge.cross) (h.centers[ca] + h.centers[cb]) / 2.0 else h.centers[ca].toDouble()
            val ty = if (edge.cross) (h.centers[ca + 1] + h.centers[cb + 1]) / 2.0 else h.centers[ca + 1].toDouble()
            val tz = if (edge.cross) (h.centers[ca + 2] + h.centers[cb + 2]) / 2.0 else h.centers[ca + 2].toDouble()
            cx = if (edge.cross) tx * k else mx + (tx - mx) * k
            cy = if (edge.cross) ty * k else my + (ty - my) * k
            cz = if (edge.cross) tz * k else mz + (tz - mz) * k
        } else {
            val k = if (edge.cross) 0.12 else 0.6
            cx = mx
            cy = my * k
            cz = mz * k
        }
        var o = o0
        var px = p[a]
        var py = p[a + 1]
        var pz = p[a + 2]
        for (s in 1..seg) {
            val t = s.toDouble() / seg
            val u = 1 - t
            val x = (u * u * p[a] + 2 * u * t * cx + t * t * p[b]).toFloat()
            val y = (u * u * p[a + 1] + 2 * u * t * cy + t * t * p[b + 1]).toFloat()
            val z = (u * u * p[a + 2] + 2 * u * t * cz + t * t * p[b + 2]).toFloat()
            out[o++] = px
            out[o++] = py
            out[o++] = pz
            out[o++] = x
            out[o++] = y
            out[o++] = z
            px = x
            py = y
            pz = z
        }
    }
}
