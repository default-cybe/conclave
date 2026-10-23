package dev.conclave.app.ui.motion

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.motion.Steps as StepTiming

/** One step of the live status line: the verb, sentence case, and quiet detail after it. */
data class Step(val verb: String, val target: String? = null, val id: String = verb + "\u0000" + target.orEmpty())

/** The pass of light over a verb: near white on dark, near black on light. */
private val GlintDark = Color(0xFFFAF6FF)
private val GlintLight = Color(0xFF1C1424)

/**
 * The live status line (type.html Steps): "Searching the web  caddy
 * tailscale", "Reading 3 pages", "Writing". When the step changes, the old
 * one lifts 4dp and fades out by 180ms; then the new one comes up a word at
 * a time (32ms apart), and its verb gets one pass of light 0.6s after it
 * lands. Two steps never share the line. One canvas, transform and opacity
 * only. With animations off the steps swap at once.
 *
 * @param appear play the entrance for the first step too.
 */
@Composable
fun Steps(step: Step, modifier: Modifier = Modifier, appear: Boolean = true) {
    val reduced = reducedMotion()
    val c = Conclave.colors
    val glint = if (c.dark) GlintDark else GlintLight
    val st = remember { StepsState(step, if (appear) motionNow() else -1e9) }
    if (st.current.id != step.id) {
        st.previous = st.current
        st.current = step
        st.changedAt = motionNow()
    } else if (st.current != step) {
        st.current = step
    }
    val measurer = rememberTextMeasurer()
    val verbStyle = remember(c) { ConclaveType.meta.copy(color = c.signal, fontWeight = FontWeight.Medium) }
    val targetStyle = remember(c) { ConclaveType.meta.copy(color = c.fg3) }
    val tick = remember { mutableLongStateOf(0L) }
    val changedAt = st.changedAt
    LaunchedEffect(step.id, reduced) {
        if (reduced) return@LaunchedEffect
        val until = StepTiming.landed(partsOf(st.current)) + StepTiming.GLINT_AFTER + st.current.verb.length * StepTiming.GLINT_STEP + StepTiming.GLINT_MS
        while (motionNow() - changedAt < until) withFrameNanos { tick.longValue = it }
        tick.longValue++
    }
    val spoken = listOfNotNull(step.verb, step.target).joinToString(" ")
    BoxWithConstraints(modifier.clearAndSetSemantics { contentDescription = spoken; liveRegion = LiveRegionMode.Polite }) {
        val max = constraints.maxWidth
        val cur = remember(st.current, max, verbStyle, targetStyle) { layoutStep(measurer, st.current, verbStyle, targetStyle, max) }
        val prev = st.previous?.let { p -> remember(p, max, verbStyle, targetStyle) { layoutStep(measurer, p, verbStyle, targetStyle, max) } }
        val density = LocalDensity.current
        val w = with(density) { maxOf(cur.width, prev?.width ?: 0).toDp() }
        val h = with(density) { cur.height.toDp() }
        val rise = with(density) { Motion.RISE.toPx() }
        Canvas(Modifier.size(w, h)) {
            tick.longValue
            val t = if (reduced) 1e9 else motionNow() - st.changedAt
            if (prev != null && t < StepTiming.OUT_MS + StepTiming.OUT_STEP_MAX) drawStep(prev, t, rise, leaving = true, glint = glint, landedAt = 0.0)
            if (t >= StepTiming.IN_AT || st.previous == null) {
                val tIn = if (st.previous == null && t < StepTiming.IN_AT) t + StepTiming.IN_AT else t
                drawStep(cur, if (reduced) 1e9 else tIn, rise, leaving = false, glint = glint, landedAt = StepTiming.landed(cur.parts.size).toDouble())
            }
        }
    }
}

private class StepsState(var current: Step, var changedAt: Double) {
    var previous: Step? = null
}

private fun partsOf(step: Step): Int = step.verb.split(' ').size + (step.target?.split(' ')?.size ?: 0)

/** A step laid out once: its verb and target, and where each word sits. */
private class StepLayout(
    val verb: TextLayoutResult,
    val target: TextLayoutResult?,
    val targetX: Float,
    /** Words as (layout 0 verb / 1 target, left, right) in px. */
    val parts: List<Triple<Int, Float, Float>>,
    val width: Int,
    val height: Int,
)

private fun layoutStep(m: TextMeasurer, s: Step, verbStyle: TextStyle, targetStyle: TextStyle, maxWidth: Int): StepLayout {
    val verb = m.measure(s.verb, verbStyle, maxLines = 1, softWrap = false)
    val gap = verb.size.height * 0.5f
    val room = (maxWidth - verb.size.width - gap).toInt()
    val target = if (!s.target.isNullOrBlank() && room > 24) {
        m.measure(s.target, targetStyle, overflow = TextOverflow.Ellipsis, maxLines = 1, softWrap = false, constraints = Constraints(maxWidth = room))
    } else {
        null
    }
    val parts = ArrayList<Triple<Int, Float, Float>>()
    fun words(layout: TextLayoutResult, text: String, which: Int, dx: Float) {
        var i = 0
        val shown = layout.getLineEnd(0, visibleEnd = true).coerceAtMost(text.length)
        while (i < shown) {
            while (i < shown && text[i] == ' ') i++
            if (i >= shown) break
            var j = i
            while (j < shown && text[j] != ' ') j++
            val left = layout.getBoundingBox(i).left
            // the last visible word owns the ellipsis after it
            val right = if (j >= shown) layout.size.width.toFloat() else layout.getBoundingBox(j - 1).right
            parts.add(Triple(which, dx + left, dx + right))
            i = j
        }
    }
    words(verb, s.verb, 0, 0f)
    val tx = verb.size.width + gap
    if (target != null) words(target, s.target!!, 1, tx)
    val width = if (target != null) (tx + target.size.width).toInt() else verb.size.width
    return StepLayout(verb, target, tx, parts, width.coerceAtMost(maxWidth), verb.size.height)
}

private fun DrawScope.drawStep(l: StepLayout, t: Double, rise: Float, leaving: Boolean, glint: Color, landedAt: Double) {
    l.parts.forEachIndexed { i, (which, left, right) ->
        val k = if (leaving) StepTiming.partOut(t, i).toFloat() else StepTiming.partIn(t, i).toFloat()
        val alpha = if (leaving) 1f - k else k
        if (alpha <= 0.002f) return@forEachIndexed
        val dy = if (leaving) -rise * k else rise * (1f - k)
        val layout = if (which == 0) l.verb else l.target ?: return@forEachIndexed
        val dx = if (which == 0) 0f else l.targetX
        // a word owns the space up to the next one, so no glyph is cut
        val pad = layout.size.height * 0.25f
        clipRect(left = left - pad, top = -size.height, right = right + pad, bottom = size.height * 2) {
            translate(dx, dy) { drawText(layout, alpha = alpha) }
        }
    }
    if (leaving) return
    // one pass of light across the verb, a letter at a time, after the step has landed
    val g = t - landedAt - StepTiming.GLINT_AFTER
    if (g <= 0) return
    val verb = l.verb
    val n = verb.layoutInput.text.length
    for (i in 0 until n) {
        val a = StepTiming.glint(g, i).toFloat()
        if (a <= 0.002f) continue
        val b = verb.getBoundingBox(i)
        clipRect(left = b.left, top = 0f, right = b.right, bottom = size.height) {
            drawText(verb, color = glint, alpha = a, topLeft = Offset.Zero)
        }
    }
}
