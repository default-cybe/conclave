package dev.conclave.app.ui.motion

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.MonaSans
import dev.conclave.client.motion.KNOT_LENGTH
import dev.conclave.client.motion.ROPE_OVER
import dev.conclave.client.motion.ROPE_UNDER
import dev.conclave.client.motion.RopeGeometry
import dev.conclave.client.motion.RopeLight
import dev.conclave.client.motion.RopeMoment
import dev.conclave.client.motion.RopePose
import dev.conclave.client.motion.knotHalo
import dev.conclave.client.motion.knotWidth
import dev.conclave.client.motion.ropeCamera
import dev.conclave.client.motion.ropeCaps
import dev.conclave.client.motion.ropeDuration
import dev.conclave.client.motion.ropePoint
import dev.conclave.client.motion.ropePose
import dev.conclave.client.motion.ropeRest
import dev.conclave.client.motion.ropeRing
import dev.conclave.client.motion.ropeSpan
import dev.conclave.client.motion.ropeTimes
import kotlin.math.min

/**
 * The knot as a rope that ties itself (docs/design/KNOT-MOTION.md), the same
 * as the web's KnotRope: one rope slides along its own path, over and under
 * at each crossing; nothing morphs. Every frame comes from the rope math in
 * dev.conclave.client.motion, drawn piece by piece with
 * PathMeasure.getSegment, round caps, in the spec's order: the lead in, the
 * under paths, the halos, the lead out, the over paths, each with its light.
 *
 * LAUNCH       a straight rope, its tip lit, ties itself; cinch; one light lap (cold start)
 * LAUNCH_LONG  the same, slower, then [word] fades in (the first run, before pairing)
 * RUN          a short piece with a light at its head runs the dim knot (waiting on the hub)
 * SUCCESS      the light runs two laps from home and slows into place; cinch (paired, back online)
 * RECEIVE      a rope slides in from the right and ties; cinch; one lap (a friend's share arrives)
 * SEND         the rope pulls out through the knot to the left, the light leading (sent to a friend)
 *
 * LAUNCH, RECEIVE and SEND draw a view twice as wide as the knot's box
 * ([size]); the view clips the rope. RUN and SUCCESS are the box. Every
 * moment but RUN plays once and calls [onDone]. With "Remove animations"
 * it draws the tied knot with the light at rest and calls [onDone] at once.
 *
 * @param surface the color behind the mark when it is not the page background (the halos take it).
 * @param onTied called once when a tie is done (LAUNCH, RECEIVE), before the cinch and the lap.
 */
@Composable
fun KnotRope(
    moment: RopeMoment,
    modifier: Modifier = Modifier,
    size: Dp = 64.dp,
    surface: Color? = null,
    word: String? = null,
    label: String? = null,
    onTied: (() -> Unit)? = null,
    onDone: (() -> Unit)? = null,
) {
    val c = Conclave.colors
    val reduced = reducedMotion()
    val wide = moment != RopeMoment.RUN && moment != RopeMoment.SUCCESS
    val paths = remember { RopePaths() }
    val onscreen = rememberOnscreen()
    val tick = remember { mutableLongStateOf(0L) }
    // the moment's clock: from its first frame
    val start = remember(moment) { mutableDoubleStateOf(Double.NaN) }
    val played = remember(moment) { BooleanArray(2) }
    val tied by rememberUpdatedState(onTied)
    val done by rememberUpdatedState(onDone)
    val total = ropeDuration(moment)

    // run loops only while it shows; the others play once, through to the end
    LaunchedEffect(moment, reduced, if (moment == RopeMoment.RUN) onscreen.visible else true) {
        if (reduced) {
            tied?.invoke()
            done?.invoke()
            return@LaunchedEffect
        }
        if (played[1] || (moment == RopeMoment.RUN && !onscreen.visible)) return@LaunchedEffect
        val times = ropeTimes(moment)
        val tiedAt = if (times != null && times.to == RopeGeometry.KNOT) times.straight + times.move else Double.POSITIVE_INFINITY
        while (true) {
            withFrameNanos { tick.longValue = it }
            val now = motionNow()
            if (start.doubleValue.isNaN()) start.doubleValue = now
            val t = now - start.doubleValue
            if (!played[0] && t >= tiedAt) {
                played[0] = true
                tied?.invoke()
            }
            if (t >= total) {
                played[1] = true
                done?.invoke()
                break
            }
        }
    }

    // the pose and the time it is for, read only while drawing so a frame never recomposes
    fun at(): Pair<RopePose, Double> {
        tick.longValue
        if (reduced) return ropeRest() to Double.POSITIVE_INFINITY
        val s = start.doubleValue
        val t = min(if (s.isNaN()) 0.0 else motionNow() - s, total)
        return ropePose(moment, t) to t
    }

    val described = if (label != null) Modifier.semantics { contentDescription = label } else Modifier
    val halo = surface ?: c.bg
    val box = size.value.toDouble()
    val canvas = Modifier
        .size(width = if (wide) size * 2 else size, height = size)
        .clipToBounds()
        .onscreen(onscreen)
        .then(described)
    if (word == null) {
        Canvas(modifier.then(canvas)) {
            val (pose, t) = at()
            drawRope(paths, moment, pose, t, box, c.fg, c.rule2, c.signal, halo)
        }
        return
    }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Canvas(canvas) {
            val (pose, t) = at()
            drawRope(paths, moment, pose, t, box, c.fg, c.rule2, c.signal, halo)
        }
        Text(
            word,
            style = TextStyle(fontFamily = MonaSans, fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 31.sp, letterSpacing = (-0.01).em),
            color = c.fg,
            modifier = Modifier.graphicsLayer {
                val w = at().first.word.toFloat()
                alpha = w
                translationY = (1 - w) * RopeGeometry.WORD_RISE.toFloat() * density
            },
        )
    }
}

