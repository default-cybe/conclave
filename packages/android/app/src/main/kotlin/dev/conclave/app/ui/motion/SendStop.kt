package dev.conclave.app.ui.motion

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.client.motion.Ease
import dev.conclave.client.motion.SendStop
import dev.conclave.client.motion.lerp
import dev.conclave.client.motion.seg

/**
 * The composer's Send button with the fold into Stop (ui.html Send to
 * stop): while a reply runs the arrow folds into a stop square (230ms,
 * --ease-emph), and when the reply ends the square opens back into the
 * arrow. Solid while there is something to send or a reply runs, quiet
 * otherwise. It keeps its size, so nothing around it moves. With "Remove
 * animations" the glyph swaps at once.
 *
 * On a composer the Rim is the one light, so the button carries no ring
 * (CHAT-AND-MOTION 1.9). Elsewhere [ring] adds a thin violet outline that
 * draws once round the button, 3dp out, then rests faint while it runs; it
 * never turns, and it fades when the reply ends.
 *
 * @param running a reply runs and the box is empty: the button is Stop.
 * @param ready there is something to send.
 */
@Composable
fun SendStopButton(
    running: Boolean,
    ready: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 40.dp,
    face: Dp = 32.dp,
    radius: Dp = 5.dp,
    glyph: Dp = 18.dp,
    sendLabel: String = "Send",
    ring: Boolean = false,
    /** The fill while there is something to send or a reply runs, and the glyph on it. */
    fill: Color = Conclave.colors.solid,
    fillInk: Color = Conclave.colors.solidFg,
    /** With nothing to send, an fg-4 outline instead of the quiet fill (MOBILE-V2 4). */
    outline: Boolean = false,
) {
    val c = Conclave.colors
    val reduced = reducedMotion()
    val solid = running || ready
    val on = solid && enabled
    val bg by animateColorAsState(if (on) fill else if (outline) Color.Transparent else c.rule, tween(if (reduced) 0 else Motion.DUR_1), label = "send-bg")
    val fg by animateColorAsState(if (on) fillInk else c.fg4, tween(if (reduced) 0 else Motion.DUR_1), label = "send-fg")
    val edge by animateColorAsState(if (outline && !on) c.fg4 else Color.Transparent, tween(if (reduced) 0 else Motion.DUR_1), label = "send-edge")
    val st = remember { SendStopState(if (running) 1.0 else 0.0) }
    val now0 = motionNow()
    if (st.target != running) {
        st.from = st.m(now0, reduced)
        st.at = now0
        st.target = running
        if (running) {
            st.ringAt = now0
            st.ringShown = true
        } else {
            st.ringOffAt = now0
        }
    }
    val tick = remember { mutableLongStateOf(0L) }
    LaunchedEffect(running, reduced) {
        if (reduced) return@LaunchedEffect
        val until = st.at + maxOf(SendStop.MORPH_MS + 20.0, if (ring && running) 60.0 + SendStop.RING_MS + 650 else 220.0)
        while (motionNow() < until) withFrameNanos { tick.longValue = it }
        tick.longValue++
    }
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    val label = if (running) "Stop" else sendLabel
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(radius))
            .clickable(interactionSource = press, indication = null, enabled = enabled, onClickLabel = label, onClick = onClick)
            .semantics { contentDescription = label; role = Role.Button }
            .then(
                if (ring) {
                    Modifier.drawBehind {
                        tick.longValue
                        drawRing(st, motionNow(), reduced, running, face.toPx(), radius.toPx(), c.signal)
                    }
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(face)
                .graphicsLayer {
                    val s = if (pressed && enabled) 0.94f else 1f
                    scaleX = s
                    scaleY = s
                }
                .clip(RoundedCornerShape(radius))
                .background(bg)
                .border(1.5.dp, edge, RoundedCornerShape(radius)),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.size(glyph)) {
                tick.longValue
                drawGlyph(st.m(motionNow(), reduced), fg)
            }
        }
    }
}

