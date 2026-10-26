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
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.graphics.PathParser
import androidx.compose.ui.graphics.asComposePath
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.client.motion.Loop
import dev.conclave.client.motion.PET_BODY
import dev.conclave.client.motion.PET_EYES
import dev.conclave.client.motion.PET_LEGS
import dev.conclave.client.motion.PetState

/**
 * The pet (CHAT-AND-MOTION 1.11), the Compose side of the web's Pet.tsx: a
 * squat trefoil bean drawn from the Knot's loop, four legs with knees, two
 * eyes, and one prop per state. Android keeps the essentials of each state's
 * loop: the breath and a blink when idle, the violet light round the body
 * while it thinks, and every other state's key pose with its prop (a lens,
 * blocks, ticks, rings, a raised hand, z's, arc or flat eyes). Off screen it
 * stops; with "Remove animations" (or `still`) it draws the state's key
 * pose. Never in a chat reply; the Knot owns that space.
 *
 * @param size width in dp, 24 to 64 (the height is 3/4 of it).
 * @param label accessible name; without it the pet is decorative, so say the state in words next to it.
 */
@Composable
fun Pet(
    state: PetState = PetState.IDLE,
    modifier: Modifier = Modifier,
    size: Dp = 24.dp,
    still: Boolean = false,
    label: String? = null,
) {
    val c = Conclave.colors
    val reduced = reducedMotion() || still
    val onscreen = rememberOnscreen()
    // the frame time, read only while drawing, so a frame never recomposes
    val tick = remember { mutableLongStateOf(0L) }
    val live = state == PetState.IDLE || state == PetState.THINKING
    LaunchedEffect(state, reduced, onscreen.visible) {
        if (reduced || !onscreen.visible || !live) return@LaunchedEffect
        while (true) withFrameNanos { tick.longValue = it }
    }
    val described = if (label != null) Modifier.semantics { contentDescription = label } else Modifier
    Canvas(modifier.size(size, size * 3 / 4).onscreen(onscreen).then(described)) {
        tick.longValue
        val t = tick.longValue / 1_000_000f
        val k = size.value / 32f
        val stroke = Stroke(width = 1.2f, cap = StrokeCap.Round, join = StrokeJoin.Round)
        withTransform({ scale(k, k, pivot = Offset.Zero) }) {
            // the breath: the body and its eyes rise and fall a little (skipped for the two settled states)
            val breath = if (!reduced && state != PetState.DONE && state != PetState.FAILED) 1f + 0.02f * kotlin.math.sin(t / Loop.BREATH * 2f * Math.PI.toFloat()) else 1f
            drawPath(parse(PET_LEGS), c.fg3, style = stroke)
            withTransform({ scale(1f, breath, pivot = Offset(16f, 17f)) }) {
                drawPath(body(), c.fg3, style = stroke)
                if (state == PetState.THINKING && !reduced) light(stroke, c.signal, (t % Loop.KNOT_TOOL / Loop.KNOT_TOOL))
            }
            eyes(state, c, stroke, t, breath)
            prop(state, c, stroke)
        }
    }
}

private val bodyPath: Path by lazy {
    Path().apply {
        moveTo(PET_BODY[0], PET_BODY[1])
        var i = 2
        while (i < PET_BODY.size) {
            lineTo(PET_BODY[i], PET_BODY[i + 1])
            i += 2
        }
        close()
    }
}

private fun body(): Path = bodyPath

private val cache = HashMap<String, Path>()

/** The web's SVG path strings (the legs and the props), parsed once each. */
private fun parse(d: String): Path = cache.getOrPut(d) { PathParser.createPathFromPathData(d).asComposePath() }

/** The light round the body while it thinks: one 22% segment, one lap per LOOP_KNOT_TOOL. */
private fun DrawScope.light(stroke: Stroke, color: Color, head: Float) {
    val m = PathMeasure()
    m.setPath(bodyPath, false)
    val len = m.length
    if (len <= 0f) return
    val tail = (head - 0.22f) % 1f
    val segment = Path()
    if (tail >= 0f) {
        if (m.getSegment(tail * len, head * len, segment, true)) drawPath(segment, color, style = stroke)
    } else {
        if (m.getSegment(0f, head * len, segment, true)) drawPath(segment, color, style = stroke)
        segment.reset()
        if (m.getSegment((1f + tail) * len, len, segment, true)) drawPath(segment, color, style = stroke)
    }
}

/** The eyes on the body: open with a blink, shut when parked, arcs when done, flat in the fault color when failed. */
private fun DrawScope.eyes(state: PetState, c: dev.conclave.app.ui.theme.ConclaveColors, stroke: Stroke, t: Float, breath: Float) {
    val open = Path()
    for (x in PET_EYES) {
        open.moveTo(x, 4.7f)
        open.lineTo(x, 6.3f)
    }
    when (state) {
        PetState.PARKED -> drawPath(parse(PET_EYES.joinToString("") { x -> "M${x - 0.9f} 5.8H${x + 0.9f}" }), c.fg3, style = stroke)
        PetState.DONE -> drawPath(parse(PET_EYES.joinToString("") { x -> "M${x - 1f} 6Q$x 4.2 ${x + 1f} 6" }), c.fg3, style = stroke)
        PetState.FAILED -> drawPath(parse(PET_EYES.joinToString("") { x -> "M${x - 0.9f} 5.5H${x + 0.9f}" }), c.fault, style = stroke)
        else -> {
            // a blink about once a breath; thinking looks up a little
            val blink = state == PetState.IDLE && (t % Loop.BREATH) < 160f
            val y = if (state == PetState.THINKING) -0.6f else 0f
            withTransform({ scale(1f, breath, pivot = Offset(16f, 17f)); translate(0f, y) }) {
                drawPath(if (blink) parse(PET_EYES.joinToString("") { x -> "M${x - 0.7f} 5.5H${x + 0.7f}" }) else open, c.fg, style = stroke)
            }
        }
    }
}

/** One prop per state, still, beside the body. */
private fun DrawScope.prop(state: PetState, c: dev.conclave.app.ui.theme.ConclaveColors, stroke: Stroke) {
    when (state) {
        PetState.RESEARCHING -> drawPath(parse("M27 3A2 2 0 1 0 27.01 3ZM30.5 6.5L32 8"), c.fg2, style = stroke)
        PetState.BUILDING -> {
            drawPath(parse("M26 11L30 7.5"), c.fg2, style = stroke)
            drawPath(parse("M28.5 12.5h3v3h-3ZM28.5 16h3v3h-3ZM28.5 19.5h3v3h-3Z"), c.fg2, style = stroke)
        }
        PetState.TESTING -> drawPath(parse("M28.3 4l1.2 1.2 2.3-2.7M28.3 9.5l1.2 1.2 2.3-2.7M28.3 15l1.2 1.2 2.3-2.7"), c.ok, style = stroke)
        PetState.REVIEWING -> drawPath(parse(PET_EYES.joinToString("") { x -> "M${x + 1.7f} 5.5A1.7 1.7 0 1 1 ${x - 1.7f} 5.5A1.7 1.7 0 1 1 ${x + 1.7f} 5.5" }), c.fg2, style = stroke)
        PetState.WAITING -> drawPath(parse("M26 11L28.8 6L28.5 3"), c.warn, style = stroke)
        PetState.PARKED -> drawPath(parse("M27 9h1.8l-1.8 1.8h1.8M28.7 5.6h1.8l-1.8 1.8h1.8M30.4 2.2h1.8l-1.8 1.8h1.8"), c.fg2, style = stroke)
        else -> Unit
    }
}
