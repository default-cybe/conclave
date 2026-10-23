package dev.conclave.client.motion

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/*
 * The Knot's motion: where the light is on the knot, in every state. Pure
 * math and the state rules, a line for line port of
 * packages/web/src/components/motion/knotMath.ts (spec:
 * docs/design/CHAT-AND-MOTION.md 1.7 and docs/design/brand/README.md). The
 * geometry is KnotGeometry, generated from docs/design/brand/knot.json. The
 * app's ui/motion/Knot.kt draws it on a Compose Canvas, the light on each
 * piece with PathMeasure.getSegment.
 *
 * Positions are on the knot's path, 0 to 100 (KNOT_LENGTH), any real number:
 * 112 is the same point as 12. The light is the span from tail to head.
 */

const val KNOT_LENGTH = KnotGeometry.LENGTH

/** One loop of thinking, ms. */
const val KNOT_LOOP = KnotGeometry.THINK_LOOP

/** The write runs from 0 to here (ms), the letting go from here to the end of the loop. */
val KNOT_TURN: Double = Math.round(KNOT_LOOP * KnotGeometry.THINK_TURN).toDouble()

/** The still pose of thinking (reduced motion): the loop at this many ms, the light about 3/4 written. */
const val KNOT_STILL = KnotGeometry.THINK_STILL

/** One lap of the tool light, ms, and its length. */
const val KNOT_TOOL_LOOP = KnotGeometry.TOOL_LOOP
const val KNOT_TOOL_LEN = KnotGeometry.TOOL_LENGTH

/** The ease of the write and of the letting go, each on its own (--ease-morph). */
val knotEase = CubicBezier(KnotGeometry.THINK_EASE[0], KnotGeometry.THINK_EASE[1], KnotGeometry.THINK_EASE[2], KnotGeometry.THINK_EASE[3])

/** x for knotEase(x) = y (bisection; the ease rises monotonically). */
private fun easeInverse(y: Double): Double {
    if (y <= 0) return 0.0
    if (y >= 1) return 1.0
    var lo = 0.0
    var hi = 1.0
    repeat(40) {
        val mid = (lo + hi) / 2
        if (knotEase(mid) < y) lo = mid else hi = mid
    }
    return (lo + hi) / 2
}

/** The light from tail to head on the 100 long path. */
data class KnotSpan(val head: Double, val tail: Double)

/**
 * The light at time t of the thinking loop (t in ms, any value). It writes
 * from 0 to the whole knot (eased), then lets go from the tail (eased), and
 * starts again one lap on, so the values never jump at the seam.
 */
fun knotSpan(t: Double): KnotSpan {
    val laps = floor(t / KNOT_LOOP)
    val u = t - laps * KNOT_LOOP
    val base = laps * KNOT_LENGTH
    if (u < KNOT_TURN) return KnotSpan(head = base + KNOT_LENGTH * knotEase(u / KNOT_TURN), tail = base)
    return KnotSpan(head = base + KNOT_LENGTH, tail = base + KNOT_LENGTH * knotEase((u - KNOT_TURN) / (KNOT_LOOP - KNOT_TURN)))
}

/** The thinking clock (ms, within the first loop) while the light is written from its tail to [length]. */
fun knotWritePhase(length: Double): Double = KNOT_TURN * easeInverse(length / KNOT_LENGTH)

/** The thinking clock (ms) while the light lets go and is still [length] long. */
fun knotReleasePhase(length: Double): Double = KNOT_TURN + (KNOT_LOOP - KNOT_TURN) * easeInverse(1 - length / KNOT_LENGTH)

/** The tool light after [lap] ms, started with its tail at [at]: 14 long, one lap per 2s. */
fun knotTravel(lap: Double, at: Double): KnotSpan {
    val tail = at + KNOT_LENGTH * lap / KNOT_TOOL_LOOP
    return KnotSpan(head = tail + KNOT_TOOL_LEN, tail = tail)
}

