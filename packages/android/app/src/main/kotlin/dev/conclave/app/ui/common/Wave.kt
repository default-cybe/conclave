package dev.conclave.app.ui.common

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.motion.Knot
import dev.conclave.app.ui.motion.RollText
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Format
import dev.conclave.client.motion.KnotState
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlinx.coroutines.delay

/*
 * The Conclave dot-matrix wave (docs/design/SPEC.md section 9), ported from
 * packages/web/src/components/wave/engine.ts.
 *
 * A grid of dots whose brightness comes from a moving sine field. Each cell
 * gets a stable grain so flat areas have texture that never shimmers, then the
 * value is quantized into four levels with a 4x4 Bayer threshold, so mid tones
 * break into an ordered dither. Live work shows this instead of a spinner.
 *
 * It draws at 30 frames a second while on screen. With reduced motion (the
 * system "Remove animations" setting) or `still`, it draws one frame at t = 6.
 */

/** Variants and their defaults: dot pitch, brightest dot radius, signal tone. */
enum class WaveVariant(val gap: Dp, val radius: Dp, val signal: Boolean) {
    HERO(7.dp, 1.25.dp, false),
    SCOPE(4.dp, 1.1.dp, false),
    STRIP(3.dp, 0.9.dp, true),
    AMBIENT(6.dp, 1.dp, false),
}

private val TAU = (2 * PI).toFloat()
private val PI_F = PI.toFloat()
private const val STATIC_T = 6f
private const val FRAME_MS = 1000L / 30
private const val LEVELS = 4
private val BAYER = intArrayOf(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5)
    .map { (it + 0.5f) / 16f }
    .toFloatArray()

/** Cheap stable per-cell grain in 0..1 (same hash as the web engine). */
private fun grain(x: Int, y: Int): Float {
    var h = (x.toLong() * 374761393L + y.toLong() * 668265263L).toInt()
    h = (h xor (h ushr 13)) * 1274126177
    return ((h xor (h ushr 16)).toLong() and 0xFFFFFFFFL).toFloat() / 4294967295f
}

private fun heroTrace(u: Float, t: Float, amplitude: Float, env: Float): Float =
    amplitude * env * (
        0.52f * sin(TAU * (1.15f * u - 0.07f * t)) +
            0.27f * sin(TAU * (2.6f * u + 0.045f * t) + 1.7f) +
            0.12f * sin(TAU * (6.3f * u - 0.19f * t) + 0.4f)
        )

/** Brightness field. u in 0..1 left to right, v in -1..1 bottom to top. */
private fun field(
    variant: WaveVariant,
    rows: Int,
    u: Float,
    v: Float,
    t: Float,
    amplitude: Float,
    rate: Float,
    series: List<Float>?,
): Float = when (variant) {
    WaveVariant.STRIP -> {
        // a short undulating trace; packets of brightness ride along it
        val y = 0.62f * sin(TAU * (u * 1.4f - t * 0.45f)) * min(1f, amplitude)
        val d = v - y
        val line = exp(-(d * d) / 0.22f)
        val packet = 0.5f + 0.5f * sin(TAU * (u * 2.6f - t * 0.9f))
        0.07f + line * (0.5f + 0.72f * rate * packet)
    }
    WaveVariant.SCOPE -> {
        var y = 0.3f
        if (series != null && series.size > 1) {
            val f = u * (series.size - 1)
            val i = floor(f).toInt()
            val k = f - i
            val a = series[min(i, series.size - 1)]
            val b = series[min(i + 1, series.size - 1)]
            y = a + (b - a) * (k * k * (3 - 2 * k))
        }
        // a small live ripple at the leading edge
        val edge = max(0f, (u - 0.86f) / 0.14f)
        y += edge * 0.06f * amplitude * rate * 1.67f * sin(TAU * (u * 9f - t * 1.4f))
        val top = -1f + 2f * min(0.98f, max(0.02f, y * amplitude))
        val d = v - top
        val line = exp(-(d * d) / max(0.004f, 0.6f * (2f / rows).pow(2)))
        val area = if (d < 0) 0.16f + 0.26f * max(0f, 1f + d * 0.9f) else 0f
        val sweepPos = (t * 0.12f) % 1.25f
        val sweep = exp(-((u - sweepPos) * 9f).pow(2)) * 0.35f * (if (d < 0.05f) 1f else 0.2f)
        val live = edge * 0.25f
        max(line * (0.95f + live), area) + sweep * (if (area > 0f) 1f else 0.3f)
    }
    WaveVariant.AMBIENT -> {
        val a = sin(TAU * (u * 1.1f - t * 0.03f) + v * 2.1f)
        val b = sin(TAU * (u * 2.7f + t * 0.02f) - v * 1.3f + 1.9f)
        0.06f + 0.14f * (0.5f + 0.5f * (a * 0.6f + b * 0.4f))
    }
    WaveVariant.HERO -> {
        // a composite trace with a delayed afterglow
        val env = 0.35f + 0.65f * sin(PI_F * u)
        val d1 = v - heroTrace(u, t, amplitude, env) * 0.62f
        val d2 = v - heroTrace(u, t - 2.2f, amplitude, env) * 0.62f
        val line = exp(-(d1 * d1) / 0.01f)
        val halo = exp(-(d1 * d1) / 0.09f) * 0.34f
        val glow = exp(-(d2 * d2) / 0.035f) * 0.26f
        val swell = 0.17f * (0.5f + 0.5f * sin(2.4f * u + 1.8f * v - 0.5f * t)).pow(2) * (1f - kotlin.math.abs(v) * 0.6f)
        line * 0.92f + halo + glow + swell
    }
}

