package dev.conclave.app.ui.motion

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.round
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import dev.conclave.client.motion.Gap as GapTiming

/**
 * One row of a gap list: the item, its key, whether it is on its way out,
 * and (outside a lazy list) whether it has given up its place while it
 * finishes leaving.
 */
class GapEntry<T>(val item: T, val key: String, val leaving: Boolean, val collapsed: Boolean = false)

/**
 * Approve and close the gap (ui.html approve-gap). Rows that leave [items]
 * stay a moment: first the confirmed look holds (call [GapHold.confirm] when
 * the owner decides), then the row slides 34dp right and fades in 170ms;
 * 90ms in, the rows below ride up on the critically damped spring. Nothing
 * jumps. With "Remove animations" rows go at once.
 *
 * In a LazyColumn ([lazy], the default) the row leaves the list at 90ms and
 * the list finishes its fade while the others move (give each row
 * [gapItem]). In a plain Column the row stays until its slide ends, but
 * from 90ms it takes no room ([GapEntry.collapsed], which [gapRow] applies),
 * so the rows below (each with [gapPlacement]) ride up under it.
 */
@Composable
fun <T> rememberGapList(items: List<T>, keyOf: (T) -> String, hold: GapHold? = null, lazy: Boolean = true): List<GapEntry<T>> {
    val reduced = reducedMotion()
    val scope = rememberCoroutineScope()
    val st = remember { GapListState<T>() }
    // read so the list recomposes as a row moves through its steps
    @Suppress("UNUSED_VARIABLE") val v = st.version.intValue
    val keys = items.map(keyOf)
    // Rows that just left become ghosts in this very composition, so a row never drops out
    // for a frame before it holds, slides and closes the gap.
    if (keys != st.lastKeys) {
        val live = keys.toHashSet()
        if (!reduced) {
            st.last.forEachIndexed { i, (key, item) ->
                if (key !in live && key !in st.ghosts) st.ghosts[key] = Ghost(item, st.last.getOrNull(i - 1)?.first)
            }
        }
        // a row that came back (a failed decision) is live again
        st.ghosts.keys.removeAll { it in live }
        st.last = keys.zip(items)
        st.lastKeys = keys
    }
    // each new ghost's clock starts once this composition is applied
    SideEffect {
        for ((key, g) in st.ghosts) {
            if (g.started) continue
            g.started = true
            scope.launch {
                val wait = (hold?.at(key)?.let { it + GapTiming.HOLD_MS - motionNow() } ?: 0.0).coerceIn(0.0, GapTiming.HOLD_MS.toDouble())
                if (wait > 0) delay(wait.toLong())
                if (st.ghosts[key] !== g) return@launch
                g.leaving = true
                st.version.intValue++
                delay(GapTiming.CLOSE_DELAY.toLong())
                if (!lazy) {
                    // it gives up its place now and finishes its slide over the rows riding up
                    g.collapsed = true
                    st.version.intValue++
                    delay((GapTiming.OUT_MS - GapTiming.CLOSE_DELAY).toLong())
                }
                if (st.ghosts[key] === g) st.ghosts.remove(key)
                hold?.forget(key)
                st.version.intValue++
            }
        }
    }
    // what shows: the items in order, plus rows still on their way out after the row they followed
    val out = ArrayList<GapEntry<T>>(items.size + st.ghosts.size)
    items.forEachIndexed { i, it -> out.add(GapEntry(it, keys[i], false)) }
    for ((key, g) in st.ghosts) {
        val at = g.after?.let { a -> out.indexOfFirst { it.key == a } }?.takeIf { it >= 0 }
        out.add(if (at == null) 0 else at + 1, GapEntry(g.item, key, g.leaving, g.collapsed))
    }
    return out
}

private class Ghost<T>(val item: T, val after: String?) {
    var leaving = false
    var collapsed = false
    var started = false
}

private class GapListState<T> {
    var last: List<Pair<String, T>> = emptyList()
    var lastKeys: List<String>? = null
    val ghosts = LinkedHashMap<String, Ghost<T>>()
    val version = mutableIntStateOf(0)
}

/** When each row was confirmed, so it holds the confirmed look before it leaves. */
class GapHold {
    private val times = HashMap<String, Double>()
    fun confirm(key: String) {
        times[key] = motionNow()
    }
    fun at(key: String): Double? = times[key]
    fun forget(key: String) {
        times.remove(key)
    }
}

@Composable
fun rememberGapHold(): GapHold = remember { GapHold() }

/**
 * The row's own motion in a gap list: on its way out it slides 34dp right
 * and fades (170ms, --ease-in); [slide] false only fades (a section header
 * that goes with its last row). [collapsed]: it takes no room while it
 * finishes (a plain Column; a LazyColumn removes the row instead). Pair it
 * with [gapItem] on a LazyColumn item, or [gapPlacement] in a Column.
 */
@Composable
fun Modifier.gapRow(leaving: Boolean, collapsed: Boolean = false, slide: Boolean = true): Modifier {
    val reduced = reducedMotion()
    val k = remember { Animatable(0f) }
    LaunchedEffect(leaving, reduced) {
        if (!leaving) k.snapTo(0f) else if (reduced) k.snapTo(1f) else k.animateTo(1f, tween(GapTiming.OUT_MS, easing = Motion.EaseIn))
    }
    val dx = with(LocalDensity.current) { GapTiming.SLIDE_DP.dp.toPx() }
    // one layout change, at 90ms: from then on the row draws where it was but holds no room
    val room = if (collapsed) {
        Modifier.layout { measurable, constraints ->
            val p = measurable.measure(constraints)
            layout(p.width, 0) { p.place(0, 0) }
        }
    } else {
        Modifier
    }
    return this.then(room).graphicsLayer {
        translationX = if (slide) dx * k.value else 0f
        alpha = 1f - k.value
    }
}

/**
 * The list side of a gap list: new rows fade in, rows that leave finish
 * fading, and the rest move on the spring.
 */
@Composable
fun LazyItemScope.gapItem(): Modifier {
    val reduced = reducedMotion()
    return if (reduced) {
        Modifier
    } else {
        Modifier.animateItem(
            fadeInSpec = tween(200, easing = Motion.Ease),
            placementSpec = Motion.spring(IntOffset.VisibilityThreshold),
            fadeOutSpec = tween(GapTiming.OUT_MS - GapTiming.CLOSE_DELAY, easing = Motion.EaseIn),
        )
    }
}

/**
 * Close the gap outside a lazy list: when this node's place in its parent
 * changes (a row above it left), it slides from where it was to its new
 * place on the spring, a placement offset only. Put it on each row, and on
 * what follows the list, so nothing below jumps.
 */
@Composable
fun Modifier.gapPlacement(): Modifier {
    val reduced = reducedMotion()
    val scope = rememberCoroutineScope()
    val st = remember { PlacementState() }
    if (reduced) return this
    return this
        .onPlaced { st.target = it.positionInParent().round() }
        .offset {
            val target = st.target
            val anim = st.anim ?: Animatable(target, IntOffset.VectorConverter).also { st.anim = it }
            if (anim.targetValue != target) scope.launch { anim.animateTo(target, Motion.spring(IntOffset.VisibilityThreshold)) }
            anim.value - target
        }
}

private class PlacementState {
    var target by mutableStateOf(IntOffset.Zero)
    var anim: Animatable<IntOffset, androidx.compose.animation.core.AnimationVector2D>? = null
}
