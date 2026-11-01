package dev.conclave.app.ui.motion

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.motion.Ease
import dev.conclave.client.motion.Morph
import dev.conclave.client.motion.seg
import dev.conclave.client.motion.Fold as FoldTiming

/**
 * The "Thought for 6s" row (type.html Fold). While the model thinks the row
 * reads "Thinking" in violet over the streaming reasoning. In the same frame
 * the answer starts ([live] turns false) "Thinking" turns into "Thought for
 * 6s" (the shared "Th" stays, the rest trades letters) and the reasoning
 * folds closed: it fades and lifts while its box closes from the bottom. A
 * tap opens it again: the box opens, the rule draws down and the text comes
 * in. The text is clipped, never squashed. With animations off the words
 * swap and the reasoning shows or hides at once.
 *
 * On Android the box's height is eased in the layout pass (no
 * recomposition per frame): the transcript is a bottom anchored list, so
 * what sits above the reply has to move with it, and streaming text already
 * lays the reply out on every token.
 *
 * @param open controlled open state; leave it null and the fold opens while live and closes when live ends.
 */
@Composable
fun Fold(
    live: Boolean,
    label: String,
    modifier: Modifier = Modifier,
    liveLabel: String = "Thinking",
    open: Boolean? = null,
    onOpenChange: ((Boolean) -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val c = Conclave.colors
    val reduced = reducedMotion()
    // uncontrolled: open while live, closed when live ends; a tap opens or closes it in between
    var inner by remember(live) { mutableStateOf(live) }
    val shown = open ?: inner
    // 1 open, 0 closed; the box, the rule and the text follow it
    val k = remember { Animatable(if (shown) 1f else 0f) }
    var opening by remember { mutableStateOf(shown) }
    LaunchedEffect(shown, reduced) {
        opening = shown
        if (reduced) {
            k.snapTo(if (shown) 1f else 0f)
        } else if (shown) {
            k.animateTo(1f, tween(FoldTiming.OPEN_MS, easing = Motion.EaseStd))
        } else {
            k.animateTo(0f, tween(FoldTiming.CLOSE_MS, delayMillis = FoldTiming.CLOSE_DELAY, easing = Motion.Ease))
        }
    }
    val chevron by animateFloatAsState(if (shown) 90f else 0f, tween(if (reduced) 0 else Motion.DUR_2, easing = Motion.Ease), label = "fold-chevron")
    val rise = with(LocalDensity.current) { Motion.RISE.toPx() }
    Column(modifier.fillMaxWidth()) {
        val text = if (live) liveLabel else label
        Row(
            Modifier
                .heightIn(min = 32.dp)
                .clip(RoundedCornerShape(3.dp))
                .clickable {
                    val next = !shown
                    if (open == null) inner = next
                    onOpenChange?.invoke(next)
                }
                .semantics { stateDescription = if (shown) "Open" else "Closed" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            var slide by remember { mutableStateOf(0f) }
            MorphLabel(text, live, ConclaveType.meta, onWidthChange = { dw -> slide = dw })
            Spacer(Modifier.width(4.dp))
            val back = remember(text) { Animatable(1f) }
            LaunchedEffect(text) { if (!reduced) back.animateTo(0f, tween(260, easing = Motion.Ease)) else back.snapTo(0f) }
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                modifier = Modifier.size(14.dp).graphicsLayer {
                    rotationZ = chevron
                    // what follows the label slides to its new place
                    translationX = -slide * back.value
                },
                tint = c.fg4,
            )
        }
        val mounted by remember { derivedStateOf { k.value > 0f } }
        if (mounted || shown) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .clipToBounds()
                    .layout { measurable, constraints ->
                        val p = measurable.measure(constraints)
                        val h = (p.height * k.value).toInt()
                        layout(p.width, h) { p.place(0, 0) }
                    },
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp, bottom = 6.dp)
                        .drawBehind {
                            // the rule draws down from the top as it opens, and up as it closes
                            val r = if (opening) Ease.out(seg(k.value.toDouble(), 0.08, 0.9)).toFloat() else Ease.inn(seg(k.value.toDouble(), 0.2, 1.0)).toFloat()
                            drawLine(c.rule2, Offset(0.5f, 0f), Offset(0.5f, size.height * r), strokeWidth = 1.dp.toPx())
                        }
                        .padding(start = 12.dp)
                        .graphicsLayer {
                            val v = k.value
                            if (opening) {
                                val a = Ease.out(seg(v.toDouble(), 0.19, 0.86)).toFloat()
                                alpha = a
                                translationY = rise * (1f - a)
                            } else {
                                // fades out early in the close, lifting 3dp
                                val a = Ease.inn(seg(1.0 - v, 0.0, 0.47)).toFloat()
                                alpha = 1f - a
                                translationY = -rise * 0.75f * a
                            }
                        },
                ) { content() }
            }
        }
    }
}

