package dev.conclave.app.ui.motion

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveColors
import dev.conclave.client.motion.Ease
import dev.conclave.client.motion.Loop
import dev.conclave.client.motion.RimBox
import dev.conclave.client.motion.RimMode
import dev.conclave.client.motion.RimMotion
import dev.conclave.client.motion.RimState
import dev.conclave.client.motion.lerp
import dev.conclave.client.motion.seg
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import dev.conclave.client.motion.Rim as RimMath

/**
 * One thin light on the composer's edge (light.html Rim, Breath, Settle,
 * Fault):
 *
 *   LIVE     a violet light with a 190dp tail runs once round the edge every 4s
 *   WAITING  the light goes out and the whole edge breathes amber: in 1.6s, out 2.2s, rest
 *   DONE     the light coasts, its tail opens round the whole edge, glows evenly, then fades to the hairline
 *   FAILED   the light brakes, its tail draws in, it cools to the fault color and stays as a short mark
 *   IDLE     nothing (the box's own hairline)
 *
 * Put it on the box that draws the border, before anything that clips:
 * it draws over the border's middle line and up to 2.5dp past it, never
 * over the content. Canvas only; it draws only while something changes.
 * With "Remove animations": a still violet segment, a still amber edge, a
 * short red mark, or nothing.
 */
@Composable
fun Modifier.rim(state: RimState, radius: Dp, border: Dp = 1.dp): Modifier {
    val c = Conclave.colors
    val reduced = reducedMotion()
    val motion = remember { RimMotion(state, motionNow()) }
    SideEffect { motion.set(state, motionNow()) }
    val colors = remember(c) { rimColors(c) }
    val tick = remember { mutableLongStateOf(0L) }
    LaunchedEffect(state, reduced) {
        if (reduced) return@LaunchedEffect
        do {
            withFrameNanos { tick.longValue = it }
        } while (motion.step(motionNow()))
        tick.longValue++
    }
    return this.drawWithContent {
        drawContent()
        tick.longValue
        val now = motionNow()
        if (!reduced) motion.step(now)
        if (motion.state == RimState.IDLE && motion.lightA <= 0.001 && motion.breathA <= 0.001) return@drawWithContent
        val b = border.toPx() / 2f
        val w = (size.width - 2 * b) / density
        val h = (size.height - 2 * b) / density
        val r = min((radius.toPx() - b) / density, min(w, h) / 2f).coerceAtLeast(0f)
        val box = RimBox(w.toDouble(), h.toDouble(), r.toDouble())
        val d = density
        withTransform({
            translate(b, b)
            scale(d, d, pivot = Offset.Zero)
        }) {
            drawRim(box, motion, now, colors, reduced)
        }
    }
}

private class RimColors(
    val signal: Color,
    val hot: Color,
    val warn: Color,
    val fault: Color,
    val faultHot: Color,
    val even: Color,
    val dark: Boolean,
)

/** a + (b - a) * t per sRGB channel, as the web mixes. */
internal fun mixColor(a: Color, b: Color, t: Float): Color = Color(
    red = a.red + (b.red - a.red) * t,
    green = a.green + (b.green - a.green) * t,
    blue = a.blue + (b.blue - a.blue) * t,
    alpha = a.alpha + (b.alpha - a.alpha) * t,
)

private fun rimColors(c: ConclaveColors) = RimColors(
    signal = c.signal,
    hot = if (c.dark) mixColor(c.waveHot, Color.White, 0.35f) else c.waveHot,
    warn = c.warn,
    fault = c.fault,
    faultHot = if (c.dark) mixColor(c.fault, Color.White, 0.25f) else c.fault,
    even = mixColor(c.signal, c.fg2, 0.75f),
    dark = c.dark,
)

private fun roundRect(box: RimBox, inset: Float = 0f): RoundRect {
    val w = box.w.toFloat()
    val h = box.h.toFloat()
    val r = max(0f, box.r.toFloat() - inset)
    return RoundRect(inset, inset, max(inset, w - inset), max(inset, h - inset), CornerRadius(r, r))
}

private val tmpA = DoubleArray(2)
private val tmpB = DoubleArray(2)