/** BRAND: the still mark, the light at home. A Knot that settles here lets go of its light from the tail until the home 16 is left. */
enum class KnotState { THINKING, TOOL, WAITING, PAUSED, FAILED, DONE, BRAND }

/** The light from [tail] to [head], and how much of it shows (done fades it out). */
data class KnotPose(val tail: Double, val head: Double, val light: Double)

/** The brand pose (the Mark): the light at home, the last 16 of the path, down the right lobe to its bottom. */
fun knotBrand(): KnotPose = KnotPose(KnotGeometry.BRAND_FROM, KnotGeometry.BRAND_FROM + KnotGeometry.BRAND_LENGTH, 1.0)

/** Blend into each state, ms: the light's span and how much of it shows. */
fun knotBlend(state: KnotState): Double = when (state) {
    KnotState.THINKING, KnotState.WAITING, KnotState.PAUSED, KnotState.FAILED -> Dur.D3.toDouble()
    KnotState.TOOL -> Dur.D4.toDouble()
    KnotState.DONE -> 600.0
    KnotState.BRAND -> 900.0
}

/** The end of the light's home at or after [head]: a multiple of the path's length (the home is the 16 before it). */
fun knotHomeAfter(head: Double): Double = ceil(head / KNOT_LENGTH - 1e-9) * KNOT_LENGTH

private fun held(s: KnotState) = s == KnotState.WAITING || s == KnotState.PAUSED || s == KnotState.FAILED

/**
 * One still, clear pose per state (reduced motion, rows in lists). Waiting
 * and failed hold the pose of the working state they came from ([via]).
 */
fun knotStill(state: KnotState, via: KnotState? = null): KnotPose = when (state) {
    KnotState.THINKING -> knotSpan(KNOT_STILL).let { KnotPose(it.tail, it.head, 1.0) }
    KnotState.TOOL -> knotTravel(0.0, KnotGeometry.BRAND_FROM).let { KnotPose(it.tail, it.head, 1.0) }
    KnotState.WAITING, KnotState.FAILED -> knotStill(if (via == KnotState.TOOL) KnotState.TOOL else KnotState.THINKING)
    KnotState.PAUSED -> KnotPose(KnotGeometry.PAUSED_FROM, KnotGeometry.PAUSED_FROM + KnotGeometry.PAUSED_LENGTH, 1.0)
    KnotState.DONE -> knotBrand().copy(light = 0.0)
    KnotState.BRAND -> knotBrand()
}

private fun mixPose(a: KnotPose, b: KnotPose, k: Double): KnotPose {
    // a light that did not show moves at once; only its strength blends
    val ks = if (a.light <= 0) 1.0 else k
    return KnotPose(lerp(a.tail, b.tail, ks), lerp(a.head, b.head, ks), lerp(a.light, b.light, k))
}

/**
 * The live Knot through every state. Feed it the state and the clock (ms);
 * it returns the pose to draw. Two clocks, each running only in its own
 * state, so waiting, paused and failed hold the exact frame and going back
 * to work resumes from it.
 *
 *   THINKING  the light writes the knot, then lets go from the tail (3s a loop)
 *   TOOL      a 14 long light travels the knot, one lap per 2s
 *   WAITING   holds where it is (amber)
 *   PAUSED    holds where it is (fg-3); a limit
 *   FAILED    stops where it is (the fault color)
 *   DONE      the light fades out (the knot turns fg-3)
 *   BRAND     the light lets go from its tail until it is the home 16 (the still mark)
 *
 * Changing between THINKING and TOOL keeps the light where it is: a tool
 * starts with its head on the written head; thinking picks up the tool
 * light as a stroke letting go of its tail.
 */
class KnotMotion(initial: KnotState = KnotState.THINKING, now: Double = 0.0, via: KnotState? = null) {
    var state: KnotState = initial
        private set

    /** Thinking clock (ms), advances only while thinking. */
    var phase = 0.0
        private set

