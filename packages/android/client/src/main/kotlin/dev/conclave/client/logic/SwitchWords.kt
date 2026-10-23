package dev.conclave.client.logic

import dev.conclave.client.model.SwitchEstimate
import dev.conclave.client.model.SwitchMath
import java.util.Locale
import kotlin.math.roundToLong

/**
 * The words of a model switch's price step (docs/DESIGN.md 44), the same as
 * the web's features/chat/switch.ts: "About $0.40 once, pays back after
 * about 9 replies". Full history is the default; Short handover is offered
 * when the hub's estimate has one.
 */
object SwitchWords {
    /** "$0.40", or "under a cent". Halves round up ($0.145 reads $0.15). */
    fun usd(v: Double): String {
        if (v < 0.005) return "under a cent"
        val cents = (v * 100 + 1e-9).roundToLong()
        return String.format(Locale.US, "$%d.%02d", cents / 100, cents % 100)
    }

    fun priceLine(m: SwitchMath): String {
        val once = "About ${usd(m.onceUsd)} once"
        val n = m.paybackReplies
        return when {
            n == 0 -> "$once, cheaper than staying from the first reply"
            n == null -> "$once, and each reply costs more than staying"
            else -> "$once, pays back after about $n ${if (n == 1) "reply" else "replies"}"
        }
    }

    /** "This chat holds about 100k tokens." */
    fun sizeLine(e: SwitchEstimate, name: String): String = "This chat holds about ${Format.tokens(e.tokens)} tokens. $name reads them with no cache on its first reply."

    /** The quiet line under the choices, or null when there is nothing to suggest. */
    fun suggestion(e: SwitchEstimate, briefPicked: Boolean): String? {
        val brief = e.brief ?: return null
        if (!e.suggestBrief || briefPicked) return null
        return "A short handover would save about ${usd((e.full.onceUsd - brief.onceUsd).coerceAtLeast(0.0))} here."
    }

    fun askLine(e: SwitchEstimate, name: String): String = "One answer from $name, about ${usd(e.askUsd)}"

    const val BRIEF_DETAIL = "A summary and the recent turns, with old tool output cleared. The full chat stays stored."
}
