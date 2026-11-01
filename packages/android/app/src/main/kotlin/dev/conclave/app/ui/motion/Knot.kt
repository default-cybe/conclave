package dev.conclave.app.ui.motion

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.client.motion.KnotGeometry
import dev.conclave.client.motion.KnotMotion
import dev.conclave.client.motion.KnotPose
import dev.conclave.client.motion.KnotState
import dev.conclave.client.motion.Loop
import dev.conclave.client.motion.knotHalo
import dev.conclave.client.motion.knotLit
import dev.conclave.client.motion.knotStill
import dev.conclave.client.motion.knotWidth

/**
 * What the model is doing, said by the Knot: the Conclave mark, its light
 * moving (docs/design/CHAT-AND-MOTION.md 1.3 and 1.7, docs/design/brand;
 * the math is dev.conclave.client.motion, the same as the web).
 *
 * THINKING  the knot dims; one violet light writes it, then lets go from the tail (3s)
 * TOOL      the knot dims; a short violet light travels it, over and under (2s a lap)
 * WAITING   the light turns amber and holds where it is (waiting on you); resumes from there
 * PAUSED    a limit: the light holds in fg-3; thinking writes on from it when the limit resets
 * FAILED    the light stops and turns the fault color (put Retry next to it)
 * DONE      the light fades and the knot turns fg-3, still
 * BRAND     the still mark: the light lets go from its tail until it rests at home, the knot in fg
 *
 * A Canvas: the six pieces of the knot, the light on each with
 * PathMeasure.getSegment, halos in the surface color at the crossings. It
 * draws only while something changes: a live state, or a blend into a still
 * one. It stops offscreen, and the frame clock stops while the app is in the
 * background. With "Remove animations" each state is one still, clear pose.
 *
 * @param size 14 or 16 in a status line, 96 as the hero on Home (12 to 160).
 * @param mono draw the knot and its light in this one color (the knot at 30% while it works).
 * @param label accessible name; without it the mark is decorative, so say the state in words next to it.
 * @param surface the color behind the mark when it is not the page background (the halos take it).
 * @param since wall clock ms the thinking started: a Knot that takes over from another keeps its place in the loop.
 * @param still draw the state's one still pose and never move: for rows in a list, where another Knot already moves.
 */
@Composable
fun Knot(
    state: KnotState,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
    mono: Color? = null,
    label: String? = null,
    surface: Color? = null,
    since: Long? = null,
    still: Boolean = false,
) {
    val c = Conclave.colors
    val reduced = reducedMotion() || still
    val box = size.coerceIn(12.dp, 160.dp)
    val motion = remember {
        KnotMotion(state, motionNow()).also { m ->
            if (since != null) m.seek((System.currentTimeMillis() - since).toDouble(), motionNow())
        }
    }
    // follow the state; set() does nothing when it has not changed
    SideEffect { motion.set(state, motionNow()) }
    val working = state != KnotState.DONE && state != KnotState.BRAND
    val baseTarget = when {
        mono != null -> if (working) mono.copy(alpha = mono.alpha * 0.3f) else mono
        working -> c.rule2
        state == KnotState.BRAND -> c.fg
        else -> c.fg3
    }
    val lightTarget = mono ?: when (state) {
        KnotState.WAITING -> c.warn
        KnotState.PAUSED -> c.fg3
        KnotState.FAILED -> c.fault
        else -> c.signal
    }
    val base by animateColorAsState(baseTarget, tween(if (reduced) 0 else Motion.DUR_4, easing = Motion.Ease), label = "knot base")
    val light by animateColorAsState(lightTarget, tween(if (reduced) 0 else Motion.DUR_3, easing = Motion.Ease), label = "knot light")
    val paths = remember { KnotPaths() }
    val onscreen = rememberOnscreen()
    // the frame time, read only while drawing, so a frame never recomposes
    val tick = remember { mutableLongStateOf(0L) }
    LaunchedEffect(state, reduced, onscreen.visible) {
        if (reduced || !onscreen.visible) return@LaunchedEffect
        do {
            withFrameNanos { tick.longValue = it }
        } while (motion.moving(motionNow()))
    }
    val described = if (label != null) Modifier.semantics { contentDescription = label } else Modifier
    Canvas(
        modifier
            .size(box)
            .onscreen(onscreen)
            .then(described),
    ) {
        tick.longValue
        val pose = if (reduced) knotStill(state) else motion.pose(motionNow())
        drawKnot(paths, pose, box.value.toDouble(), base, light, surface ?: c.bg)
    }
}

