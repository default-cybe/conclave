package dev.conclave.app.ui.motion

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.common.clockTime
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Format
import dev.conclave.client.motion.Roll

/** The live states of a reply, a turn or a run (CHAT-AND-MOTION 1.3). */
enum class LiveState { THINKING, TOOL, WRITING, WAITING, RESUMING, DONE, FAILED, STOPPED }

private fun LiveState.defaultLabel(countdown: Boolean): String = when (this) {
    LiveState.THINKING -> "Thinking"
    LiveState.TOOL -> "Working"
    LiveState.WRITING -> "Writing"
    LiveState.WAITING -> "Waiting on you"
    LiveState.RESUMING -> if (countdown) "Resumes in {t}" else "Resumes {t}"
    LiveState.DONE -> "Done in {t}"
    LiveState.FAILED -> "Failed"
    LiveState.STOPPED -> "Stopped"
}

private val SLOT = Regex("\\s*(in|for|at)?\\s*\\{t\\}")

/**
 * The one line that says what the model is doing: the Knot, the words and
 * the time. "Thinking 4s", "Searching the web  caddy tailscale", "Done in
 * 3m 12s", "Resumes in 4:59". `{t}` in [label] is replaced by the time
 * (elapsed while live, the duration when done, the clock time or the
 * countdown when resuming); without it a known time follows the words.
 * Live words shimmer; waiting is amber and still; finished words are fg-3.
 * Every number rolls (Roll). Screen readers hear the words, never a ticking
 * number.
 *
 * @param countdown for RESUMING: count down to [resumeAt] ("Resumes in 4:59") instead of naming the clock time.
 * @param action one action after the words, such as Retry under a failure.
 * @param size the Knot's size: 14 in meta lines, 16 next to body text.
 * @param mark false when a Knot already shows nearby.
 */
@Composable
fun LiveStatus(
    state: LiveState,
    modifier: Modifier = Modifier,
    label: String? = null,
    detail: String? = null,
    startedAt: Long? = null,
    endedAt: Long? = null,
    durationMs: Long? = null,
    resumeAt: Long? = null,
    countdown: Boolean = false,
    size: Dp = 14.dp,
    mark: Boolean = true,
    since: Long? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val c = Conclave.colors
    val live = state == LiveState.THINKING || state == LiveState.TOOL || state == LiveState.WRITING
    val resuming = state == LiveState.RESUMING
    // only live and resuming states tick; a finished row holds no timer
    val now = if (live || (resuming && countdown)) rememberNow().value else 0L
    val ended = state == LiveState.DONE || state == LiveState.STOPPED || state == LiveState.FAILED
    val time: String? = when {
        // a live counter starts at 1s, never "0s"
        live && startedAt != null -> (now - startedAt).takeIf { it >= 1000 }?.let { Format.durationShort(it) }
        ended && durationMs != null -> Format.durationShort(durationMs)
        ended && startedAt != null && endedAt != null -> Format.durationShort(endedAt - startedAt)
        resuming && resumeAt != null -> if (countdown) Roll.clockLeft(resumeAt - now) else clockTime(resumeAt)
        else -> null
    }
    val words = label ?: state.defaultLabel(countdown)
    val tone = when (state) {
        LiveState.THINKING, LiveState.TOOL, LiveState.WRITING -> c.signal
        LiveState.WAITING -> c.warn
        LiveState.FAILED -> c.fault
        LiveState.RESUMING, LiveState.DONE, LiveState.STOPPED -> c.fg3
    }
    val slot = words.indexOf("{t}")
    val spoken = when {
        slot < 0 -> words
        resuming && countdown && resumeAt != null -> "Resumes at ${clockTime(resumeAt)}"
        time != null -> words.replace("{t}", time)
        else -> words.replace(SLOT, "").trim()
    }
    val rollDir = if (resuming) RollDirection.DOWN else RollDirection.UP
    val rollMs = if (resuming && countdown) Roll.CLOCK_MS else Roll.COUNT_MS
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f, fill = false).clearAndSetSemantics { contentDescription = spoken; liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
            if (mark) {
                Knot(state.knot(), size = size, since = since)
                Spacer(Modifier.width(8.dp))
            }
            when {
                slot >= 0 && time != null -> {
                    val before = words.substring(0, slot)
                    val after = words.substring(slot + 3)
                    if (before.isNotEmpty()) Text(before, style = ConclaveType.meta, color = tone, maxLines = 1)
                    RollText(time, ConclaveType.metaNum, tone, direction = rollDir, duration = rollMs)
                    if (after.isNotEmpty()) Text(after, style = ConclaveType.meta, color = tone, maxLines = 1)
                }
                slot >= 0 -> Text(words.replace(SLOT, "").trim(), style = ConclaveType.meta, color = tone, maxLines = 1)
                else -> {
                    ShimmerText(words, style = ConclaveType.meta, color = tone, active = state == LiveState.THINKING || state == LiveState.TOOL)
                    if (time != null) {
                        Spacer(Modifier.width(4.dp))
                        RollText(time, ConclaveType.metaNum, if (live) c.signal else c.fg3, direction = rollDir, duration = rollMs)
                    }
                }
            }
            if (!detail.isNullOrBlank()) {
                Spacer(Modifier.width(6.dp))
                Text(detail, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
        }
        if (action != null) {
            Spacer(Modifier.width(4.dp))
            action()
        }
    }
}