private val UNDERS = RopeGeometry.PATHS.indices.filter { RopeGeometry.PATHS[it].kind == ROPE_UNDER }
private val OVERS = RopeGeometry.PATHS.indices.filter { RopeGeometry.PATHS[it].kind == ROPE_OVER }

/** The rope's paths and halos as Paths in the knot's 64 unit box, and a measure for each. */
internal class RopePaths {
    val paths: List<Path> = RopeGeometry.PATHS.map { path(it.points) }
    val halos: List<Path> = RopeGeometry.HALOS.map { path(it) }
    private val measures = paths.map { p -> PathMeasure().also { it.setPath(p, false) } }
    private val lengths = FloatArray(measures.size) { measures[it].length }
    private val haloMeasures = halos.map { p -> PathMeasure().also { it.setPath(p, false) } }
    private val haloLengths = FloatArray(haloMeasures.size) { haloMeasures[it].length }
    private val segment = Path()
    private val parts = DoubleArray(4)
    val caps = DoubleArray(3)
    val point = DoubleArray(2)

    private fun path(pts: FloatArray) = Path().apply {
        moveTo(pts[0], pts[1])
        var i = 2
        while (i < pts.size) {
            lineTo(pts[i], pts[i + 1])
            i += 2
        }
    }

    /** Draws [a, b] (in the path's own units, of [length]) of a measured path: whole when it is all of it, as the still mark. */
    private fun DrawScope.part(p: Path, m: PathMeasure, measured: Float, length: Double, a: Double, b: Double, color: Color, stroke: Stroke) {
        if (a <= 1e-3 && b >= length - 1e-3) {
            drawPath(p, color, style = stroke)
            return
        }
        segment.reset()
        if (m.getSegment((a / length * measured).toFloat(), (b / length * measured).toFloat(), segment, true)) drawPath(segment, color, style = stroke)
    }

    /** The window [from, to] on path [i]. */
    fun DrawScope.span(i: Int, from: Double, to: Double, color: Color, stroke: Stroke) {
        val r = RopeGeometry.PATHS[i]
        if (ropeSpan(r.from, r.length, from, to, parts)) part(paths[i], measures[i], lengths[i], r.length, parts[0], parts[1], color, stroke)
    }

    /** [from, to] round the knot on path [i]: one or two parts. */
    fun DrawScope.ring(i: Int, from: Double, to: Double, color: Color, stroke: Stroke) {
        val r = RopeGeometry.PATHS[i]
        val n = ropeRing(r.from, r.length, from, to, parts)
        val a0 = parts[0]
        val b0 = parts[1]
        val a1 = parts[2]
        val b1 = parts[3]
        if (n >= 1) part(paths[i], measures[i], lengths[i], r.length, a0, b0, color, stroke)
        if (n >= 2) part(paths[i], measures[i], lengths[i], r.length, a1, b1, color, stroke)
    }

    /** Halo [j] where the window [from, to] has its over strand. */
    fun DrawScope.halo(j: Int, from: Double, to: Double, color: Color, stroke: Stroke) {
        val length = RopeGeometry.HALO_LENGTH[j]
        if (ropeSpan(RopeGeometry.HALO_FROM[j], length, from, to, parts)) part(halos[j], haloMeasures[j], haloLengths[j], length, parts[0], parts[1], color, stroke)
    }
}

/**
 * Draws a pose of the rope in a canvas whose height is the knot's box of
 * [s] dp: bottom to top, the lead in, the under paths, the halos in the
 * surface color, the lead out, the over paths (each with its dim knot, its
 * base and its lights). The over paths' base ends flat, as the still mark;
 * round dots go where the rope ends on one (ropeCaps).
 */