/**
 * The Knot as a hero above a greeting: it writes for a loop and a half,
 * then settles into the still mark (BRAND), the light at home. With
 * animations off it is the still mark.
 */
@Composable
fun KnotHero(modifier: Modifier = Modifier, size: Dp = 96.dp) {
    val reduced = reducedMotion()
    var writing by remember { mutableStateOf(!reduced) }
    LaunchedEffect(Unit) {
        kotlinx.coroutines.delay((Loop.KNOT + 1400).toLong())
        writing = false
    }
    Knot(if (writing && !reduced) KnotState.THINKING else KnotState.BRAND, modifier, size = size)
}

/** The knot's pieces and halos as Paths in its 64 unit box, and a measure per piece for the light. */
internal class KnotPaths {
    val pieces: List<Path> = KnotGeometry.PIECES.map { path(it.points) }
    val halos: List<Path> = KnotGeometry.HALOS.map { path(it) }
    private val measures: List<PathMeasure> = pieces.map { p -> PathMeasure().also { it.setPath(p, false) } }
    private val lengths: FloatArray = FloatArray(measures.size) { measures[it].length }
    private val segment = Path()
    private val lit = DoubleArray(4)

    private fun path(pts: FloatArray) = Path().apply {
        moveTo(pts[0], pts[1])
        var i = 2
        while (i < pts.size) {
            lineTo(pts[i], pts[i + 1])
            i += 2
        }
    }

    /** Draws the light from tail to head on piece i: one or two segments of it. */
    fun DrawScope.light(i: Int, pose: KnotPose, color: Color, stroke: Stroke) {
        val piece = KnotGeometry.PIECES[i]
        val n = knotLit(piece, pose.tail, pose.head, lit)
        for (j in 0 until n) {
            segment.reset()
            val a = (lit[2 * j] / piece.length * lengths[i]).toFloat()
            val b = (lit[2 * j + 1] / piece.length * lengths[i]).toFloat()
            if (measures[i].getSegment(a, b, segment, true)) drawPath(segment, color, style = stroke)
        }
    }
}

private val UNDERS = intArrayOf(0, 2, 4)
private val OVERS = intArrayOf(1, 3, 5)

/**
 * Draws the knot in a box of s dp (the canvas): the under pieces, the light
 * on them, the halos in the surface color, the over pieces, the light on
 * them. So the light passes under a strand where the strand does.
 */
internal fun DrawScope.drawKnot(paths: KnotPaths, pose: KnotPose, s: Double, base: Color, light: Color, surface: Color) {
    val k = size.width / KnotGeometry.BOX
    val stroke = Stroke(width = knotWidth(s), cap = StrokeCap.Round, join = StrokeJoin.Round)
    val halo = Stroke(width = knotHalo(s), cap = StrokeCap.Butt, join = StrokeJoin.Round)
    // flat ends on the over pieces' base: the under pieces' round ends fill the joins below it,
    // and a round end would paint a ring of base color over a lit join
    val flat = Stroke(width = knotWidth(s), cap = StrokeCap.Butt, join = StrokeJoin.Round)
    val glow = light.copy(alpha = light.alpha * pose.light.toFloat().coerceIn(0f, 1f))
    withTransform({ scale(k, k, pivot = Offset.Zero) }) {
        for (i in UNDERS) drawPath(paths.pieces[i], base, style = stroke)
        if (glow.alpha > 0f) for (i in UNDERS) with(paths) { light(i, pose, glow, stroke) }
        for (h in paths.halos) drawPath(h, surface, style = halo)
        for (i in OVERS) drawPath(paths.pieces[i], base, style = flat)
        if (glow.alpha > 0f) for (i in OVERS) with(paths) { light(i, pose, glow, stroke) }
    }
}

/** The live states of a reply, a turn or a run (CHAT-AND-MOTION 1.3), as the Knot draws them. */
fun LiveState.knot(): KnotState = when (this) {
    LiveState.THINKING -> KnotState.THINKING
    LiveState.TOOL, LiveState.WRITING -> KnotState.TOOL
    LiveState.WAITING -> KnotState.WAITING
    LiveState.RESUMING -> KnotState.PAUSED
    LiveState.FAILED -> KnotState.FAILED
    LiveState.DONE, LiveState.STOPPED -> KnotState.DONE
}
