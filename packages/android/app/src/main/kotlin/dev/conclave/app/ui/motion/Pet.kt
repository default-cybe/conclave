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
import dev.conclave.app.ui.theme.ConclaveColors
import dev.conclave.client.motion.Loop
import dev.conclave.client.motion.PET_BODY
import dev.conclave.client.motion.PET_CURL
import dev.conclave.client.motion.PET_EYES
import dev.conclave.client.motion.PET_EYE_Y
import dev.conclave.client.motion.PET_FEET
import dev.conclave.client.motion.PET_SHADOW
import dev.conclave.client.motion.PET_SHOULDER
import dev.conclave.client.motion.PetState

/**
 * The pet (CHAT-AND-MOTION 1.11), the Compose side of the web's Pet.tsx: a
 * soft dome with a curl of the Knot's rope on top, two dot eyes, a mouth and
 * one stubby arm for a prop, sitting on its own shadow. The face and posture
 * say the state, the prop says the job. Android keeps the essentials of each
 * state's loop: the breath and a blink when idle or waiting, the violet light
 * round the body while it thinks, and every other state's key pose (a lens, a
 * hammer and blocks, ticks, glasses, a raised amber hand, asleep with z's,
 * ^^ eyes and sparkles, a fault frown and a sweat drop). Off screen it stops;
 * with "Remove animations" (or `still`) it draws the state's key pose. Never
 * in a chat reply; the Knot owns that space.
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
    val live = state == PetState.IDLE || state == PetState.THINKING || state == PetState.WAITING
    LaunchedEffect(state, reduced, onscreen.visible) {
        if (reduced || !onscreen.visible || !live) return@LaunchedEffect
        while (true) withFrameNanos { tick.longValue = it }
    }
    val described = if (label != null) Modifier.semantics { contentDescription = label } else Modifier
    Canvas(modifier.size(size, size * 3 / 4).onscreen(onscreen).then(described)) {
        tick.longValue
        val t = tick.longValue / 1_000_000f
        val k = size.value / 32f
        val ink = c.fg2
        withTransform({ scale(k, k, pivot = Offset.Zero) }) {
            drawPath(parse(PET_SHADOW), ink.copy(alpha = 0.2f), style = line(1f))
            // the breath: the body and its face rise and fall from the seat; asleep it slumps
            val breath = if (!reduced && live) 1f + 0.03f * kotlin.math.sin(t / Loop.BREATH * 2f * Math.PI.toFloat()) else 1f
            val slump = state == PetState.PARKED
            withTransform({ scale(if (slump) 1.02f else 1f, (if (slump) 0.95f else 1f) * breath, pivot = Offset(14f, 20.5f)) }) {
                curl(state, ink, c)
                drawPath(parse(PET_BODY), ink.copy(alpha = 0.08f))
                drawPath(parse(PET_BODY), ink, style = line(1.5f))
                if (state == PetState.THINKING && !reduced) light(c.signal, (t % Loop.KNOT / Loop.KNOT))
                drawPath(parse(PET_FEET), ink, style = line(1.5f))
                eyes(state, ink, c, blink = live && !reduced && (t % Loop.BREATH) < 140f)
                mouth(state, ink, c)
            }
            prop(state, ink, c)
        }
    }
}

private val cache = HashMap<String, Path>()

/** The web's SVG path strings, parsed once each. */
private fun parse(d: String): Path = cache.getOrPut(d) { PathParser.createPathFromPathData(d).asComposePath() }

private fun line(w: Float) = Stroke(width = w, cap = StrokeCap.Round, join = StrokeJoin.Round)

private val Y = PET_EYE_Y
private fun both(f: (Float) -> String) = PET_EYES.joinToString("") { f(it) }