    /** Tool clock (ms), advances only while a tool runs. */
    var lap = 0.0
        private set

    /** Shift of the thinking loop along the path. */
    var anchor = 0.0
        private set

    /** Where the tool light's tail was when the tool started. */
    var closeAt = KnotGeometry.BRAND_FROM
        private set

    /** The working state (THINKING or TOOL) that waiting, paused and failed hold. */
    var live: KnotState = KnotState.THINKING
        private set

    /** Brand: where the light's home ends (a multiple of 100). */
    var home = KNOT_LENGTH
        private set

    private var from: KnotPose? = null
    private var fromAt = 0.0
    private var blend = 0.0
    private var last: Double? = now

    var lastPose: KnotPose
        private set

    init {
        if (initial == KnotState.TOOL || (held(initial) && via == KnotState.TOOL)) live = KnotState.TOOL
        // mounted already waiting or failed: hold the clear still pose, not an empty loop
        if ((initial == KnotState.WAITING || initial == KnotState.FAILED) && live == KnotState.THINKING) phase = KNOT_STILL
        // mounted in a limit: the light at rest at home; thinking writes on from it
        if (initial == KnotState.PAUSED && live == KnotState.THINKING) {
            phase = knotWritePhase(KnotGeometry.PAUSED_LENGTH)
            anchor = KnotGeometry.PAUSED_FROM
        }
        if (initial == KnotState.DONE) {
            phase = knotWritePhase(KnotGeometry.BRAND_LENGTH)
            anchor = KnotGeometry.BRAND_FROM
        }
        lastPose = target()
    }

    /**
     * Start the thinking loop [elapsed] ms in, so a Knot that takes over from
     * another (the same reply in a new row) never jumps back to the start.
     * Only while thinking and before anything blends.
     */
    fun seek(elapsed: Double, now: Double) {
        if (state != KnotState.THINKING || from != null) return
        phase = max(0.0, elapsed)
        last = now
        lastPose = target()
    }

    /** Change state at time now. The new pose blends in from the one last drawn. */
    fun set(next: KnotState, now: Double) {
        if (next == state) return
        advance(now)
        val cur = pose(now)
        val prev = state
        state = next
        val was = if (prev == KnotState.DONE || prev == KnotState.BRAND) KnotState.DONE else if (held(prev)) live else prev
        if (next == KnotState.BRAND) {
            // the light keeps its head and lets go of its tail until the home 16 is left
            home = knotHomeAfter(cur.head)
        }
        when (next) {
            KnotState.THINKING -> {
                if (was == KnotState.TOOL) {
                    // the tool light becomes a stroke letting go of its tail
                    phase = knotReleasePhase(cur.head - cur.tail)
                    anchor = cur.head - KNOT_LENGTH
                } else if (was == KnotState.DONE) {
                    // a new write from the start of the path, where the light's home ends
                    phase = 0.0
                    anchor = 0.0
                }
                live = KnotState.THINKING
            }
            KnotState.TOOL -> {
                if (was != KnotState.TOOL) {
                    // the light keeps its head and travels on from there
                    closeAt = if (was == KnotState.DONE) KnotGeometry.BRAND_FROM else cur.head - KNOT_TOOL_LEN
                    lap = 0.0
                }
                live = KnotState.TOOL
            }
            else -> Unit
        }
        from = cur
        fromAt = now
        blend = knotBlend(next)
    }

    private fun advance(now: Double) {
        val l = last
        val dt = if (l == null) 0.0 else clamp(now - l, 0.0, 100.0)
        last = now
        if (state == KnotState.THINKING) phase += dt else if (state == KnotState.TOOL) lap += dt
    }

