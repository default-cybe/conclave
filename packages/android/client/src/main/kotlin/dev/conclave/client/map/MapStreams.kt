package dev.conclave.client.map

import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/*
 * Streams of light on the Map's links (docs/DESIGN.md 29), the same as the
 * web's features/map/streams.ts. Particles leave a working agent at a rate
 * that follows its tokens per second, flow along the curved link to its
 * project, then on to the hub, and fade into it. A tool call sends one
 * brighter pulse the same way. Full, Quiet (about a third) and Lines (none).
 * State lives in arrays; the app draws what [dots] and [pulses] give, and
 * lowers the share of particles when frames get slow ([quality]).
 */

enum class StreamMode(val wire: String, val label: String) {
    FULL("full", "Full"),
    QUIET("quiet", "Quiet"),
    LINES("lines", "Lines");

    companion object {
        fun of(wire: String?): StreamMode = entries.firstOrNull { it.wire == wire } ?: FULL
    }
}

/** Why a running node flows: tokens streaming, a tool running, or a request in flight. */
enum class Working { TOKENS, TOOL, WAITING }

data class StreamSource(
    /** The node's id (its link has the same id). */
    val id: String,
    val rate: Double,
    val working: Working,
)

object Streams {
    /** Particles a second for a source of [rate] tokens a second. A tool running or a request in flight still trickles. */
    fun emitRate(rate: Double, mode: StreamMode, working: Working = Working.TOKENS): Double {
        if (mode == StreamMode.LINES) return 0.0
        val base = when {
            rate > 0 -> min(72.0, 2 + rate * 1.3)
            working == Working.TOOL -> 2.0
            working == Working.WAITING -> 0.8
            else -> 0.0
        }
        return if (mode == StreamMode.QUIET) base * 0.3 else base
    }

    /** How many particles may live at once, by mode. */
    fun cap(mode: StreamMode): Int = when (mode) {
        StreamMode.FULL -> 5000
        StreamMode.QUIET -> 1500
        StreamMode.LINES -> 0
    }

    /** What flows: running nodes and their token rates. Workflow runs flow through their agents. */
    fun sources(nodes: List<dev.conclave.client.model.MapNode>): List<StreamSource> = nodes
        .filter { it.kind != dev.conclave.client.model.MapNodeKind.WORKFLOW && it.state == dev.conclave.client.model.MapState.RUNNING }
        .map { n -> StreamSource(n.id, n.rate, if (n.rate > 0) Working.TOKENS else if (n.tool != null) Working.TOOL else Working.WAITING) }
}

/**
 * Frame cost and frame interval, smoothed. Over budget, the share of
 * particles drops by a tenth each frame; well under, it climbs back slowly.
 */
class StreamQuality {
    var q = 1.0
        private set
    private var cost = 0.0
    private var interval = 16.7

    fun update(costMs: Double, intervalMs: Double): Double {
        cost += (costMs - cost) * 0.1
        interval += (min(100.0, intervalMs) - interval) * 0.1
        if (cost > 6 || interval > 26) q = max(0.15, q * 0.9) else if (cost < 3 && interval < 19) q = min(1.0, q + 0.01)
        return q
    }
}

class MapStreams(private val random: Random = Random.Default) {
    var mode: StreamMode = StreamMode.FULL
    val quality = StreamQuality()

    private class Path(
        val id: String,
        var next: Int,
        /** Points along the curve, child to parent. */
        val pts: DoubleArray,
        /** Normals at those points. */
        val nrm: DoubleArray,
        val len: Double,
        /** Half the lane width, by the flow it carries. */
        var half: Double,
        var flow: Double,
    )

    private var paths: List<Path> = emptyList()
    private var index: Map<String, Int> = emptyMap()
    private var sources: List<StreamSource> = emptyList()
    private val acc = HashMap<String, Double>()

    // particles: path, position 0..1, speed per second, lane -1..1, alpha, kind (0 dot, 1 pulse)
    private val size = Streams.cap(StreamMode.FULL)
    private var n = 0
    private val pp = IntArray(size)
    private val ss = DoubleArray(size)
    private val vv = DoubleArray(size)
    private val ll = DoubleArray(size)
    private val aa = DoubleArray(size)
    private val kk = ByteArray(size)

