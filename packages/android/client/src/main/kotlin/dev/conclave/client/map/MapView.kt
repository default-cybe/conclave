package dev.conclave.client.map

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/*
 * Pan and zoom on the Map, the same as the web's features/map/view.ts: a
 * map point (x, y) shows at (x * k + vx, y * k + vy) on screen, in dp. Pure,
 * so MapModelTest checks the math.
 */

data class MapViewport(val x: Double, val y: Double, val k: Double)

/** Room the overlays take on each side of the map, kept clear when fitting. */
data class Insets(val top: Double, val right: Double, val bottom: Double, val left: Double) {
    companion object {
        val NONE = Insets(0.0, 0.0, 0.0, 0.0)
    }
}

object MapViews {
    const val ZOOM_MIN = 0.2
    const val ZOOM_MAX = 3.0

    /** The smallest text in a label on a phone: the state and the short id, 12dp. */
    const val LABEL_SMALLEST = 12.0

    /** The zoom a phone opens at: every label's text at 12dp or more on screen. */
    const val READ_K = 12.0 / LABEL_SMALLEST

    fun clampK(k: Double): Double = min(ZOOM_MAX, max(ZOOM_MIN, k))

    /** The view that shows all of [b] inside a w by h screen, less the insets, at most at zoom [maxK]. */
    fun fit(b: LBox, w: Double, h: Double, inset: Insets = Insets.NONE, maxK: Double = 1.25): MapViewport {
        val aw = max(40.0, w - inset.left - inset.right)
        val ah = max(40.0, h - inset.top - inset.bottom)
        val k = clampK(min(maxK, min(aw / max(1.0, b.w), ah / max(1.0, b.h))))
        return MapViewport(
            x = inset.left + (aw - b.w * k) / 2 - b.x * k,
            y = inset.top + (ah - b.h * k) / 2 - b.y * k,
            k = k,
        )
    }

    /**
     * A phone's first view. A small map fits whole. A larger one opens at
     * zoom [k], where its labels read, with [focus] (the hub and its busiest
     * project) in the middle of the room the overlays leave. A focus wider
     * than the room keeps its left side, where a phone has the hub. The view
     * moves only so no empty room shows past the map's edges.
     */
    fun start(b: LBox, focus: LBox, w: Double, h: Double, inset: Insets, k0: Double = READ_K): MapViewport {
        val whole = fit(b, w, h, inset, k0)
        if (whole.k >= k0) return whole
        val k = clampK(k0)
        val aw = max(40.0, w - inset.left - inset.right)
        val ah = max(40.0, h - inset.top - inset.bottom)
        fun axis(lo: Double, room: Double, at: Double, size: Double, f0: Double, fs: Double, keepStart: Boolean): Double {
            if (size * k <= room) return lo + (room - size * k) / 2 - at * k
            val v = if (fs * k > room && keepStart) lo - f0 * k else lo + room / 2 - (f0 + fs / 2) * k
            // where the map is wider (taller) than the room, its edges stay at the room's
            return min(lo - at * k, max(lo + room - (at + size) * k, v))
        }
        return MapViewport(
            x = axis(inset.left, aw, b.x, b.w, focus.x, focus.w, true),
            y = axis(inset.top, ah, b.y, b.h, focus.y, focus.h, false),
            k = k,
        )
    }

    /** Zoom by [factor] keeping the map point under the screen point (sx, sy) in place. */
    fun zoomAt(v: MapViewport, sx: Double, sy: Double, factor: Double): MapViewport {
        val k = clampK(v.k * factor)
        val f = k / v.k
        return MapViewport(sx - (sx - v.x) * f, sy - (sy - v.y) * f, k)
    }

    fun toWorld(v: MapViewport, sx: Double, sy: Double): Pair<Double, Double> = (sx - v.x) / v.k to (sy - v.y) / v.k

    fun toScreen(v: MapViewport, wx: Double, wy: Double): Pair<Double, Double> = wx * v.k + v.x to wy * v.k + v.y

    /**
     * Two fingers moved from (a0, b0) to (a1, b1), in screen points: the map
     * point under their middle stays under it, and the zoom follows their
     * distance.
     */
    fun pinch(v: MapViewport, a0: Pair<Double, Double>, b0: Pair<Double, Double>, a1: Pair<Double, Double>, b1: Pair<Double, Double>): MapViewport {
        val d0 = hypot(b0.first - a0.first, b0.second - a0.second)
        val d1 = hypot(b1.first - a1.first, b1.second - a1.second)
        val m0x = (a0.first + b0.first) / 2
        val m0y = (a0.second + b0.second) / 2
        val m1x = (a1.first + b1.first) / 2
        val m1y = (a1.second + b1.second) / 2
        val k = clampK(v.k * (if (d0 > 4) d1 / d0 else 1.0))
        val (wx, wy) = toWorld(v, m0x, m0y)
        return MapViewport(m1x - wx * k, m1y - wy * k, k)
    }