    private fun target(): KnotPose {
        if (state == KnotState.BRAND) return KnotPose(home - KnotGeometry.BRAND_LENGTH, home, 1.0)
        val light = if (state == KnotState.DONE) 0.0 else 1.0
        if (live == KnotState.TOOL) {
            val s = knotTravel(lap, closeAt)
            return KnotPose(s.tail, s.head, light)
        }
        val s = knotSpan(phase)
        return KnotPose(s.tail + anchor, s.head + anchor, light)
    }

    /** The pose at time now (advances the clocks). */
    fun pose(now: Double): KnotPose {
        advance(now)
        var p = target()
        val f = from
        if (f != null) {
            val k = Ease.out(seg(now, fromAt, fromAt + blend))
            if (k >= 1) from = null else p = mixPose(f, p, k)
        }
        lastPose = p
        return p
    }

    /** True while frames change: a live state, or a blend still running. */
    fun moving(now: Double): Boolean {
        if (state == KnotState.THINKING || state == KnotState.TOOL) return true
        return from != null && now < fromAt + blend
    }
}

// ---------------------------------------------------------------------------
// Drawing: where the light falls on each piece
// ---------------------------------------------------------------------------

/**
 * The light's intervals on piece [p], in the piece's own length units, into
 * [out] as start, end pairs; returns how many (none, one, or two when the
 * light wraps round the path's end onto the same piece). The last piece runs
 * past 100, round to the start. Draw each with PathMeasure.getSegment at
 * start / p.length and end / p.length of the piece's measured length.
 */
fun knotLit(p: KnotPiece, tail: Double, head: Double, out: DoubleArray): Int {
    val len = min(KNOT_LENGTH, head - tail)
    if (len <= 1e-3) return 0
    if (len >= KNOT_LENGTH - 1e-3) {
        out[0] = 0.0
        out[1] = p.length
        return 1
    }
    val from = mod(tail, KNOT_LENGTH)
    var n = 0
    for (shift in doubleArrayOf(-KNOT_LENGTH, 0.0, KNOT_LENGTH)) {
        val a = max(from + shift - p.from, 0.0)
        val b = min(from + len + shift - p.from, p.length)
        if (b - a > 1e-3 && n < 2) {
            out[2 * n] = a
            out[2 * n + 1] = b
            n++
        }
    }
    if (n == 2 && out[2] < out[0]) {
        val a = out[0]
        val b = out[1]
        out[0] = out[2]
        out[1] = out[3]
        out[2] = a
        out[3] = b
    }
    return n
}

/** Stroke width in box units for a knot drawn at [s] dp: heavier at 32 and under. */
fun knotWidth(s: Double): Float = if (s <= KnotGeometry.SMALL_UP_TO) KnotGeometry.SMALL_WIDTH else KnotGeometry.WIDTH

/** Halo width in box units for a knot drawn at [s] dp. */
fun knotHalo(s: Double): Float = if (s <= KnotGeometry.SMALL_UP_TO) KnotGeometry.SMALL_HALO else KnotGeometry.HALO

// ---------------------------------------------------------------------------
// The rope (docs/design/KNOT-MOTION.md): the knot ties itself
// ---------------------------------------------------------------------------

/*
 * The knot as one rope that slides along its own path; nothing morphs.
 * Positions are on the rope: the knot is 100 to 200 (RopeGeometry.KNOT),
 * the lead in comes from the right to 100, the lead out leaves to the left
 * from 200. The rope is 100 long: at progress w it covers [w, w + 100].
 * w = 0 lies straight on the lead in, w = 100 is the tied knot (the still
 * mark), w = 250 has left. The light is the rope's last 16 (the head light);
 * a tied rope runs it round with a separate position p (the lap light,
 * wrapping). The app's ui/motion/KnotRope.kt draws it. A line for line port
 * of the rope section of packages/web/src/components/motion/knotMath.ts.
 */

enum class RopeMoment { LAUNCH, LAUNCH_LONG, RUN, SUCCESS, RECEIVE, SEND }

/** The light that shows: the head light, the lap light, or the run piece's light. */
enum class RopeLight { HEAD, LAP, RUN }

