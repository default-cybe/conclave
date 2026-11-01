package dev.conclave.client.logic

import dev.conclave.client.model.Message
import dev.conclave.client.model.ModelInfo
import dev.conclave.client.model.Session
import java.util.Locale
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sign

/**
 * The context ring at the right of the composer's quiet row (web
 * ComposerParts.tsx ContextRing): the last reply's context against the
 * model's window, and in its sheet the conversation's tokens and cost.
 */
data class ContextUse(
    /** The last reply's context: its input with what came from and went to the cache. */
    val used: Long,
    /** The model's context window; 0 when the hub does not know it. */
    val window: Long,
    /** The conversation's input tokens, cache reads included. */
    val tokensIn: Long,
    val tokensOut: Long,
    val costUsd: Double,
    /** A harness or a model without a price: paid by a plan, not per token. */
    val plan: Boolean,
    /** A conversation exists: its tokens and cost are shown. */
    val session: Boolean,
    /** What its calls are worth at API prices; more than [costUsd] when a plan served them. */
    val apiValueUsd: Double? = null,
) {
    /** The share of the window in use, 0 to 1. */
    val share: Double get() = if (window > 0) min(1.0, used.toDouble() / window) else 0.0

    val percent: Int get() = (share * 100).roundToInt()

    /** Over 80%: the ring turns to the warning colour. */
    val high: Boolean get() = share > 0.8

    /** The ring's name for a screen reader. */
    val label: String get() = if (used > 0) "Context, $percent% used" else "Context, nothing used yet"

    /** "12K of 200K, 6%", "12K" without a known window, or "Nothing used yet". */
    val contextLine: String
        get() = when {
            window > 0 -> "${compact(used)} of ${compact(window)}" + if (used > 0) ", $percent%" else ""
            used > 0 -> compact(used)
            else -> "Nothing used yet"
        }

    /** "12K in, 3K out". */
    val tokensLine: String get() = "${compact(tokensIn)} in, ${compact(tokensOut)} out"

    /** What it cost, "plan" when a plan pays, "$0" before anything ran. */
    val costLine: String
        get() = (if (costUsd > 0) Format.usd(costUsd) else if (plan) "plan" else "$0") + (ApiValue.worthLine(costUsd, apiValueUsd)?.let { ", $it" } ?: "")

    companion object {
        /** The numbers for [session] on [info], from its messages ([messages] may be empty: a new conversation). */
        fun of(messages: List<Message>, session: Session?, info: ModelInfo?): ContextUse {
            val last = messages.lastOrNull { it.usage != null }?.usage
            val used = if (last == null) 0L else last.inputTokens + (last.cacheReadTokens ?: 0L) + (last.cacheWriteTokens ?: 0L)
            val st = session?.stats
            val plan = session != null && (ModelRefs.isHarness(session.model) || (info != null && info.inputPrice == 0.0 && info.outputPrice == 0.0))
            return ContextUse(
                used = used,
                window = info?.contextWindow ?: 0L,
                tokensIn = if (st == null) 0L else st.inputTokens + st.cacheReadTokens,
                tokensOut = st?.outputTokens ?: 0L,
                costUsd = st?.costUsd ?: 0.0,
                plan = plan,
                session = session != null,
                apiValueUsd = st?.apiValueUsd,
            )
        }

        /**
         * A count in one short word, as the web's compact(): 950, "1.2K",
         * "12K", "200K", "1M", "1.5M". 999,950 reads as "1M", not "1000K".
         */
        fun compact(n: Long): String {
            val a = abs(n)
            for ((size, word) in listOf(1_000_000_000L to "B", 1_000_000L to "M", 1_000L to "K")) {
                if (a < size) continue
                val digits = if (size == 1_000L && a >= 10_000L) 0 else 1
                val s = trim(String.format(Locale.US, "%.${digits}f", n.toDouble() / size))
                if (word != "B" && abs(s.toDouble()) >= 1000) return compact(n.sign * size * 1000)
                return s + word
            }
            return n.toString()
        }

        private fun trim(s: String): String = if (s.contains('.')) s.trimEnd('0').trimEnd('.') else s
    }
}
