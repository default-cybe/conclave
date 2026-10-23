package dev.conclave.app.ui.motion

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import dev.conclave.client.motion.ToastStack as Stack

/** How a toast left: timed out or by its action. A dismissed one slides right. */
internal enum class Leave { NONE, OUT, GONE }

@Stable
class ToastItem internal constructor(
    val id: Long,
    val text: String,
    val action: String?,
    val sticky: Boolean,
    internal val result: CompletableDeferred<SnackbarResult>,
) {
    internal var leave by mutableStateOf(Leave.NONE)
    internal var left: Long = if (sticky) Long.MAX_VALUE else Stack.TTL
}

/**
 * The toasts of one screen, as one stack (ui.html toast-stack). Saved,
 * copied, undo and errors all land here. Raise one with [post], or wait for
 * its action with [showSnackbar] (the same call as Material's snackbar).
 */
@Stable
class ToastState {
    internal val items = mutableStateListOf<ToastItem>()
    private var next = 1L

    /** Shows [message] and returns at once. */
    fun post(message: String, actionLabel: String? = null, sticky: Boolean = false) {
        add(message, actionLabel, sticky)
    }

    /** Shows [message] and waits until it leaves: ActionPerformed when its action was tapped. */
    suspend fun showSnackbar(
        message: String,
        actionLabel: String? = null,
        withDismissAction: Boolean = false,
        duration: SnackbarDuration = SnackbarDuration.Short,
    ): SnackbarResult = add(message, actionLabel, duration == SnackbarDuration.Indefinite).result.await()

    private fun add(message: String, action: String?, sticky: Boolean): ToastItem {
        val t = ToastItem(next++, message, action, sticky, CompletableDeferred())
        items.add(t)
        // at most three: the oldest beyond that goes as a new one arrives
        val live = items.filter { it.leave == Leave.NONE }
        if (live.size > Stack.MAX) dismiss(live.first(), SnackbarResult.Dismissed, slide = false)
        return t
    }

    internal fun dismiss(t: ToastItem, result: SnackbarResult, slide: Boolean) {
        if (t.leave != Leave.NONE) return
        t.leave = if (slide) Leave.GONE else Leave.OUT
        t.result.complete(result)
    }

    internal fun remove(t: ToastItem) {
        items.remove(t)
    }
}

@Composable
fun rememberToasts(): ToastState = remember { ToastState() }

/**
 * The stack, bottom center above the content. The newest toast is in
 * front; older ones sit 11dp higher and 5% smaller with their words hidden.
 * A tap on the stack fans it out so every toast reads; another restacks it.
 * Places move on the critically damped spring. A toast rises 18dp and fades
 * in; it leaves with a 6dp drop and a fade, or slides 22dp right when you
 * dismiss it. Auto dismiss after 5s unless sticky; the timers wait while the
 * stack is fanned. With "Remove animations" toasts appear and go in place.
 */
@Composable
fun ToastHost(state: ToastState, modifier: Modifier = Modifier) {
    val all = state.items
    if (all.isEmpty()) return
    val reduced = reducedMotion()
    var fan by remember { mutableStateOf(false) }
    val heights = remember { mutableStateMapOf<Long, Int>() }
    val density = LocalDensity.current
    // front first
    val order = all.asReversed().take(Stack.MAX + 1)
    val leaving = order.map { it.leave != Leave.NONE }
    val hs = order.map { t -> heights[t.id]?.let { with(density) { it.toDp().value.toInt() } } ?: 44 }
    val live = leaving.count { !it }
    if (live <= 1 && fan) fan = false
    val slots = Stack.layout(hs, leaving, fan)
    val height = Stack.height(hs, leaving, fan)
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .height(height.dp)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, enabled = live > 1, onClickLabel = if (fan) "Stack the notices" else "Show every notice") { fan = !fan },
        contentAlignment = Alignment.BottomCenter,
    ) {
        order.forEachIndexed { i, t ->
            androidx.compose.runtime.key(t.id) {
                ToastView(
                    t = t,
                    slot = slots[i],
                    fanned = fan,
                    reduced = reduced,
                    onSize = { h -> heights[t.id] = h },
                    onDone = {
                        heights.remove(t.id)
                        state.remove(t)
                    },
                    onDismiss = { state.dismiss(t, SnackbarResult.Dismissed, slide = true) },
                    onAction = { state.dismiss(t, SnackbarResult.ActionPerformed, slide = false) },
                    onTimeout = { state.dismiss(t, SnackbarResult.Dismissed, slide = false) },
                )
            }
        }
    }
}