private fun DrawScope.drawWave(
    variant: WaveVariant,
    t: Float,
    gap: Float,
    radius: Float,
    amplitude: Float,
    rate: Float,
    series: List<Float>?,
    ink: Color,
    hot: Color,
) {
    val w = size.width
    val h = size.height
    if (w < 2f || h < 2f || gap <= 0f) return
    val cols = max(1, floor(w / gap).toInt())
    val rows = max(1, floor(h / gap).toInt())
    val ox = (w - (cols - 1) * gap) / 2f
    val oy = (h - (rows - 1) * gap) / 2f
    for (cy in 0 until rows) {
        val v = if (rows == 1) 0f else 1f - (2f * cy) / (rows - 1)
        for (cx in 0 until cols) {
            val u = if (cols == 1) 0.5f else cx.toFloat() / (cols - 1)
            val f = field(variant, rows, u, v, t, amplitude, rate, series) + (grain(cx, cy) - 0.5f) * 0.06f
            val q = f.coerceIn(0f, 1f) * LEVELS
            var lvl = floor(q).toInt()
            if (q - lvl > BAYER[(cy and 3) * 4 + (cx and 3)]) lvl++
            if (lvl <= 0) continue
            if (lvl > LEVELS) lvl = LEVELS
            val top = lvl == LEVELS
            drawCircle(
                color = if (top) hot else ink,
                radius = radius * (0.42f + 0.58f * lvl / LEVELS),
                center = Offset(ox + cx * gap, oy + cy * gap),
                alpha = if (top) 1f else 0.18f + 0.6f * lvl / LEVELS,
            )
        }
    }
}

/** True when the system asks for less motion ("Remove animations"). Follows the setting while the app runs. */
@Composable
fun rememberReducedMotion(): Boolean = reducedMotion()

/**
 * The dot-matrix wave. Size it with [modifier]; it fills its box.
 * Never narrower than 64dp, never behind text (spec 2).
 *
 * @param rate 0..1 activity level for the strip and scope ripple.
 * @param signal both dot colors in violet (live work). Strips default to it.
 * @param still draw one frame and never animate (a finished run).
 * @param series scope only: values 0..1, oldest first.
 * @param label set when the wave stands for something on its own.
 */
@Composable
fun Wave(
    variant: WaveVariant,
    modifier: Modifier = Modifier,
    gap: Dp = variant.gap,
    radius: Dp = variant.radius,
    speed: Float = 1f,
    amplitude: Float = 1f,
    rate: Float = 0.6f,
    signal: Boolean = variant.signal,
    still: Boolean = false,
    series: List<Float>? = null,
    label: String? = null,
) {
    val colors = Conclave.colors
    val ink = if (signal) colors.signal else colors.waveInk
    val hot = if (signal) colors.signal else colors.waveHot
    val frozen = still || rememberReducedMotion()
    var clock by remember { mutableFloatStateOf(STATIC_T) }
    if (!frozen) {
        LaunchedEffect(speed) {
            // 30 frames a second, in step with the display. Frames stop while the
            // app is in the background, and a step is capped at 0.1s, so the wave
            // resumes where it stopped.
            var last = withFrameMillis { it }
            while (true) {
                delay(FRAME_MS - 4)
                val now = withFrameMillis { it }
                clock += min(100L, now - last) / 1000f * speed
                last = now
            }
        }
    }
    val described = if (label != null) Modifier.semantics { contentDescription = label } else Modifier
    Canvas(modifier.then(described)) {
        drawWave(
            variant = variant,
            t = if (frozen) STATIC_T else clock,
            gap = gap.toPx(),
            radius = radius.toPx(),
            amplitude = amplitude,
            rate = rate,
            series = series,
            ink = ink,
            hot = hot,
        )
    }
}

/** Strip rate from live tokens per second (spec 9.2): clamp(tps / 60, 0.15, 1). */
fun rateFromTps(tps: Double?): Float =
    if (tps == null || tps.isNaN()) 0.6f else (tps / 60.0).toFloat().coerceIn(0.15f, 1f)

/**
 * Live work with room (spec 10.22): the Knot working, the word in violet
 * and the elapsed time, which rolls. Dots never mean working; the wave is
 * brand art only. [tps] is kept for callers and no longer changes anything.
 */
@Composable
fun LiveStrip(
    modifier: Modifier = Modifier,
    word: String? = "Running",
    startedAt: Long? = null,
    @Suppress("UNUSED_PARAMETER") tps: Double? = null,
    still: Boolean = false,
    /** False in a row of a list: rows never animate a Knot, so it holds its still working pose. */
    moving: Boolean = true,
) {
    val c = Conclave.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Knot(if (still) KnotState.DONE else KnotState.TOOL, size = 14.dp, still = !moving)
        if (word != null) {
            Spacer(Modifier.width(8.dp))
            Text(word, style = ConclaveType.meta, color = if (still) c.fg3 else c.signal, maxLines = 1)
        }
        if (startedAt != null) {
            val now by rememberNow()
            Spacer(Modifier.width(6.dp))
            RollText(Format.elapsed(now - startedAt), ConclaveType.metaNum, if (still) c.fg3 else c.signal)
        }
    }
}