private class SendStopState(start: Double) {
    var target = start > 0.5
    var from = start
    var at = -1e9
    /** When the outline started drawing; long ago when mounted running, so it rests. */
    var ringAt = -1e9
    var ringOffAt = -1e9
    /** The outline has been drawn, so it has something to fade. */
    var ringShown = start > 0.5

    fun m(now: Double, reduced: Boolean): Double {
        val to = if (target) 1.0 else 0.0
        if (reduced) return to
        return lerp(from, to, Ease.emph(seg(now, at, at + SendStop.MORPH_MS)))
    }
}

private val pts = DoubleArray(18)

/** The arrow (m = 0) folding into the square (m = 1), drawn in the 30 x 30 box; the arrow is about 0.8 of the glyph size. */
private fun DrawScope.drawGlyph(m: Double, color: Color) {
    val unit = size.width / 18f
    SendStop.points(m, pts)
    val path = Path()
    for (i in 0 until 9) {
        val x = pts[2 * i].toFloat()
        val y = pts[2 * i + 1].toFloat()
        if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    path.close()
    withTransform({
        translate(size.width / 2f - 15f * unit, size.height / 2f - 15f * unit)
        scale(unit, unit, pivot = Offset.Zero)
    }) {
        drawPath(path, color, style = Fill)
        drawPath(path, color, style = Stroke(width = 1.6f, join = StrokeJoin.Round))
    }
}

/** The outline round the button face, traced clockwise from the middle of its top edge. */
private fun DrawScope.drawRing(st: SendStopState, now: Double, reduced: Boolean, running: Boolean, face: Float, radius: Float, signal: Color) {
    val out = 3.dp.toPx()
    val half = face / 2f + out
    val r = radius + out
    val cx = size.width / 2f
    val cy = size.height / 2f
    val path = Path().apply {
        moveTo(cx, cy - half)
        lineTo(cx + half - r, cy - half)
        arcTo(Rect(cx + half - 2 * r, cy - half, cx + half, cy - half + 2 * r), -90f, 90f, false)
        lineTo(cx + half, cy + half - r)
        arcTo(Rect(cx + half - 2 * r, cy + half - 2 * r, cx + half, cy + half), 0f, 90f, false)
        lineTo(cx - half + r, cy + half)
        arcTo(Rect(cx - half, cy + half - 2 * r, cx - half + 2 * r, cy + half), 90f, 90f, false)
        lineTo(cx - half, cy - half + r)
        arcTo(Rect(cx - half, cy - half, cx - half + 2 * r, cy - half + 2 * r), 180f, 90f, false)
        close()
    }
    val len = (8 * half - 2 * r * (4 - Math.PI.toFloat()))
    val w = 1.5.dp.toPx()
    if (reduced) {
        if (running) drawPath(path, signal.copy(alpha = 0.28f), style = Stroke(width = w))
        return
    }
    if (running) {
        val d = Ease.std(seg(now, st.ringAt + 60, st.ringAt + 60 + SendStop.RING_MS)).toFloat()
        val rest = Ease.out(seg(now, st.ringAt + 60 + SendStop.RING_MS, st.ringAt + 60 + SendStop.RING_MS + 600)).toFloat()
        if (d > 0f) drawPath(path, signal.copy(alpha = 0.28f * d), style = Stroke(width = w))
        if (d > 0f && rest < 1f) {
            drawPath(
                path,
                signal.copy(alpha = 0.95f * (1f - rest)),
                style = Stroke(width = w, cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(len * d, len), 0f)),
            )
        }
    } else {
        val k = 1f - Ease.inn(seg(now, st.ringOffAt, st.ringOffAt + 200)).toFloat()
        if (k > 0f && st.ringShown) drawPath(path, signal.copy(alpha = 0.28f * k), style = Stroke(width = w))
    }
}