@Composable
private fun ToastView(
    t: ToastItem,
    slot: Stack.Slot,
    fanned: Boolean,
    reduced: Boolean,
    onSize: (Int) -> Unit,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
    onAction: () -> Unit,
    onTimeout: () -> Unit,
) {
    val c = Conclave.colors
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val y by animateFloatAsState(slot.offset.toFloat(), if (reduced) tween(0) else Motion.spring(), label = "toast-y")
    val scale by animateFloatAsState(slot.scale.toFloat(), if (reduced) tween(0) else Motion.spring(), label = "toast-scale")
    // words behind the front go at once, so they never show through the toast arriving in front
    val words by animateFloatAsState(if (slot.words) 1f else 0f, tween(if (reduced || !slot.words) 0 else Motion.DUR_2, easing = Motion.Ease), label = "toast-words")
    val enter = remember { Animatable(if (reduced) 1f else 0f) }
    val fade = remember { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(Unit) {
        launch { enter.animateTo(1f, Motion.spring()) }
        fade.animateTo(1f, tween(Motion.DUR_2, easing = Motion.Ease))
    }
    val out = remember { Animatable(0f) }
    LaunchedEffect(t.leave) {
        if (t.leave == Leave.NONE) return@LaunchedEffect
        if (!reduced) out.animateTo(1f, tween(if (t.leave == Leave.GONE) Stack.GONE_MS else Stack.OUT_MS, easing = Motion.EaseIn))
        onDone()
    }
    // the timer waits while the stack is fanned out to be read
    LaunchedEffect(fanned, t.leave) {
        if (fanned || t.leave != Leave.NONE || t.left == Long.MAX_VALUE) return@LaunchedEffect
        val started = System.currentTimeMillis()
        try {
            delay(t.left)
            onTimeout()
        } finally {
            t.left = (t.left - (System.currentTimeMillis() - started)).coerceAtLeast(0)
        }
    }
    val failed = t.text.startsWith("Failed")
    val shape = RoundedCornerShape(7.dp)
    Surface(
        color = c.bgRaise,
        shape = shape,
        modifier = Modifier
            .fillMaxWidth()
            .zIndex(10f - slot.idx)
            .onSizeChanged { onSize(it.height) }
            .graphicsLayer {
                val px = density.density
                val rise = Stack.RISE * px * (1f - enter.value)
                val drop = Stack.DROP * px * out.value
                val slide = if (t.leave == Leave.GONE) Stack.SLIDE * px * out.value else 0f
                translationY = -y * px + rise + if (t.leave == Leave.OUT) drop else 0f
                translationX = slide
                scaleX = scale
                scaleY = scale
                transformOrigin = TransformOrigin(0.5f, 1f)
                alpha = fade.value * (1f - out.value)
            }
            .shadow(6.dp, shape, clip = false, ambientColor = c.scrim, spotColor = c.scrim)
            .border(1.dp, c.rule2, shape)
            .semantics { liveRegion = if (failed) LiveRegionMode.Assertive else LiveRegionMode.Polite },
    ) {
        Row(
            Modifier.heightIn(min = 44.dp).padding(start = 14.dp, end = 4.dp).graphicsLayer { alpha = words },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val text = buildAnnotatedString {
                append(t.text)
                // a failure starts with the word in the fault color
                if (failed) addStyle(SpanStyle(color = c.fault), 0, "Failed".length)
            }
            Text(text, style = ConclaveType.body.copy(fontSize = ConclaveType.meta.fontSize * 1.08f), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(vertical = 10.dp))
            if (t.action != null) {
                TextButton(onClick = onAction, enabled = slot.words && t.leave == Leave.NONE, shape = RoundedCornerShape(5.dp)) {
                    Text(t.action, style = ConclaveType.button, color = c.fg)
                }
            }
            Box(
                Modifier.size(40.dp).clickable(enabled = slot.words && t.leave == Leave.NONE, onClickLabel = "Dismiss") { scope.launch { onDismiss() } },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.Close, contentDescription = "Dismiss", modifier = Modifier.size(16.dp), tint = c.fg3)
            }
        }
    }
}
