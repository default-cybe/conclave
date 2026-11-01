package dev.conclave.app.ui.motion

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import java.text.BreakIterator

/**
 * A live label ("Thinking", "Searching the web"). While the work runs, a dip
 * in brightness passes through the letters left to right, 45ms apart, then
 * rests until the next 2.2s pass: opacity per letter on a canvas, no gradient,
 * no layout per frame. Use it only for a live verb, never for a waiting or
 * finished state. With [active] false or animations off it is plain text.
 */
@Composable
fun ShimmerText(
    text: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    active: Boolean = true,
) {
    val reduced = reducedMotion()
    if (!active || reduced || text.isEmpty()) {
        Text(text, modifier, style = style, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
        return
    }
    val measurer = rememberTextMeasurer()
    val layout = remember(text, style, color) { measurer.measure(text, style.copy(color = color), maxLines = 1) }
    // where each letter starts and ends: every letter owns the space up to the next one
    val cuts = remember(layout) {
        val starts = graphemeStarts(text)
        val lefts = starts.map { layout.getBoundingBox(it).left }
        FloatArray(lefts.size + 1) { i -> if (i == 0) 0f else if (i == lefts.size) layout.size.width.toFloat() else lefts[i] }
    }
    val clock = remember { mutableLongStateOf(0L) }
    // the pass pauses offscreen; the frame clock itself stops while the app is in the background
    val onscreen = rememberOnscreen()
    LaunchedEffect(onscreen.visible) {
        if (!onscreen.visible) return@LaunchedEffect
        // picks up where it paused, so a label scrolled back in never restarts its pass
        var start = -1L
        val from = clock.longValue
        while (true) {
            withFrameNanos { frame ->
                if (start < 0) start = frame
                clock.longValue = from + (frame - start) / 1_000_000L
            }
        }
    }
    val density = LocalDensity.current
    val w = with(density) { layout.size.width.toDp() }
    val h = with(density) { layout.size.height.toDp() }
    Canvas(modifier.size(w, h).onscreen(onscreen).semantics { contentDescription = text }) {
        val t = clock.longValue
        for (i in 0 until cuts.size - 1) {
            val local = ((t - i * 45L) % Motion.LOOP_SHIMMER + Motion.LOOP_SHIMMER) % Motion.LOOP_SHIMMER / Motion.LOOP_SHIMMER.toFloat()
            val a = when {
                t < i * 45L -> 1f
                local < 0.09f -> 1f - 0.55f * local / 0.09f
                local < 0.26f -> 0.45f + 0.55f * (local - 0.09f) / 0.17f
                else -> 1f
            }
            clipRect(left = cuts[i], top = 0f, right = cuts[i + 1], bottom = size.height) {
                drawText(layout, alpha = a)
            }
        }
    }
}

private fun graphemeStarts(text: String): List<Int> {
    val it = BreakIterator.getCharacterInstance()
    it.setText(text)
    val out = ArrayList<Int>()
    var at = it.first()
    while (at != BreakIterator.DONE && at < text.length) {
        out.add(at)
        at = it.next()
    }
    return out
}