private fun DrawScope.drawLight(box: RimBox, head: Double, tail: Double, k: Double, cf: Double, cl: RimColors) {
    if (k <= 0.001) return
    val col = mixColor(cl.signal, cl.fault, cf.toFloat())
    val hot = mixColor(cl.hot, cl.faultHot, cf.toFloat())
    val halo = if (cl.dark) 0.22f else 0.12f
    val wash = (if (cl.dark) 0.06f else 0.05f) * (1f - cf.toFloat() * 0.5f)
    // the surface just inside the edge catches a little light near the head: a band 14dp deep, never a blob
    val hp = box.at(head, tmpA)
    val band = Path().apply {
        fillType = PathFillType.EvenOdd
        addRoundRect(roundRect(box))
        addRoundRect(roundRect(box, 14f))
    }
    clipPath(band) {
        val center = Offset(hp[0].toFloat(), hp[1].toFloat())
        drawCircle(
            Brush.radialGradient(listOf(col.copy(alpha = (wash * k * 1.4).toFloat().coerceIn(0f, 1f)), col.copy(alpha = 0f)), center = center, radius = 70f),
            radius = 70f,
            center = center,
        )
    }
    val step = 2.0
    val n = max(2, ceil(tail / step).toInt())
    for (pass in 0..1) {
        val start = box.at(head, tmpA)
        var px = start[0].toFloat()
        var py = start[1].toFloat()
        for (i in 1..n) {
            val behind = i * step
            val p = box.at(head - behind, tmpB)
            val f = (1 - (behind - step / 2) / tail).coerceAtLeast(0.0).pow(1.7).toFloat()
            val x = p[0].toFloat()
            val y = p[1].toFloat()
            if (pass == 0) {
                drawLine(col.copy(alpha = (halo * f * f * k).toFloat().coerceIn(0f, 1f)), Offset(px, py), Offset(x, y), strokeWidth = 5f, cap = StrokeCap.Butt)
            } else {
                drawLine(mixColor(col, hot, f * f * f).copy(alpha = (f * k).toFloat().coerceIn(0f, 1f)), Offset(px, py), Offset(x, y), strokeWidth = 1f, cap = StrokeCap.Butt)
            }
            px = x
            py = y
        }
    }
}

private fun DrawScope.drawEven(box: RimBox, color: Color, a: Double, glow: Double) {
    if (a <= 0.001) return
    val path = Path().apply { addRoundRect(roundRect(box)) }
    drawPath(path, color.copy(alpha = (a * glow).toFloat().coerceIn(0f, 1f)), style = Stroke(width = 5f))
    drawPath(path, color.copy(alpha = a.toFloat().coerceIn(0f, 1f)), style = Stroke(width = 1f))
}

/** The Rim at [now], or its still pose under reduced motion. */
private fun DrawScope.drawRim(box: RimBox, m: RimMotion, now: Double, cl: RimColors, still: Boolean) {
    val p = box.perimeter
    val v = p / Loop.RIM
    val halo = if (cl.dark) 0.22 else 0.12
    if (still) {
        when (m.state) {
            RimState.LIVE -> drawLight(box, p * 0.3, RimMath.TAIL, 1.0, 0.0, cl)
            RimState.WAITING -> drawEven(box, cl.warn, 0.45, 0.2)
            RimState.FAILED -> drawLight(box, p * 0.3, RimMath.FAULT_TAIL, 0.6, 1.0, cl)
            else -> Unit
        }
        return
    }
    val tail = min(RimMath.TAIL, p * 0.45)
    val t = now - m.modeAt
    when (m.mode) {
        RimMode.RUN -> drawLight(box, RimMath.headAt(p, m.liveT), tail, m.lightA, 0.0, cl)
        RimMode.SETTLE -> {
            val c = seg(t, 0.0, 700.0)
            val s = RimMath.headAt(p, m.liveT) + v * 700 * (c - c * c / 2)
            val k = 1 - Ease.sine(seg(t, 50.0, 550.0))
            drawLight(box, s, lerp(tail, p, Ease.out(c)), k, 0.0, cl)
            val fill = Ease.sine(seg(t, 50.0, 550.0)) * (1 - Ease.sine(seg(t, 600.0, 1500.0))) * 0.62
            drawEven(box, cl.even, fill, halo * 0.6)
        }
        RimMode.FAULT -> {
            val b = seg(t, 0.0, 600.0)
            val s = RimMath.headAt(p, m.liveT) + v * 600 * (b - b * b / 2)
            val k = 1 - 0.4 * Ease.sine(seg(t, 600.0, 1200.0))
            drawLight(box, s, lerp(tail, RimMath.FAULT_TAIL, Ease.out(b)), k * m.lightA, Ease.out(seg(t, 50.0, 600.0)), cl)
        }
        RimMode.OFF -> Unit
    }
    if (m.breathA > 0.001) {
        val b = RimMath.breath(m.breathT)
        // the whole edge breathes amber; the words stay still
        drawEven(box, cl.warn, m.breathA * (0.16 + 0.42 * b), 0.08 + 0.22 * b)
    }
}
