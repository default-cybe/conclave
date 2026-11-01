package dev.conclave.app.ui.motion

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import dev.conclave.client.motion.Dur
import dev.conclave.client.motion.Loop
import dev.conclave.client.motion.Spring
import dev.conclave.client.motion.springStiffness

/*
 * Motion tokens and helpers (docs/design/CHAT-AND-MOTION.md section 1), the
 * Compose side of packages/web/src/styles/motion.css. The numbers live in
 * :client (dev.conclave.client.motion, checked against the CSS by
 * MotionTest). Quiet and fast: opacity and at most 4dp of travel for UI;
 * the Knot, the Rim and Ink for live work. With the system "Remove
 * animations" setting every live thing draws one still frame with the same
 * colors and words.
 */
object Motion {
    /** Press feedback, a copy icon turning into a check. */
    const val DUR_0 = Dur.D0

    /** Hover, press, small swaps. */
    const val DUR_1 = Dur.D1

    /** Menus, entrances, a message arriving. */
    const val DUR_2 = Dur.D2

    /** Panels, a state word finishing, a digit roll. */
    const val DUR_3 = Dur.D3

    /** A live mark settling, a fold opening. */
    const val DUR_4 = Dur.D4

    /** The spring until it rests (it looks done by about 300ms). */
    const val DUR_SPRING = Spring.SETTLE

    /** The Knot: the light writes the knot 1650, lets go 1350. */
    const val LOOP_KNOT = Loop.KNOT

    /** One lap of the light along the knot while a tool runs. */
    const val LOOP_KNOT_TOOL = Loop.KNOT_TOOL

    /** One lap of the light round the composer edge. */
    const val LOOP_RIM = Loop.RIM

    /** Amber in 1600, out 2200, rest 575. */
    const val LOOP_BREATH = Loop.BREATH

    /** One pass of the letter wave across a label, then a rest. */
    const val LOOP_SHIMMER = Loop.SHIMMER

    /** Between items that enter together (at most five). */
    const val STAGGER = 40

    /** The most any UI element travels. */
    val RISE = 4.dp

    /** --ease: entrances and settles. */
    val Ease = CubicBezierEasing(0.2f, 0.7f, 0.2f, 1f)

    /** --ease-in: exits. */
    val EaseIn = CubicBezierEasing(0.4f, 0f, 1f, 1f)

    /** --ease-sine: loops, the breath. */
    val EaseSine = CubicBezierEasing(0.37f, 0f, 0.63f, 1f)

    /** --ease-morph: the Knot's light writes and lets go. */
    val EaseMorph = CubicBezierEasing(0.6f, 0f, 0.4f, 1f)

    /** --ease-emph: a card grows into its panel, the send glyph folds. */
    val EaseEmph = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    /** --ease-std: a panel shrinks back, a fold reopens. */
    val EaseStd = CubicBezierEasing(0.4f, 0f, 0.2f, 1f)

    /** --spring: critically damped (420ms period), so it never overshoots. List gaps and the toast stack. */
    fun <T> spring(visibilityThreshold: T? = null): SpringSpec<T> =
        androidx.compose.animation.core.spring(dampingRatio = 1f, stiffness = SPRING_STIFFNESS, visibilityThreshold = visibilityThreshold)

    private val SPRING_STIFFNESS = springStiffness().toFloat()
}

/**
 * The clock the Knot, the Rim, Ink and the other drawn motion read, in ms,
 * on the same base as Compose frame times (System.nanoTime). A desktop
 * render harness swaps [now] for its own clock to capture frames.
 */
object MotionClock {
    @Volatile
    var now: () -> Double = { System.nanoTime() / 1_000_000.0 }
}

fun motionNow(): Double = MotionClock.now()

/**
 * Whether a node is on screen: false once it is scrolled out of every
 * ancestor's bounds, so a loop can stop drawing (spec 1.6). Read
 * [visible] where the loop decides to run.
 */
class Onscreen {
    var visible by mutableStateOf(true)
        internal set
}

@Composable
fun rememberOnscreen(): Onscreen = remember { Onscreen() }

/** Tracks [state]: the node's bounds clipped by its ancestors are empty once it is offscreen. */
fun Modifier.onscreen(state: Onscreen): Modifier = onGloballyPositioned { c ->
    val b = c.boundsInWindow()
    val v = b.width > 0f && b.height > 0f
    if (state.visible != v) state.visible = v
}

/** Provided once near the root so every mark shares one observer. Null: read the setting here. */
val LocalReducedMotion = compositionLocalOf<Boolean?> { null }

private fun animationsOff(context: android.content.Context): Boolean = try {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
} catch (_: Exception) {
    false
}

/** True while the system "Remove animations" setting is on. Follows changes made while the app runs. */
@Composable
fun rememberSystemReducedMotion(): Boolean {
    val context = LocalContext.current
    var off by remember(context) { mutableStateOf(animationsOff(context)) }
    DisposableEffect(context) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                off = animationsOff(context)
            }
        }
        val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)
        runCatching { context.contentResolver.registerContentObserver(uri, false, observer) }
        off = animationsOff(context)
        onDispose { runCatching { context.contentResolver.unregisterContentObserver(observer) } }
    }
    return off
}

/** Reduced motion for this place in the tree: draw a still frame instead of moving. */
@Composable
fun reducedMotion(): Boolean = LocalReducedMotion.current ?: rememberSystemReducedMotion()

/** Reads the setting once for everything under it. */
@Composable
fun ProvideReducedMotion(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalReducedMotion provides rememberSystemReducedMotion(), content = content)
}

/**
 * One child gives way to another in the same place (Copy to Check, Send to
 * Stop): the outgoing one fades and drops 2dp, the incoming one fades in,
 * 120ms. Nothing around it moves. Without animations it swaps at once.
 */
@Composable
fun Swap(on: Boolean, off: @Composable () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val reduced = reducedMotion()
    val shown by animateFloatAsState(if (on) 1f else 0f, tween(if (reduced) 0 else Motion.DUR_1, easing = Motion.Ease), label = "swap")
    val drop = with(LocalDensity.current) { 2.dp.toPx() }
    Box(modifier, contentAlignment = Alignment.Center) {
        Box(Modifier.graphicsLayer { alpha = 1f - shown; translationY = drop * shown }) { off() }
        Box(Modifier.graphicsLayer { alpha = shown; translationY = drop * (1f - shown) }) { content() }
    }
}