    /**
     * A transform gesture as Compose reports it (its centroid, the pan since
     * the last event, the zoom factor): the map point under the centroid
     * before the pan stays under it after.
     */
    fun gesture(v: MapViewport, cx: Double, cy: Double, panX: Double, panY: Double, zoom: Double): MapViewport {
        val k = clampK(v.k * zoom)
        val sx = cx - panX
        val sy = cy - panY
        val wx = (sx - v.x) / v.k
        val wy = (sy - v.y) / v.k
        return MapViewport(cx - wx * k, cy - wy * k, k)
    }

    /** Keep part of the map on screen: at least [keep] of the content box stays inside. */
    fun clamp(v: MapViewport, b: LBox, w: Double, h: Double, keep: Double = 80.0): MapViewport {
        val x0 = b.x * v.k + v.x
        val x1 = (b.x + b.w) * v.k + v.x
        val y0 = b.y * v.k + v.y
        val y1 = (b.y + b.h) * v.k + v.y
        var x = v.x
        var y = v.y
        if (x1 < keep) x += keep - x1
        if (x0 > w - keep) x -= x0 - (w - keep)
        if (y1 < keep) y += keep - y1
        if (y0 > h - keep) y -= y0 - (h - keep)
        return MapViewport(x, y, v.k)
    }

    /**
     * How far the view moves so a node's mark and label are inside the room
     * the overlays leave: (0, 0) when they already are. The map moves only as
     * far as it must.
     */
    fun reveal(v: MapViewport, n: LNode, w: Double, h: Double, inset: Insets): Pair<Double, Double> {
        val x0 = min(n.x - n.r, n.label.x) * v.k + v.x
        val x1 = max(n.x + n.r, n.label.x + n.label.w) * v.k + v.x
        val y0 = min(n.y - n.r, n.label.y) * v.k + v.y
        val y1 = max(n.y + n.r, n.label.y + n.label.h) * v.k + v.y
        var dx = 0.0
        var dy = 0.0
        if (x1 > w - inset.right) dx = w - inset.right - x1
        if (x0 + dx < inset.left) dx = inset.left - x0
        if (y1 > h - inset.bottom) dy = h - inset.bottom - y1
        if (y0 + dy < inset.top) dy = inset.top - y0
        return dx to dy
    }
}

/**
 * Marks glide to their new places when the layout changes (450ms, the
 * house ease out). Positions in map units; [at] gives where each mark is
 * drawn now.
 */
class MapGlide {
    private var from: Map<String, DoubleArray> = emptyMap()
    private var to: Map<String, DoubleArray> = emptyMap()
    private var start = 0.0
    private var dur = 0.0

    /** Ids that were not there before the last [set]: they fade in instead of gliding. */
    var fresh: Set<String> = emptySet()
        private set

    /** Glide to [next] from where marks are drawn at [now] (ms). [ms] 0: jump. */
    fun set(next: Map<String, DoubleArray>, now: Double, ms: Double) {
        val was = at(now)
        val f = HashMap<String, DoubleArray>()
        val newcomers = HashSet<String>()
        for ((id, p) in next) {
            val old = was[id]
            if (old == null && was.isNotEmpty()) newcomers.add(id)
            f[id] = old ?: p
        }
        from = f
        to = next
        start = now
        dur = if (was.isEmpty()) 0.0 else ms
        fresh = newcomers
    }

    fun moving(now: Double): Boolean = dur > 0 && now - start < dur

    /** 0 to 1 through the glide, eased. */
    fun progress(now: Double): Double = if (dur <= 0) 1.0 else easeOut(min(1.0, max(0.0, (now - start) / dur)))

    fun at(now: Double): Map<String, DoubleArray> {
        if (to.isEmpty()) return emptyMap()
        val k = progress(now)
        if (k >= 1.0) return to
        val out = HashMap<String, DoubleArray>(to.size)
        for ((id, b) in to) {
            val a = from[id] ?: b
            out[id] = doubleArrayOf(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k)
        }
        return out
    }

    companion object {
        const val MOVE_MS = 450.0

        /** The house ease out (cubic-bezier 0.2, 0.7, 0.2, 1), close enough for a glide. */
        fun easeOut(t: Double): Double {
            if (t <= 0) return 0.0
            if (t >= 1) return 1.0
            // solve the bezier for x = t by bisection, then read y
            var lo = 0.0
            var hi = 1.0
            var u = t
            repeat(20) {
                u = (lo + hi) / 2
                val x = bez(u, 0.2, 0.2)
                if (x < t) lo = u else hi = u
            }
            return bez(u, 0.7, 1.0)
        }

        private fun bez(u: Double, p1: Double, p2: Double): Double {
            val v = 1 - u
            return 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u
        }
    }
}