/** The curl on top: lit while it thinks, drooped asleep or failed. */
private fun DrawScope.curl(state: PetState, ink: Color, c: ConclaveColors) {
    val turn = when (state) {
        PetState.PARKED -> 40f
        PetState.FAILED -> -30f
        else -> 0f
    }
    withTransform({ rotate(turn, pivot = Offset(14f, 5f)) }) {
        drawPath(parse(PET_CURL), if (state == PetState.THINKING) c.signal else ink, style = line(1.4f))
    }
}

/** The light round the body while it thinks: one 18% segment, one lap per LOOP_KNOT. */
private fun DrawScope.light(color: Color, head: Float) {
    val m = PathMeasure()
    m.setPath(parse(PET_BODY), false)
    val len = m.length
    if (len <= 0f) return
    val tail = head - 0.18f
    val segment = Path()
    if (tail >= 0f) {
        if (m.getSegment(tail * len, head * len, segment, true)) drawPath(segment, color, style = line(1.5f))
    } else {
        if (m.getSegment(0f, head * len, segment, true)) drawPath(segment, color, style = line(1.5f))
        segment.reset()
        if (m.getSegment((1f + tail) * len, len, segment, true)) drawPath(segment, color, style = line(1.5f))
    }
}

/** Where the eyes look, per state (the web's .p-look). */
private fun look(state: PetState): Offset = when (state) {
    PetState.THINKING -> Offset(0.6f, -0.8f)
    PetState.RESEARCHING -> Offset(0.7f, 0f)
    PetState.BUILDING -> Offset(0.6f, 0.5f)
    PetState.TESTING -> Offset(0.7f, -0.3f)
    PetState.WAITING -> Offset(0.5f, -0.8f)
    PetState.FAILED -> Offset(0f, 0.6f)
    else -> Offset.Zero
}

/** Shut asleep, ^^ when done; otherwise dots with a glint, a line in a blink. */
private fun DrawScope.eyes(state: PetState, ink: Color, c: ConclaveColors, blink: Boolean) {
    when (state) {
        PetState.PARKED -> drawPath(parse(both { x -> "M${x - 1.4f} ${Y}Q$x ${Y + 1.2f} ${x + 1.4f} $Y" }), ink, style = line(1.25f))
        PetState.DONE -> drawPath(parse(both { x -> "M${x - 1.4f} ${Y + 0.7f}L$x ${Y - 0.8f}L${x + 1.4f} ${Y + 0.7f}" }), ink, style = line(1.25f))
        else -> {
            val o = look(state)
            withTransform({ translate(o.x, o.y) }) {
                if (blink) {
                    drawPath(parse(both { x -> "M${x - 1.2f} ${Y}H${x + 1.2f}" }), ink, style = line(1.25f))
                } else {
                    for (x in PET_EYES) {
                        drawCircle(ink, radius = 1.45f, center = Offset(x, Y))
                        drawCircle(c.bg, radius = 0.45f, center = Offset(x + 0.5f, Y - 0.55f))
                    }
                }
            }
        }
    }
}

private val MOUTH = mapOf(
    PetState.IDLE to "M13 15.7Q14 16.6 15 15.7",
    PetState.THINKING to "M13.5 16.1H14.5",
    PetState.RESEARCHING to "M13.2 15.9Q14 16.4 14.8 15.9",
    PetState.BUILDING to "M13.1 16H14.9",
    PetState.TESTING to "M13.2 15.9Q14 16.4 14.8 15.9",
    PetState.REVIEWING to "M13.3 16.1H14.7",
    PetState.PARKED to "M13.6 16.2H14.4",
    PetState.DONE to "M12.3 15.4Q14 17.6 15.7 15.4",
    PetState.FAILED to "M12.7 16.9Q14 15.7 15.3 16.9",
)

private fun DrawScope.mouth(state: PetState, ink: Color, c: ConclaveColors) {
    if (state == PetState.WAITING) {
        drawCircle(ink, radius = 0.75f, center = Offset(14f, 16.2f), style = line(1.25f))
        return
    }
    val d = MOUTH[state] ?: return
    drawPath(parse(d), if (state == PetState.FAILED) c.fault else ink, style = line(1.25f))
}