private const val RK = RopeGeometry.KNOT

/**
 * The part of the window [a, b] that falls on the stretch from [from] for
 * [length] (a path, a halo), in its own units, into out[0] and out[1].
 * False when none of it does.
 */
fun ropeSpan(from: Double, length: Double, a: Double, b: Double, out: DoubleArray): Boolean {
    val s = max(a - from, 0.0)
    val e = min(b - from, length)
    if (e - s <= 1e-3) return false
    out[0] = s
    out[1] = e
    return true
}

/**
 * The parts of [a, b] (at most 100 long) on the knot path from [from] for
 * [length] when positions go round the knot (above 200 wraps back to 100),
 * in its own units, into [out] as start, end pairs; returns how many (none,
 * one, or two when the span wraps onto the same path). The lap light, the
 * run piece and the trail use it.
 */
fun ropeRing(from: Double, length: Double, a: Double, b: Double, out: DoubleArray): Int {
    val len = min(KNOT_LENGTH, b - a)
    if (len <= 1e-3) return 0
    if (len >= KNOT_LENGTH - 1e-3) {
        out[0] = 0.0
        out[1] = length
        return 1
    }
    val start = RK + mod(a - RK, KNOT_LENGTH)
    var n = 0
    for (shift in doubleArrayOf(-KNOT_LENGTH, 0.0, KNOT_LENGTH)) {
        val s = max(start + shift - from, 0.0)
        val e = min(start + len + shift - from, length)
        if (e - s > 1e-3 && n < 2) {
            out[2 * n] = s
            out[2 * n + 1] = e
            n++
        }
    }
    if (n == 2 && out[2] < out[0]) {
        val s = out[0]
        val e = out[1]
        out[0] = out[2]
        out[1] = out[3]
        out[2] = s
        out[3] = e
    }
    return n
}

/** The head light at progress w: the rope's last 16, from w + 84 ... */
fun ropeHeadFrom(w: Double): Double = w + RopeGeometry.LIGHT_BACK

/** ... to w + 100. */
fun ropeHeadTo(w: Double): Double = w + KNOT_LENGTH

/** The lap light at p: 16 from p, round the knot (ropeRing). */
fun ropeLapTo(p: Double): Double = p + RopeGeometry.LIGHT

fun easeInOutCubic(x: Double): Double = if (x < 0.5) 4 * x * x * x else 1 - Math.pow(-2 * x + 2, 3.0) / 2

private val successEase = CubicBezier(RopeGeometry.SUCCESS_EASE[0], RopeGeometry.SUCCESS_EASE[1], RopeGeometry.SUCCESS_EASE[2], RopeGeometry.SUCCESS_EASE[3])

/** The cinch at share k of its time: the knot's scale around the box's center (1, .93, 1.025, 1). */
fun ropeCinch(k: Double): Double {
    val at = RopeGeometry.CINCH_AT
    val scale = RopeGeometry.CINCH_SCALE
    if (k <= 0 || k >= 1) return 1.0
    for (i in 1 until at.size) if (k <= at[i]) return lerp(scale[i - 1], scale[i], (k - at[i - 1]) / (at[i] - at[i - 1]))
    return 1.0
}

/** The times of a moment that moves the rope (launch, launchLong, receive, send). */
fun ropeTimes(m: RopeMoment): RopeTimes? = when (m) {
    RopeMoment.LAUNCH -> RopeGeometry.LAUNCH
    RopeMoment.LAUNCH_LONG -> RopeGeometry.LAUNCH_LONG
    RopeMoment.RECEIVE -> RopeGeometry.RECEIVE
    RopeMoment.SEND -> RopeGeometry.SEND
    RopeMoment.RUN, RopeMoment.SUCCESS -> null
}

