package dev.conclave.app.ui.motion

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.PathParser
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.client.motion.GLYPH_LIGHT_LEN
import dev.conclave.client.motion.GLYPH_LIGHT_STILL
import dev.conclave.client.motion.GLYPH_PATHS
import dev.conclave.client.motion.GlyphKind
import dev.conclave.client.motion.GlyphState
import dev.conclave.client.motion.Loop
import dev.conclave.client.motion.glyphKind
import dev.conclave.client.motion.glyphPoints

/**
 * What kind of agent works, in one stroke on a 16 grid (CHAT-AND-MOTION
 * 1.11), the Compose side of the web's AgentGlyph.tsx. Running, a violet
 * light travels the stroke (LOOP_KNOT_TOOL); done, the stroke is fg-3 and
 * still; failed, the light holds in the fault color; waiting, it holds in
 * amber. It takes the slot a still Knot had in a row, so it is a mark, not
 * an icon. In a list only the first LIVE_ROWS running rows move (`still`
 * on the rest, stillRows()).
 *
 * @param type an agent type ("explore", "web-searcher"); unknown types draw general-purpose.
 * @param still draw the stroke and the resting light, never move: for rows beyond LIVE_ROWS.
 * @param label accessible name; without it the mark is decorative, so say the state in words next to it.
 */
@Composable
fun AgentGlyph(
    type: String?,
    state: GlyphState = GlyphState.RUNNING,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
    still: Boolean = false,
    label: String? = null,
) {
    val c = Conclave.colors
    val reduced = reducedMotion() || still
    val kind = glyphKind(type)
    val path = remember(kind) { glyphPath(kind) }
    val measure = remember(path) { PathMeasure().also { it.setPath(path, false) } }
    val onscreen = rememberOnscreen()
    val tick = remember { mutableLongStateOf(0L) }
    LaunchedEffect(state, reduced, onscreen.visible) {
        if (reduced || !onscreen.visible || state == GlyphState.DONE) return@LaunchedEffect
        while (true) withFrameNanos { tick.longValue = it }
    }
    val described = if (label != null) Modifier.semantics { contentDescription = label } else Modifier
    Canvas(modifier.size(size).onscreen(onscreen).then(described)) {
        tick.longValue
        val k = size.width / 16f
        val base = if (state == GlyphState.DONE) c.fg3 else c.fg2.copy(alpha = 0.35f)
        val light = when (state) {
            GlyphState.WAITING -> c.warn
            GlyphState.FAILED -> c.fault
            else -> c.signal
        }
        val stroke = Stroke(width = 1.5f, cap = StrokeCap.Round, join = StrokeJoin.Round)
        withTransform({ scale(k, k, pivot = Offset.Zero) }) {
            drawPath(path, base, style = stroke)
            if (state != GlyphState.DONE) drawLight(measure, stroke, light, if (reduced) GLYPH_LIGHT_STILL else phase(tick.longValue))
        }
    }
}

/** Where the light's head is along the path (0 to 1), one lap per LOOP_KNOT_TOOL. */
private fun phase(now: Long): Float = ((now / 1_000_000f) % Loop.KNOT_TOOL) / Loop.KNOT_TOOL

/** The light as one 22% segment of the path, wrapping at the start when the tail crosses it. */
private fun DrawScope.drawLight(m: PathMeasure, stroke: Stroke, color: Color, head: Float) {
    val len = m.length
    if (len <= 0f) return
    val segment = Path()
    val tail = (head - GLYPH_LIGHT_LEN) % 1f
    if (tail >= 0f) {
        if (m.getSegment(tail * len, head * len, segment, true)) drawPath(segment, color, style = stroke)
    } else {
        if (m.getSegment(0f, head * len, segment, true)) drawPath(segment, color, style = stroke)
        segment.reset()
        if (m.getSegment((1f + tail) * len, len, segment, true)) drawPath(segment, color, style = stroke)
    }
}

/** The kind's stroke: the web's SVG path parsed, or the knot's own points for general-purpose. */
private fun glyphPath(kind: GlyphKind): Path {
    val pts = glyphPoints(kind)
    if (pts != null) {
        val p = Path()
        p.moveTo(pts[0], pts[1])
        var i = 2
        while (i < pts.size) {
            p.lineTo(pts[i], pts[i + 1])
            i += 2
        }
        p.close()
        return p
    }
    return PathParser().parsePathString(GLYPH_PATHS.getValue(kind)).toPath()
}