internal fun DrawScope.drawRope(paths: RopePaths, moment: RopeMoment, pose: RopePose, t: Double, s: Double, base: Color, dim: Color, light: Color, surface: Color) {
    val k = size.height / 64f
    val viewX = if (moment == RopeMoment.RECEIVE || moment == RopeMoment.SEND) -32f else 0f
    val w = knotWidth(s)
    val round = Stroke(width = w, cap = StrokeCap.Round, join = StrokeJoin.Round)
    val flat = Stroke(width = w, cap = StrokeCap.Butt, join = StrokeJoin.Round)
    val haloStroke = Stroke(width = knotHalo(s), cap = StrokeCap.Butt, join = StrokeJoin.Round)
    val cam = if (moment == RopeMoment.LAUNCH || moment == RopeMoment.LAUNCH_LONG) {
        ropeCamera(ropeTimes(moment)!!, t, RopeGeometry.CAMERA_VIEW_W, RopeGeometry.CAMERA_VIEW_H, w.toDouble())
    } else {
        null
    }
    val ww = pose.w
    val trail = light.copy(alpha = light.alpha * (pose.trail * RopeGeometry.TRAIL_OPACITY).toFloat())
    val runEnd = pose.run + RopeGeometry.RUN_LENGTH
    val trailFrom = pose.lap - RopeGeometry.TRAIL_BACK

    /** One path's base, trail and lights, in that order. */
    fun DrawScope.lights(i: Int) = with(paths) {
        if (pose.trail > 0) ring(i, trailFrom, trailFrom + RopeGeometry.TRAIL_LENGTH, trail, round)
        when (pose.light) {
            RopeLight.HEAD -> span(i, ww + RopeGeometry.LIGHT_BACK, ww + KNOT_LENGTH, light, round)
            RopeLight.LAP -> ring(i, pose.lap, pose.lap + RopeGeometry.LIGHT, light, round)
            RopeLight.RUN -> ring(i, runEnd - RopeGeometry.RUN_LIGHT, runEnd, light, round)
        }
    }

    fun DrawScope.base(i: Int, stroke: Stroke) = with(paths) {
        if (pose.light == RopeLight.RUN) ring(i, pose.run, runEnd, base, stroke) else span(i, ww, ww + KNOT_LENGTH, base, stroke)
    }

    val fade = pose.fade.toFloat().coerceIn(0f, 1f)
    if (fade < 1f) drawIntoCanvas { it.saveLayer(Rect(Offset.Zero, size), Paint().apply { alpha = fade }) }
    withTransform({
        scale(k, k, pivot = Offset.Zero)
        translate(-viewX, 0f)
        if (cam != null) {
            translate(RopeGeometry.CAMERA_VIEW_W.toFloat() / 2, RopeGeometry.CAMERA_VIEW_H.toFloat() / 2)
            scale(cam.s.toFloat(), cam.s.toFloat(), pivot = Offset.Zero)
            translate(-cam.x.toFloat(), -cam.y.toFloat())
        }
        if (pose.cinch != 1.0) scale(pose.cinch.toFloat(), pose.cinch.toFloat(), pivot = Offset(32f, 32f))
    }) {
        val first = 0
        val last = RopeGeometry.PATHS.size - 1
        // the run piece goes round the knot only; the leads are for the moments that move the rope
        val leads = pose.light != RopeLight.RUN
        // 1. the lead in and its light
        if (leads) base(first, round)
        if (pose.light == RopeLight.HEAD) with(paths) { span(first, ww + RopeGeometry.LIGHT_BACK, ww + KNOT_LENGTH, light, round) }
        // 2. the under paths: the dim knot (run), the base, then the lights
        if (moment == RopeMoment.RUN) for (i in UNDERS) drawPath(paths.paths[i], dim, style = round)
        for (i in UNDERS) base(i, round)
        for (i in UNDERS) lights(i)
        // 3. the halos, where the over strand is
        for (j in paths.halos.indices) with(paths) { halo(j, ww, ww + KNOT_LENGTH, surface, haloStroke) }
        // 4. the lead out and its light, above the halos so a halo never cuts the leaving rope
        if (leads) base(last, round)
        if (pose.light == RopeLight.HEAD) with(paths) { span(last, ww + RopeGeometry.LIGHT_BACK, ww + KNOT_LENGTH, light, round) }
        // 5. the over paths: flat ends as the still mark, round dots where needed, then the lights
        if (moment == RopeMoment.RUN) {
            // the dim over strands lie above the under base: they go only where the base does not, so no join shows a seam
            if (pose.light == RopeLight.RUN) for (i in OVERS) with(paths) { ring(i, runEnd, pose.run + KNOT_LENGTH, dim, flat) }
            ropePoint(RopeGeometry.KNOT, paths.point)
            drawCircle(dim, radius = w / 2, center = Offset(paths.point[0].toFloat(), paths.point[1].toFloat()))
        }
        for (i in OVERS) base(i, flat)
        val n = ropeCaps(pose, paths.caps)
        for (j in 0 until n) {
            ropePoint(paths.caps[j], paths.point)
            drawCircle(base, radius = w / 2, center = Offset(paths.point[0].toFloat(), paths.point[1].toFloat()))
        }
        for (i in OVERS) lights(i)
    }
    if (fade < 1f) drawIntoCanvas { it.restore() }
}