/** w at t ms: held at from while straight, then eased to to (in out cubic, or x^easeIn). */
fun ropeW(m: RopeTimes, t: Double): Double {
    val k = clamp01((t - m.straight) / m.move)
    return m.from + (m.to - m.from) * (if (m.easeIn > 0) Math.pow(k, m.easeIn) else easeInOutCubic(k))
}

/** The lap light's start at t ms: at home, then one lap (in out cubic) from lapAt after the move. */
fun ropeLapAt(m: RopeTimes, t: Double): Double {
    if (m.lap <= 0) return RopeGeometry.LIGHT_HOME
    val end = m.straight + m.move
    return RopeGeometry.LIGHT_HOME + KNOT_LENGTH * easeInOutCubic(clamp01((t - end - m.lapAt) / m.lap))
}

/**
 * Which light shows: the head light while the rope moves, the lap light
 * once a tie is done. At the swap both cover the same 16 (184 to 200), so
 * it never shows. An untie (send) keeps the head light: it leads.
 */
fun ropeSwap(m: RopeTimes, t: Double): RopeLight = if (m.to == RK && t >= m.straight + m.move) RopeLight.LAP else RopeLight.HEAD

/** How long a moment plays, ms (run loops: infinity). */
fun ropeDuration(moment: RopeMoment): Double {
    if (moment == RopeMoment.RUN) return Double.POSITIVE_INFINITY
    if (moment == RopeMoment.SUCCESS) return max(RopeGeometry.SUCCESS_SPIN, RopeGeometry.SUCCESS_CINCH_AT + RopeGeometry.SUCCESS_CINCH)
    val m = ropeTimes(moment)!!
    val end = m.straight + m.move
    return maxOf(end, if (m.cinch > 0) end + m.cinch else 0.0, if (m.lap > 0) end + m.lapAt + m.lap else 0.0, if (m.word > 0) end + m.wordAt + m.word else 0.0)
}

/**
 * A moment at one time. [w]: the rope covers [w, w + 100] (run and success
 * keep it tied, 100). [lap]: the lap light's start (and the trail's place).
 * [run]: where the running piece starts. [trail]: how much of the trail
 * shows, 0 to 1. [cinch]: the knot's scale around the box's center.
 * [fade]: how much of the whole shows. [word]: the word under the first
 * run's launch, 0 to 1.
 */
data class RopePose(
    val w: Double,
    val light: RopeLight,
    val lap: Double,
    val run: Double,
    val trail: Double,
    val cinch: Double,
    val fade: Double,
    val word: Double,
)

/** The trail's strength at share u of the spin: in, held, out. */
private fun trailAt(u: Double): Double {
    val i0 = RopeGeometry.TRAIL_IN[0]
    val i1 = RopeGeometry.TRAIL_IN[1]
    val o0 = RopeGeometry.TRAIL_OUT[0]
    val o1 = RopeGeometry.TRAIL_OUT[1]
    if (u <= i0 || u >= o1) return 0.0
    if (u < i1) return (u - i0) / (i1 - i0)
    if (u <= o0) return 1.0
    return 1 - (u - o0) / (o1 - o0)
}

/** The pose of a moment at t ms after it starts. */
fun ropePose(moment: RopeMoment, t: Double): RopePose {
    if (moment == RopeMoment.RUN) {
        return RopePose(RK, RopeLight.RUN, RopeGeometry.LIGHT_HOME, RopeGeometry.RUN_FROM + KNOT_LENGTH * max(0.0, t) / RopeGeometry.RUN_LOOP, 0.0, 1.0, 1.0, 0.0)
    }
    if (moment == RopeMoment.SUCCESS) {
        val u = clamp01(t / RopeGeometry.SUCCESS_SPIN)
        val lap = RopeGeometry.LIGHT_HOME + KNOT_LENGTH * RopeGeometry.SUCCESS_LAPS * successEase(u)
        return RopePose(RK, RopeLight.LAP, lap, 0.0, trailAt(u), ropeCinch((t - RopeGeometry.SUCCESS_CINCH_AT) / RopeGeometry.SUCCESS_CINCH), 1.0, 0.0)
    }
    val m = ropeTimes(moment)!!
    val end = m.straight + m.move
    return RopePose(
        w = ropeW(m, t),
        light = ropeSwap(m, t),
        lap = ropeLapAt(m, t),
        run = 0.0,
        trail = 0.0,
        cinch = if (m.cinch > 0) ropeCinch((t - end) / m.cinch) else 1.0,
        fade = if (m.fade > 0) clamp01(t / m.fade) else 1.0,
        word = if (m.word > 0) clamp01((t - end - m.wordAt) / m.word) else 0.0,
    )
}

