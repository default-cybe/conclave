package dev.conclave.app.ui.motion

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import dev.conclave.client.motion.Roll
import dev.conclave.client.motion.RollCell

/** Which way the digits roll. AUTO: up when the value rises, down when it falls. */
enum class RollDirection { AUTO, UP, DOWN }

/**
 * One number component for tokens, cost, countdowns and counts (type.html
 * Roll). Only the characters that change roll, each in its own clipped
 * cell: lower digits first, each higher one 28ms later, up when the value
 * rises and down when it falls. Tabular figures, so nothing shifts. Screen
 * readers get the plain value. With animations off the value changes in
 * place.
 *
 * @param duration roll time per digit: 240 for counts, 380 for a clock.
 */
@Composable
fun RollText(
    text: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    direction: RollDirection = RollDirection.AUTO,
    duration: Int = Roll.COUNT_MS,
) {
    val reduced = reducedMotion()
    val tab = remember(style) { style.copy(fontFeatureSettings = "tnum") }
    // the change in progress: the cells and their direction, once per new text
    val last = remember { RollChange(text, Roll.cells(text, text), true, 0) }
    if (last.text != text) {
        val up = when (direction) {
            RollDirection.UP -> true
            RollDirection.DOWN -> false
            RollDirection.AUTO -> Roll.up(last.text, text)
        }
        last.cells = Roll.cells(last.text, text)
        last.up = up
        last.text = text
        last.version++
    }
    val v = last.version
    val clock = remember(v) { Animatable(if (v == 0 || reduced) 1f else 0f) }
    val total = Roll.total(last.cells, duration)
    LaunchedEffect(v, reduced) {
        if (reduced || v == 0) clock.snapTo(1f) else clock.animateTo(1f, tween(total, easing = LinearEasing))
    }
    val dir = if (last.up) 1f else -1f
    Row(modifier.clearAndSetSemantics { contentDescription = text }) {
        last.cells.forEachIndexed { i, cell ->
            // a cell keyed by its place from the right, so the same digit keeps its node
            androidx.compose.runtime.key(last.cells.size - i) {
                if (cell.prev == null || reduced) {
                    Text(cell.cur.toString(), style = tab, color = color, maxLines = 1)
                } else {
                    RollingCell(cell, tab, color, dir, duration, total) { clock.value }
                }
            }
        }
    }
}

private class RollChange(var text: String, var cells: List<RollCell>, var up: Boolean, var version: Int)

@Composable
private fun RollingCell(cell: RollCell, style: TextStyle, color: Color, dir: Float, duration: Int, total: Int, clock: () -> Float) {
    Box(Modifier.clipToBounds()) {
        // the new digit sets the cell's width; the old one sits over it, centered
        Text(
            cell.cur.toString(),
            style = style,
            color = color,
            maxLines = 1,
            modifier = Modifier.graphicsLayer {
                val k = Roll.progress(clock() * total.toDouble(), cell.rank, duration).toFloat()
                alpha = k
                translationY = dir * (1f - k) * size.height * Roll.TRAVEL.toFloat()
            },
        )
        val old = cell.prev
        if (!old.isNullOrEmpty()) {
            Text(
                old,
                style = style.copy(textAlign = TextAlign.Center),
                color = color,
                maxLines = 1,
                modifier = Modifier.matchParentSize().graphicsLayer {
                    val k = Roll.progress(clock() * total.toDouble(), cell.rank, duration).toFloat()
                    alpha = 1f - k
                    translationY = -dir * k * size.height * Roll.TRAVEL.toFloat()
                },
            )
        }
    }
}