/**
 * A label that turns into another and keeps what they share at the start:
 * "Thinking" to "Thought for 6s" keeps "Th". The old letters leave right to
 * left (110ms each, 12ms apart), then the new ones arrive left to right
 * (220ms each, 16ms apart). The shared start crossfades from violet (live)
 * to fg-3. [onWidthChange] gets how far the label's end moved (px), for what
 * follows to slide.
 */
@Composable
fun MorphLabel(text: String, live: Boolean, style: TextStyle, modifier: Modifier = Modifier, onWidthChange: (Float) -> Unit = {}) {
    val c = Conclave.colors
    val reduced = reducedMotion()
    val measurer = rememberTextMeasurer()
    val st = remember { MorphState(text) }
    if (st.text != text) {
        st.morph = Morph.of(st.text, text)
        st.oldText = st.text
        st.text = text
        st.at = motionNow()
    }
    val tone by animateFloatAsState(if (live) 1f else 0f, tween(if (reduced) 0 else Motion.DUR_3, easing = Motion.Ease), label = "morph-tone")
    val color = androidx.compose.ui.graphics.lerp(c.fg3, c.signal, tone)
    val newLayout = remember(text, style) { measurer.measure(text, style, maxLines = 1, softWrap = false) }
    val oldLayout = remember(st.oldText, style) { st.oldText?.let { measurer.measure(it, style, maxLines = 1, softWrap = false) } }
    val tick = remember { mutableLongStateOf(0L) }
    val m = st.morph
    // what follows starts where the old label ended, in the same frame
    val dw = oldLayout?.let { (newLayout.size.width - it.size.width).toFloat() } ?: 0f
    SideEffect { onWidthChange(dw) }
    LaunchedEffect(text, reduced) {
        if (reduced || m == null) return@LaunchedEffect
        val until = Morph.inAt(m.old) + m.fresh.length * Morph.IN_STEP + Morph.IN_MS
        while (motionNow() - st.at < until) withFrameNanos { tick.longValue = it }
        tick.longValue++
    }
    val density = LocalDensity.current
    val w = with(density) { newLayout.size.width.toDp() }
    val h = with(density) { newLayout.size.height.toDp() }
    val rise = with(density) { Motion.RISE.toPx() }
    Canvas(modifier.size(w, h).clearAndSetSemantics { contentDescription = text }) {
        tick.longValue
        val t = if (reduced || m == null) 1e9 else motionNow() - st.at
        val n = m?.shared?.length ?: text.length
        // the shared start
        if (n > 0) {
            val r = newLayout.getBoundingBox(n - 1).right
            clipRect(right = r) { drawText(newLayout, color = color) }
        }
        if (m == null) return@Canvas
        val old = oldLayout
        if (old != null && m.old.isNotEmpty()) {
            for (i in m.old.indices) {
                // right to left
                val order = m.old.length - 1 - i
                val at = order * Morph.OUT_STEP.toDouble()
                val k = Ease.inn(seg(t, at, at + Morph.OUT_MS)).toFloat()
                if (k >= 1f) continue
                val b = old.getBoundingBox(n + i)
                clipRect(left = b.left, right = b.right + 1f, top = -size.height, bottom = size.height * 2) {
                    translate(0f, -rise * k) { drawText(old, color = color, alpha = 1f - k) }
                }
            }
        }
        val start = Morph.inAt(m.old).toDouble()
        for (i in m.fresh.indices) {
            val at = start + i * Morph.IN_STEP
            val k = Ease.out(seg(t, at, at + Morph.IN_MS)).toFloat()
            if (k <= 0f) continue
            val b = newLayout.getBoundingBox(n + i)
            clipRect(left = b.left, right = b.right + 1f, top = -size.height, bottom = size.height * 2) {
                translate(0f, rise * 0.75f * (1f - k)) { drawText(newLayout, color = color, alpha = k) }
            }
        }
    }
}

private class MorphState(var text: String) {
    var morph: Morph? = null
    var oldText: String? = null
    var at = 0.0
}