/** The tied knot with the light at rest: the still mark, and every moment under reduced motion. */
fun ropeRest(): RopePose = RopePose(RK, RopeLight.LAP, RopeGeometry.LIGHT_HOME, 0.0, 0.0, 1.0, 1.0, 0.0)

// Where things are: the rope's points, for the round ends and the launch camera

/** The rope position of each point of each path. */
private val ropeAt: List<DoubleArray> = RopeGeometry.PATHS.map { p ->
    val xy = p.points
    val n = xy.size / 2
    val cum = DoubleArray(n)
    for (i in 1 until n) cum[i] = cum[i - 1] + hypot((xy[2 * i] - xy[2 * i - 2]).toDouble(), (xy[2 * i + 1] - xy[2 * i - 1]).toDouble())
    val total = cum[n - 1]
    DoubleArray(n) { p.from + p.length * cum[it] / total }
}

/** The point at rope position [pos] (clamped to the rope's ends), into out[0] and out[1]. */
fun ropePoint(pos: Double, out: DoubleArray) {
    val first = RopeGeometry.PATHS.first()
    val last = RopeGeometry.PATHS.last()
    val g = clamp(pos, first.from, last.from + last.length)
    for (i in RopeGeometry.PATHS.indices) {
        val p = RopeGeometry.PATHS[i]
        if (g > p.from + p.length + 1e-9) continue
        val xy = p.points
        val at = ropeAt[i]
        var j = 1
        while (j < at.size - 1 && at[j] < g) j++
        val k = if (at[j] > at[j - 1]) clamp01((g - at[j - 1]) / (at[j] - at[j - 1])) else 0.0
        out[0] = lerp(xy[2 * j - 2].toDouble(), xy[2 * j].toDouble(), k)
        out[1] = lerp(xy[2 * j - 1].toDouble(), xy[2 * j + 1].toDouble(), k)
        return
    }
    out[0] = 0.0
    out[1] = 0.0
}

/**
 * The over paths' base has flat ends (as the still mark), so a rope end on
 * one gets a round end of its own. A tail belongs to the path after it, a
 * head to the path before it.
 */
private fun onOver(pos: Double, head: Boolean): Boolean = RopeGeometry.PATHS.any { p ->
    p.kind == ROPE_OVER && if (head) pos > p.from + 1e-9 && pos <= p.from + p.length + 1e-9 else pos >= p.from - 1e-9 && pos < p.from + p.length - 1e-9
}

/**
 * Where the base needs a round dot, into [out] (room for 3); returns how
 * many: a rope end on an over path (the window's two ends, or the run
 * piece's), and the join of k6 and k0 when the base runs across it (two
 * flat ends meet there, where the still mark has one piece). Tied, the
 * rope's ends meet at that join.
 */
fun ropeCaps(pose: RopePose, out: DoubleArray): Int {
    var n = 0
    if (pose.light == RopeLight.RUN) {
        val tail = RK + mod(pose.run - RK, KNOT_LENGTH)
        val end = tail + RopeGeometry.RUN_LENGTH
        val head = if (end > RK + KNOT_LENGTH) end - KNOT_LENGTH else end
        if (onOver(tail, false)) out[n++] = tail
        if (onOver(head, true)) out[n++] = head
        if (end > RK + KNOT_LENGTH + 1e-9) out[n++] = RK
        return n
    }
    if (abs(pose.w - RK) < 1e-6) {
        out[0] = RK
        return 1
    }
    if (onOver(pose.w, false)) out[n++] = pose.w
    if (onOver(pose.w + KNOT_LENGTH, true)) out[n++] = pose.w + KNOT_LENGTH
    return n
}

