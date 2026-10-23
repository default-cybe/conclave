package dev.conclave.client.motion

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/*
 * The Rim: one thin light on the composer edge (light.html Rim, Breath,
 * Settle, Fault). The geometry of a rounded box and the state clocks, ported
 * from packages/web/src/components/motion/Rim.tsx. The app draws it
 * (ui/motion/Rim.kt).
 *
 *   LIVE     a violet light with a 190px tail runs once round the edge every 4s
 *   WAITING  the light goes out and the whole edge breathes amber: in 1.6s, out 2.2s, rest
 *   DONE     the light coasts 700ms, its tail opens round the whole edge, glows evenly, then fades
 *   FAILED   the light brakes over 600ms, its tail draws in, it cools to the fault color and stays
 *   IDLE     nothing (the box's own hairline)
 */

enum class RimState { IDLE, LIVE, WAITING, DONE, FAILED }

/** A rounded box: width, height, corner radius (px). */
data class RimBox(val w: Double, val h: Double, val r: Double) {
    val perimeter: Double get() = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * PI * r

    /** The point at arc length s, clockwise from the left end of the top edge, into [out]. */
    fun at(s0: Double, out: DoubleArray = DoubleArray(2)): DoubleArray {
        val l1 = w - 2 * r
        val l2 = h - 2 * r
        val a = PI * r / 2
        val p = 2 * l1 + 2 * l2 + 4 * a
        var s = mod(s0, p)
        fun put(x: Double, y: Double): DoubleArray {
            out[0] = x
            out[1] = y
            return out
        }
        if (s < l1) return put(r + s, 0.0)
        s -= l1
        if (s < a) {
            val t = -PI / 2 + s / r
            return put(w - r + r * cos(t), r + r * sin(t))
        }
        s -= a
        if (s < l2) return put(w, r + s)
        s -= l2
        if (s < a) {
            val t = s / r
            return put(w - r + r * cos(t), h - r + r * sin(t))
        }
        s -= a
        if (s < l1) return put(w - r - s, h)
        s -= l1
        if (s < a) {
            val t = PI / 2 + s / r
            return put(r + r * cos(t), h - r + r * sin(t))
        }
        s -= a
        if (s < l2) return put(0.0, h - r - s)
        s -= l2
        val t = PI + s / r
        return put(r + r * cos(t), r + r * sin(t))
    }
}

object Rim {
    /** The light's tail in px. */
    const val TAIL = 190.0

    /** The short mark a failure leaves. */
    const val FAULT_TAIL = 30.0

    /** The canvas reaches this far past the box edge, for the glow. */
    const val MARGIN = 4.0

    /** The light's head on the live clock: one lap per 4s with a slight swell in pace. */
    fun headAt(p: Double, t: Double): Double {
        val u = t / Loop.RIM
        return p * (u + 0.018 * sin(2 * PI * u)) - 40
    }

    /** Breath: in 1600ms on the sine, out 2200ms, then rest. */
    fun breath(t: Double): Double {
        val u = mod(t, Loop.BREATH.toDouble())
        return if (u < 1600) Ease.sine(u / 1600) else if (u < 3800) 1 - Ease.sine((u - 1600) / 2200) else 0.0
    }
}

/** What the light is doing. */
enum class RimMode { OFF, RUN, SETTLE, FAULT }

/** The Rim through its states. Like the Knot, each clock runs only in its own state. */
class RimMotion(initial: RimState, now: Double = 0.0) {
    var state = initial
        private set
    var mode = RimMode.OFF
        private set

    /** Live clock: the light's travel. */
    var liveT = 0.0
        private set

    /** Breath clock. */
    var breathT = 0.0
        private set

    /** Since the light's mode began (settle, fault). */
    var modeAt = 0.0
        private set
    var lightA = 0.0
        private set
    var breathA = 0.0
        private set
    private var last: Double? = now
    private var fadeLight = 0.0
    private var fadeBreath = 0.0
    private var fadeAt = now

    init {
        when (initial) {
            RimState.LIVE -> {
                mode = RimMode.RUN
                lightA = 1.0
            }
            RimState.WAITING -> breathA = 1.0
            RimState.FAILED -> {
                mode = RimMode.FAULT
                lightA = 1.0
                modeAt = now - 2000
            }
            else -> Unit
        }
        fadeLight = lightA
        fadeBreath = breathA
    }

    private fun targetLight(): Double = when (state) {
        RimState.LIVE, RimState.FAILED -> 1.0
        RimState.DONE -> if (mode == RimMode.SETTLE) 1.0 else 0.0
        else -> 0.0
    }

