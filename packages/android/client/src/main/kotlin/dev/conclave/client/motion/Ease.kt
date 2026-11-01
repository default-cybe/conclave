package dev.conclave.client.motion

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Easing and small math for motion drawn from time (the Knot, the Rim, Ink).
 * The same curves as packages/web/src/components/motion/ease.ts and the CSS
 * tokens in packages/web/src/styles/motion.css. Pure, no Android, so the
 * :client tests check it on any JVM.
 */

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of progress 0..1 (the web's bisection, 40 steps). */
class CubicBezier(x1: Double, y1: Double, x2: Double, y2: Double) {
    private val cx = 3 * x1
    private val bx = 3 * (x2 - x1) - cx
    private val ax = 1 - cx - bx
    private val cy = 3 * y1
    private val by = 3 * (y2 - y1) - cy
    private val ay = 1 - cy - by

    private fun sx(u: Double) = ((ax * u + bx) * u + cx) * u
    private fun sy(u: Double) = ((ay * u + by) * u + cy) * u

    operator fun invoke(x: Double): Double {
        if (x <= 0) return 0.0
        if (x >= 1) return 1.0
        var lo = 0.0
        var hi = 1.0
        var u = x
        for (i in 0 until 40) {
            val v = sx(u)
            if (abs(v - x) < 1e-6) break
            if (v < x) lo = u else hi = u
            u = (lo + hi) / 2
        }
        return sy(u)
    }
}

/** The motion curves. Names match the CSS tokens (--ease, --ease-in, ...). */
object Ease {
    /** --ease: entrances and settles. */
    val out = CubicBezier(0.2, 0.7, 0.2, 1.0)

    /** --ease-in: exits. */
    val inn = CubicBezier(0.4, 0.0, 1.0, 1.0)

    /** --ease-sine: loops, the breath. */
    val sine = CubicBezier(0.37, 0.0, 0.63, 1.0)

    /** --ease-morph: the Knot's light writes and lets go. */
    val morph = CubicBezier(0.6, 0.0, 0.4, 1.0)

    /** --ease-emph: a card grows into its panel, the send glyph folds. */
    val emph = CubicBezier(0.2, 0.0, 0.0, 1.0)

    /** --ease-std: a panel shrinks back, a fold reopens. */
    val std = CubicBezier(0.4, 0.0, 0.2, 1.0)
}

fun clamp01(x: Double): Double = if (x < 0) 0.0 else if (x > 1) 1.0 else x
fun clamp(x: Double, a: Double, b: Double): Double = if (x < a) a else if (x > b) b else x
fun lerp(a: Double, b: Double, t: Double): Double = a + (b - a) * t

/** Progress of t through [a, b], clamped to 0..1. */
fun seg(t: Double, a: Double, b: Double): Double = clamp01((t - a) / (b - a))

/** x mod m, always in [0, m). */
fun mod(x: Double, m: Double): Double = ((x % m) + m) % m

fun smooth(a: Double, b: Double, x: Double): Double {
    val t = clamp01((x - a) / (b - a))
    return t * t * (3 - 2 * t)
}

fun floorInt(x: Double): Int = floor(x).toInt()

/**
 * Step response of a damped spring, 0 to 1. [response] is the period in ms
 * (as in SwiftUI), [z] the damping ratio. z = 1 never overshoots.
 */
fun spring(t: Double, response: Double = Spring.RESPONSE.toDouble(), z: Double = Spring.DAMPING): Double {
    if (t <= 0) return 0.0
    val w = 2 * PI / response
    if (z >= 1) return 1 - exp(-w * t) * (1 + w * t)
    val wd = w * sqrt(1 - z * z)
    return 1 - exp(-z * w * t) * (cos(wd * t) + (z * w / wd) * sin(wd * t))
}

/** How long the spring takes to come within 0.1% of rest, in ms (rounded up to 10ms). */
fun springSettle(response: Double = Spring.RESPONSE.toDouble(), z: Double = Spring.DAMPING): Int {
    var t = 0
    while (t < 5000) {
        if (abs(1 - spring(t.toDouble(), response, z)) < 0.001 && abs(1 - spring(t + 40.0, response, z)) < 0.001) break
        t += 10
    }
    return t
}

/**
 * The spring as Compose's spring() stiffness: for mass 1 the natural
 * frequency is 2 pi / response, so stiffness = (2 pi / response s)^2.
 * 420ms gives about 224.
 */
fun springStiffness(response: Double = Spring.RESPONSE.toDouble()): Double {
    val w = 2 * PI / (response / 1000.0)
    return w * w
}