/** The box around the rope's centerline over [a, b] into out (x0, y0, x1, y1); false when none of it is there. */
fun ropeBox(a: Double, b: Double, out: DoubleArray): Boolean {
    var x0 = Double.POSITIVE_INFINITY
    var y0 = Double.POSITIVE_INFINITY
    var x1 = Double.NEGATIVE_INFINITY
    var y1 = Double.NEGATIVE_INFINITY
    val span = DoubleArray(2)
    val pt = DoubleArray(2)
    fun add(x: Double, y: Double) {
        x0 = min(x0, x)
        y0 = min(y0, y)
        x1 = max(x1, x)
        y1 = max(y1, y)
    }
    RopeGeometry.PATHS.forEachIndexed { i, p ->
        if (!ropeSpan(p.from, p.length, a, b, span)) return@forEachIndexed
        val xy = p.points
        val at = ropeAt[i]
        for (j in at.indices) if (at[j] > p.from + span[0] && at[j] < p.from + span[1]) add(xy[2 * j].toDouble(), xy[2 * j + 1].toDouble())
        ropePoint(p.from + span[0], pt)
        add(pt[0], pt[1])
        ropePoint(p.from + span[1], pt)
        add(pt[0], pt[1])
    }
    if (x0 > x1) return false
    out[0] = x0
    out[1] = y0
    out[2] = x1
    out[3] = y1
    return true
}

/** The launch camera: scale [s] and the point at the view's center ([x], [y]) in box units. */
data class RopeCamera(val s: Double, val x: Double, val y: Double)

/**
 * The camera on the rope at progress w, for a view [vw] by [vh] box units:
 * it fits the visible rope (and its stroke) inside the padding, never
 * closer than scale 1, centered on it. Tied, it is the knot at scale 1.
 */
fun ropeCameraAt(w: Double, vw: Double, vh: Double, stroke: Double): RopeCamera {
    if (w >= RK) return RopeCamera(1.0, 32.0, 32.0)
    val b = DoubleArray(4)
    if (!ropeBox(w, w + KNOT_LENGTH, b)) return RopeCamera(1.0, 32.0, 32.0)
    val s = minOf(1.0, (vw - 2 * RopeGeometry.CAMERA_PAD_X) / (b[2] - b[0] + stroke), (vh - 2 * RopeGeometry.CAMERA_PAD_Y) / (b[3] - b[1] + stroke))
    return RopeCamera(s, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
}

/**
 * The launch camera at t ms: it follows the box of the visible rope,
 * smoothed over time (a triangle of ± CAMERA_SMOOTH steps, each 1 /
 * CAMERA_STEPS of the tie), and ends on the knot at scale 1. Still before
 * the tie and after it.
 */
fun ropeCamera(m: RopeTimes, t: Double, vw: Double, vh: Double, stroke: Double): RopeCamera {
    val w = ropeW(m, t)
    if (w <= m.from || w >= m.to) return ropeCameraAt(w, vw, vh, stroke)
    val n = RopeGeometry.CAMERA_SMOOTH
    val dt = m.move / RopeGeometry.CAMERA_STEPS
    var sum = 0.0
    var s = 0.0
    var x = 0.0
    var y = 0.0
    for (k in -n..n) {
        val weight = (n + 1 - abs(k)).toDouble()
        val c = ropeCameraAt(ropeW(m, t + k * dt), vw, vh, stroke)
        sum += weight
        s += weight * c.s
        x += weight * c.x
        y += weight * c.y
    }
    return RopeCamera(s / sum, x / sum, y / sum)
}