    private fun targetBreath(): Double = if (state == RimState.WAITING) 1.0 else 0.0

    fun set(next: RimState, now: Double) {
        if (next == state) return
        advance(now)
        val running = mode == RimMode.RUN && lightA > 0.01
        state = next
        when (next) {
            RimState.LIVE -> if (mode != RimMode.RUN) {
                mode = RimMode.RUN
                lightA = 0.0
            }
            RimState.DONE -> {
                mode = if (running) RimMode.SETTLE else RimMode.OFF
                modeAt = now
            }
            RimState.FAILED -> {
                // a running light brakes into the mark; otherwise the still mark fades in
                mode = RimMode.FAULT
                modeAt = if (running) now else now - 2000
            }
            else -> Unit
        }
        fadeLight = lightA
        fadeBreath = breathA
        fadeAt = now
        if ((next == RimState.DONE || next == RimState.FAILED) && running) fadeLight = 1.0
    }

    private fun advance(now: Double) {
        val l = last
        val dt = if (l == null) 0.0 else clamp(now - l, 0.0, 100.0)
        last = now
        if (state == RimState.LIVE) liveT += dt
        // the breath keeps its pace while it fades out, and starts from rest next time
        if (state == RimState.WAITING || breathA > 0.001) breathT += dt else breathT = 0.0
        val k = Ease.out(seg(now, fadeAt, fadeAt + Dur.D3))
        lightA = lerp(fadeLight, targetLight(), k)
        breathA = lerp(fadeBreath, targetBreath(), k)
    }

    /** Advance to now; true while anything is drawn or changing. */
    fun step(now: Double): Boolean {
        advance(now)
        if (state == RimState.LIVE || state == RimState.WAITING) return true
        val fading = now - fadeAt < Dur.D3 + 20
        if (mode == RimMode.SETTLE && state == RimState.DONE) return fading || now - modeAt < 1600
        if (mode == RimMode.FAULT && state == RimState.FAILED) return fading || now - modeAt < 1300
        return fading
    }
}

/**
 * The send arrow and the stop square as nine points each in a 30 x 30 box
 * (ui.html Send to stop). The square's points sit on its edges in an order
 * that lets the notches under the arrow's wings close without crossing.
 */
object SendStop {
    private val ARROW = doubleArrayOf(15.0, 7.6, 20.4, 13.0, 19.1, 14.3, 16.0, 11.3, 16.0, 22.0, 14.0, 22.0, 14.0, 11.3, 10.9, 14.3, 9.6, 13.0)
    private val SQUARE = doubleArrayOf(15.0, 10.8, 19.2, 10.8, 19.2, 14.6, 19.2, 12.6, 19.2, 19.2, 10.8, 19.2, 10.8, 12.6, 10.8, 14.6, 10.8, 10.8)

    /** The fold: 230ms on --ease-emph. */
    const val MORPH_MS = 230

    /** The violet outline draws once round the button in this long. */
    const val RING_MS = 460

    /** The glyph at morph m (0 arrow, 1 square) as x, y pairs; it dips a little mid change so the in between poses stay small. */
    fun points(m: Double, out: DoubleArray = DoubleArray(18)): DoubleArray {
        val dip = 1 - 0.22 * sin(PI * clamp01(m))
        for (i in 0 until 9) {
            val px = lerp(ARROW[2 * i], SQUARE[2 * i], m)
            val py = lerp(ARROW[2 * i + 1], SQUARE[2 * i + 1], m)
            out[2 * i] = 15 + (px - 15) * dip
            out[2 * i + 1] = 15 + (py - 15) * dip
        }
        return out
    }
}

/**
 * A label that turns into another and keeps what they share at the start
 * (the Fold's "Thinking" to "Thought for 6s" keeps "Th").
 */
data class Morph(val shared: String, val old: String, val fresh: String) {
    companion object {
        /** Old letters leave right to left, 110ms each, 12ms apart. */
        const val OUT_MS = 110
        const val OUT_STEP = 12

        /** New letters arrive left to right, 220ms each, 16ms apart, once the old ones are gone. */
        const val IN_MS = 220
        const val IN_STEP = 16

        fun of(from: String, to: String): Morph {
            var n = 0
            while (n < from.length && n < to.length && from[n] == to[n]) n++
            return Morph(to.substring(0, n), from.substring(n), to.substring(n))
        }

        /** When the new letters start, after the old ones have left. */
        fun inAt(old: String): Int = if (old.isEmpty()) 0 else 120 + 12 * (old.length - 1)
    }
}