/** One prop per state, in its key pose, beside the body. */
private fun DrawScope.prop(state: PetState, ink: Color, c: ConclaveColors) {
    val sx = PET_SHOULDER[0]
    val sy = PET_SHOULDER[1]
    when (state) {
        PetState.RESEARCHING -> {
            drawPath(parse("M$sx ${sy}L25.7 12.3"), ink, style = line(1.5f))
            drawCircle(ink, radius = 2.3f, center = Offset(27.5f, 10.4f), style = line(1.1f))
        }
        PetState.BUILDING -> {
            drawPath(parse("M$sx ${sy}L26.2 11.6"), ink, style = line(1.5f))
            drawPath(parse("M25 10.3L27.6 12.9"), ink, style = line(1.1f))
            // two blocks stacked: the third steps in on the web's loop
            drawPath(parse("M27.9 17.8H29.7Q30.1 17.8 30.1 18.2V20Q30.1 20.4 29.7 20.4H27.9Q27.5 20.4 27.5 20V18.2Q27.5 17.8 27.9 17.8ZM27.9 15H29.7Q30.1 15 30.1 15.4V17.2Q30.1 17.6 29.7 17.6H27.9Q27.5 17.6 27.5 17.2V15.4Q27.5 15 27.9 15Z"), ink, style = line(1f))
        }
        PetState.TESTING -> drawPath(parse("M26.6 5.5l1.2 1.2 2.3-2.7M26.6 10l1.2 1.2 2.3-2.7M26.6 14.5l1.2 1.2 2.3-2.7"), c.ok, style = line(1.25f))
        PetState.REVIEWING -> drawPath(parse(both { x -> "M${x + 2.5f} ${Y}A2.5 2.5 0 1 1 ${x - 2.5f} ${Y}A2.5 2.5 0 1 1 ${x + 2.5f} $Y" } + "M13.5 ${Y}Q14 ${Y - 0.6f} 14.5 $Y"), ink, style = line(1.1f))
        PetState.WAITING -> {
            drawPath(parse("M$sx ${sy}C25.2 13.4 26.3 11 26.2 8.2"), c.warn, style = line(1.5f))
            drawCircle(c.warn, radius = 1.1f, center = Offset(26.2f, 7f))
        }
        PetState.PARKED -> drawPath(parse("M25 7.5h1.8l-1.8 1.8h1.8M27.2 4.4h1.8l-1.8 1.8h1.8M29.4 1.3h1.8l-1.8 1.8h1.8"), ink, style = line(1f))
        PetState.DONE -> {
            val spark = "M27.4 3.6Q27.4 5.6 29.4 5.6Q27.4 5.6 27.4 7.6Q27.4 5.6 25.4 5.6Q27.4 5.6 27.4 3.6ZM4.4 3Q4.4 4.4 5.8 4.4Q4.4 4.4 4.4 5.8Q4.4 4.4 3 4.4Q4.4 4.4 4.4 3Z"
            drawPath(parse(spark), c.ok)
            drawPath(parse(spark), c.ok, style = line(0.6f))
        }
        PetState.FAILED -> {
            drawPath(parse("M8.9 ${Y - 2.4f}L12.3 ${Y - 3.3f}M19.1 ${Y - 2.4f}L15.7 ${Y - 3.3f}"), c.fault, style = line(1.1f))
            val drop = "M25.6 6.2C24.9 7.3 24.6 7.9 24.6 8.4A1 1 0 0 0 26.6 8.4C26.6 7.9 26.3 7.3 25.6 6.2Z"
            drawPath(parse(drop), ink.copy(alpha = 0.18f))
            drawPath(parse(drop), ink.copy(alpha = 0.7f), style = line(1f))
        }
        else -> Unit
    }
}