    /** Particles alive now. */
    val count: Int get() = n

    /** The most particles there can be: size the arrays given to [dots] with it. */
    val capacity: Int get() = size

    /** True while something moves or will: particles alive, or a source that emits. */
    val active: Boolean
        get() = n > 0 || (mode != StreamMode.LINES && sources.any { Streams.emitRate(it.rate, mode, it.working) > 0 })

    /** The links as they are drawn now (they move while the layout settles). Particles keep their place along each link. */
    fun setLinks(links: List<LLink>) {
        val old = index
        val next = ArrayList<Path>(links.size)
        val idx = HashMap<String, Int>()
        val pt = DoubleArray(2)
        for (k in links) {
            val pts = DoubleArray((SEGS + 1) * 2)
            var len = 0.0
            for (i in 0..SEGS) {
                MapLayouts.cubicAt(k.p, i.toDouble() / SEGS, pt)
                pts[i * 2] = pt[0]
                pts[i * 2 + 1] = pt[1]
                if (i > 0) len += hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1])
            }
            val nrm = DoubleArray((SEGS + 1) * 2)
            for (i in 0..SEGS) {
                val a = max(0, i - 1)
                val b = min(SEGS, i + 1)
                val tx = pts[b * 2] - pts[a * 2]
                val ty = pts[b * 2 + 1] - pts[a * 2 + 1]
                val tl = hypot(tx, ty).takeIf { it > 0 } ?: 1.0
                nrm[i * 2] = -ty / tl
                nrm[i * 2 + 1] = tx / tl
            }
            idx[k.id] = next.size
            next.add(Path(k.id, -1, pts, nrm, max(1.0, len), 2.0, 0.0))
        }
        for (i in links.indices) next[i].next = idx[links[i].to] ?: -1
        // particles move to the same link in the new table, or go
        if (n > 0) {
            val remap = IntArray(paths.size) { -1 }
            for ((id, i) in old) remap[i] = idx[id] ?: -1
            var w = 0
            for (i in 0 until n) {
                val p = remap.getOrElse(pp[i]) { -1 }
                if (p < 0) continue
                copy(i, w)
                pp[w] = p
                w++
            }
            n = w
        }
        paths = next
        index = idx
        flows()
    }

    /** The working nodes and their token rates. */
    fun setSources(list: List<StreamSource>) {
        sources = list
        flows()
    }

    /** A tool call: one bright pulse from the node to the hub. */
    fun pulse(id: String) {
        if (mode == StreamMode.LINES) return
        val p = index[id] ?: return
        if (n >= size) return
        spawn(p, 1)
    }

    private fun flows() {
        for (p in paths) p.flow = 0.0
        for (s in sources) {
            val r = max(s.rate, if (s.working == Working.TOOL) 2.0 else 0.0)
            var i = index[s.id] ?: -1
            var hops = 0
            while (i >= 0 && hops < 16) {
                paths[i].flow += r
                i = paths[i].next
                hops++
            }
        }
        for (p in paths) p.half = 1.6 + min(7.0, sqrt(p.flow) * 0.75)
    }

    private fun copy(from: Int, to: Int) {
        if (from == to) return
        pp[to] = pp[from]
        ss[to] = ss[from]
        vv[to] = vv[from]
        ll[to] = ll[from]
        aa[to] = aa[from]
        kk[to] = kk[from]
    }

    private fun spawn(path: Int, kind: Int) {
        val i = n++
        pp[i] = path
        ss[i] = if (kind == 1) 0.0 else random.nextDouble() * 0.04
        vv[i] = if (kind == 1) 230.0 else 62 + random.nextDouble() * 40
        ll[i] = if (kind == 1) 0.0 else (random.nextDouble() * 2 - 1) * (0.35 + 0.65 * random.nextDouble())
        aa[i] = if (kind == 1) 1.0 else 0.3 + random.nextDouble() * 0.65
        kk[i] = kind.toByte()
    }

    /** Advance by [seconds]: emit, move, hand over at each node, fade into the hub. */
    fun step(seconds: Double) {
        val dt = min(0.05, max(0.0, seconds))
        val cap = floor(Streams.cap(mode) * quality.q).toInt()
        if (mode != StreamMode.LINES) {
            for (s in sources) {
                val p = index[s.id] ?: continue
                val want = Streams.emitRate(s.rate, mode, s.working) * quality.q * dt + (acc[s.id] ?: 0.0)
                var k = floor(want).toInt()
                acc[s.id] = want - k
                while (k > 0 && n < min(cap, size)) {
                    k--
                    spawn(p, 0)
                }
            }
        }
        var w = 0
        for (i in 0 until n) {
            var p = pp[i]
            var path = paths.getOrNull(p) ?: continue
            var s = ss[i] + (vv[i] * dt) / path.len
            while (s >= 1) {
                val next = path.next
                if (next < 0) break
                s = ((s - 1) * path.len) / paths[next].len
                p = next
                path = paths[p]
            }
            if (s >= 1) continue
            copy(i, w)
            pp[w] = p
            ss[w] = s
            w++
        }
        n = w
        // over the cap after a mode change or a quality drop: the oldest go first
        if (n > cap) {
            val drop = n - cap
            for (i in 0 until cap) copy(i + drop, i)
            n = max(0, cap)
        }
        if (mode == StreamMode.LINES) n = 0
    }

    /** A point along a path at [s], [lane] across it: the lane narrows at both ends, so streams gather at every node. */
    private fun pos(path: Path, s: Double, lane: Double, out: DoubleArray) {
        val f = s * SEGS
        val j = min(SEGS - 1, floor(f).toInt()).coerceAtLeast(0)
        val u = f - j
        val pts = path.pts
        val nrm = path.nrm
        val x = pts[j * 2] + (pts[j * 2 + 2] - pts[j * 2]) * u
        val y = pts[j * 2 + 1] + (pts[j * 2 + 3] - pts[j * 2 + 1]) * u
        val off = lane * path.half * (0.22 + 0.78 * sin(PI * s).coerceAtLeast(0.0).pow(0.8))
        out[0] = x + nrm[j * 2] * off
        out[1] = y + nrm[j * 2 + 1] * off
    }

    /** How much light a particle shows: it fades in as it leaves and out into the hub. */
    private fun fade(i: Int, path: Path): Double {
        val s = ss[i]
        val out = if (path.next < 0) min(1.0, (1 - s) / 0.22) else 1.0
        return aa[i] * out * min(1.0, s / 0.02 + (if (kk[i].toInt() == 1) 1.0 else 0.35))
    }

    /**
     * The dots to draw, in map units: x and y, and their light in four
     * levels (0 to 3; the app draws each at (level + 0.5) / 4). Pulses are
     * left out ([pulses]). Returns how many it wrote.
     */
    fun dots(xs: FloatArray, ys: FloatArray, levels: IntArray): Int {
        val pt = DoubleArray(2)
        var c = 0
        for (i in 0 until n) {
            if (kk[i].toInt() == 1) continue
            val path = paths.getOrNull(pp[i]) ?: continue
            val a = fade(i, path)
            if (a <= 0.02) continue
            pos(path, ss[i], ll[i], pt)
            xs[c] = pt[0].toFloat()
            ys[c] = pt[1].toFloat()
            levels[c] = min(3, floor(a * 4).toInt())
            c++
        }
        return c
    }

    /** Each pulse's trail, head last: [each] gets the map point, its light, and whether it is the head. */
    fun pulses(each: (x: Double, y: Double, alpha: Double, head: Boolean) -> Unit) {
        val pt = DoubleArray(2)
        for (i in 0 until n) {
            if (kk[i].toInt() != 1) continue
            val path = paths.getOrNull(pp[i]) ?: continue
            val f = fade(i, path)
            for (t in 5 downTo 0) {
                val s = ss[i] - t * (9 / path.len)
                if (s < 0) continue
                pos(path, s, 0.0, pt)
                each(pt[0], pt[1], f * (1 - t / 6.0) * (if (t > 0) 0.55 else 1.0), t == 0)
            }
        }
    }

    private companion object {
        const val SEGS = 22
    }
}
