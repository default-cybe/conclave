package dev.conclave.app.ui.motion

import android.content.Context
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.unit.min
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.motion.RopeMoment

/**
 * The launch on a cold start (docs/design/KNOT-MOTION.md 3), after the
 * system splash: a straight rope ties itself into the knot over the app's
 * ground, once per start of the process. A tap skips it. When the app is
 * ready sooner the rope still finishes its tie, then the splash fades into
 * the app; not ready by the end, the knot runs until it is. Before the
 * first pairing it plays the long launch with the name, once.
 */
object Launch {
    private var started = false
    private const val PREFS = "conclave.launch"
    private const val LONG_SEEN = "long"

    /** True the first time it is asked in this process: the launch plays. */
    fun take(): Boolean {
        if (started) return false
        started = true
        return true
    }

    /** The long launch has played through on this phone. */
    fun longSeen(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(LONG_SEEN, false)

    fun markLongSeen(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(LONG_SEEN, true).apply()
    }
}

/** The knot's box for the launch: as big as fits twice across the screen, 120 to 200 dp. */
private fun launchBox(width: Dp): Dp = min(200.dp, max(120.dp, (width - 48.dp) / 2))

@Composable
fun LaunchSplash(long: Boolean, ready: Boolean, onPlayed: () -> Unit = {}, onGone: () -> Unit) {
    val c = Conclave.colors
    val reduced = reducedMotion()
    var tied by remember { mutableStateOf(false) }
    var played by remember { mutableStateOf(false) }
    var skipped by remember { mutableStateOf(false) }
    // ready and tied (the long launch: ready and played through, so the name shows): fade into the app
    val out = ready && (skipped || if (long) played else tied)
    val shown by animateFloatAsState(
        if (out) 0f else 1f,
        tween(if (reduced) Motion.DUR_1 else Motion.DUR_4, easing = Motion.Ease),
        label = "launch",
        finishedListener = { if (it == 0f) onGone() },
    )
    // played through and still waiting: the knot runs where it was tied
    val running = (played || skipped) && !ready
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .graphicsLayer { alpha = shown }
            .background(c.bg)
            .pointerInput(Unit) { detectTapGestures { skipped = true } },
        contentAlignment = Alignment.Center,
    ) {
        val box = launchBox(maxWidth)
        if (!skipped && !running) {
            KnotRope(
                if (long) RopeMoment.LAUNCH_LONG else RopeMoment.LAUNCH,
                size = box,
                word = if (long) "Conclave" else null,
                label = "Starting Conclave",
                onTied = { tied = true },
                onDone = {
                    played = true
                    onPlayed()
                },
            )
        }
        if (running) KnotRope(RopeMoment.RUN, size = box, label = "Connecting")
    }
}

/** A moment on its own over the app (success once the phone has paired), then it fades into the app. */
@Composable
fun RopeSplash(moment: RopeMoment, onGone: () -> Unit, size: Dp = 96.dp) {
    val c = Conclave.colors
    val reduced = reducedMotion()
    var done by remember { mutableStateOf(false) }
    val shown by animateFloatAsState(
        if (done) 0f else 1f,
        tween(if (reduced) Motion.DUR_1 else Motion.DUR_4, easing = Motion.Ease),
        label = "rope splash",
        finishedListener = { if (it == 0f) onGone() },
    )
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .graphicsLayer { alpha = shown }
            .background(c.bg)
            .pointerInput(Unit) { detectTapGestures { done = true } },
        contentAlignment = Alignment.Center,
    ) {
        KnotRope(moment, size = size, onDone = { done = true })
    }
}

/** The knot and a word beside it, as a status line: RUN while waiting on the hub, SUCCESS when it says yes. */
@Composable
fun KnotRopeLine(
    moment: RopeMoment,
    word: String,
    modifier: Modifier = Modifier,
    color: Color = Conclave.colors.signal,
    surface: Color? = null,
    onDone: (() -> Unit)? = null,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        KnotRope(moment, size = 16.dp, surface = surface, onDone = onDone)
        Spacer(Modifier.width(8.dp))
        Text(word, style = ConclaveType.meta, color = color, maxLines = 1)
    }
}
