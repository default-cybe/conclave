package dev.conclave.app.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.motion.Knot
import dev.conclave.app.ui.motion.LiveState
import dev.conclave.app.ui.motion.LiveStatus
import dev.conclave.app.ui.motion.Step
import dev.conclave.app.ui.motion.Steps
import dev.conclave.client.logic.SessionActivity
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.motion.KnotState
import kotlinx.coroutines.delay

/** When the turn this screen watches started and, once it ended, how long it took. */
class TurnClock {
    var startedAt: Long? = null
        private set
    var done: Pair<Long, Long>? = null
        private set
    private var wasLive = false

    /** Call while composing, so the line never drops out for a frame when the turn ends. */
    fun update(live: Boolean, start: Long?, now: Long) {
        if (live && !wasLive) {
            startedAt = start ?: now
            done = null
        } else if (!live && wasLive) {
            done = startedAt?.let { it to now }
            startedAt = null
        }
        wasLive = live
    }
}

/**
 * The live line under the last event of a session turn (CHAT-AND-MOTION
 * 1.9). One Knot the whole time, so every change starts from the frame it
 * was on, then the state in words:
 *
 *   thinking  the Knot writes, "Thinking 4s" after 400ms
 *   tool      the Knot holds and a light runs along it; Steps: "Running bun test", "Reading src/auth.ts"
 *   writing   as tool; Steps: "Writing"
 *   waiting   the Knot freezes in amber, "Waiting on you"
 *   resuming  a grey stub, "Resumes in 4:59" rolling down
 *   done      the Knot settles into the grey knot, "Done in 3m" in fg-3, after a turn ran here
 *
 * The line keeps one height in every state. The composer's Rim says the
 * same on its edge. [quiet] keeps its place but shows nothing (a notice
 * under the turn already says it stopped).
 */
@Composable
fun SessionLiveLine(
    status: SessionStatus?,
    running: Boolean,
    activity: SessionActivity,
    turn: TurnClock,
    resumeAt: Long?,
    modifier: Modifier = Modifier,
    quiet: Boolean = false,
) {
    val waiting = status == SessionStatus.WAITING_APPROVAL || status == SessionStatus.WAITING_INPUT
    val resuming = status == SessionStatus.WAITING_RESET
    val mark = when {
        waiting -> KnotState.WAITING
        resuming -> KnotState.PAUSED
        running -> if (activity is SessionActivity.Thinking) KnotState.THINKING else KnotState.TOOL
        else -> KnotState.DONE
    }
    val step: Step? = when {
        !running || waiting || resuming -> null
        activity is SessionActivity.Tool -> Step(activity.verb, activity.target, id = activity.id)
        activity is SessionActivity.Writing -> WRITING
        else -> null
    }
    // when this phase began, for "Thinking 4s" and the 400ms wait before the word
    val phase = when {
        waiting || resuming || !running -> status?.name ?: "done"
        step != null -> "step"
        else -> "thinking"
    }
    val since = remember(phase) { System.currentTimeMillis() }
    var late by remember(phase) { mutableStateOf(phase != "thinking") }
    LaunchedEffect(phase) {
        if (!late) {
            delay(400)
            late = true
        }
    }
    Row(
        modifier.fillMaxWidth().heightIn(min = 32.dp).graphicsLayer { alpha = if (quiet) 0f else 1f },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Knot(mark, size = 14.dp)
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f)) {
            when {
                step != null -> Steps(step)
                waiting -> LiveStatus(LiveState.WAITING, label = if (status == SessionStatus.WAITING_INPUT) "Waiting on your answer" else "Waiting on you", mark = false)
                resuming -> LiveStatus(
                    LiveState.RESUMING,
                    label = if (resumeAt == null) "Resumes when the limit resets" else null,
                    resumeAt = resumeAt,
                    countdown = resumeAt != null,
                    mark = false,
                )
                running -> Box(Modifier.graphicsLayer { alpha = if (late) 1f else 0f }) {
                    LiveStatus(LiveState.THINKING, startedAt = since, mark = false)
                }
                else -> turn.done?.let { (start, end) -> LiveStatus(LiveState.DONE, startedAt = start, endedAt = end, mark = false) }
            }
        }
    }
}

private val WRITING = Step("Writing")
