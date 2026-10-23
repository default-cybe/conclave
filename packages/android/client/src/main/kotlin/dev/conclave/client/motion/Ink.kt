package dev.conclave.client.motion

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/*
 * Ink: streamed text is revealed by a soft front along each line, newest
 * letters violet, cooling to ink about 0.3s behind the front. Nothing moves
 * or reflows. This is the clock: when each word is released and which
 * letters are in which tier at a given time. The app paints the tiers
 * (ui/conversation/ChatProse.kt); the web does the same with the Highlight
 * API (packages/web/src/components/motion/InkReveal.tsx).
 *
 * Pace: words are released 40ms apart and never more than 320ms behind the
 * stream; a big chunk is spread evenly over what is left of the 320ms.
 */

/** One word: char offsets [start, end); its front crosses it from t0 to t1 (ms). */
data class InkRun(val start: Int, val end: Int, val t0: Double, val t1: Double)

object Ink {
    /** Ages (ms since a letter's release) where each tier ends. Tier 0 is "not yet released". */
    val TIERS = intArrayOf(0, 40, 90, 170, 250, 330)

    /** After this long a released letter is plain ink. */
    val DONE_AFTER = TIERS.last()

    /** Text already on screen when streaming starts animates only if it is this short (a first chunk). */
    const val FIRST_CHUNK = 200

    private val WORDS = Regex("\\s*\\S+\\s*|\\s+")

    /** The text split as the web splits it: each word with the space around it. */
    fun words(text: String): List<String> = WORDS.findAll(text).map { it.value }.toList()

    /**
     * Release times for words of [lengths] that arrive at [now], after a
     * queue that last released a word at [queueEnd].
     */
    fun schedule(lengths: List<Int>, now: Double, queueEnd: Double, word: Int = Stream.WORD, lag: Int = Stream.LAG): DoubleArray {
        val n = lengths.size
        if (n == 0) return DoubleArray(0)
        val limit = now + lag
        val s0 = min(limit, max(now, queueEnd + word))
        val gap = if (n > 1) min(word.toDouble(), max(0.0, (limit - s0) / (n - 1))) else word.toDouble()
        return DoubleArray(n) { s0 + it * gap }
    }

    /** The first char whose release time is after [t] (runs are in text order and in time order). */
    fun boundary(runs: List<InkRun>, t: Double, end: Int): Int {
        for (r in runs) {
            if (t < r.t0) return r.start
            if (t >= r.t1) continue
            val k = (t - r.t0) / (r.t1 - r.t0)
            return min(r.end, r.start + floor(k * (r.end - r.start)).toInt() + 1)
        }
        return end
    }
}

/**
 * The words of one streaming text and when they are released. Offsets are
 * in whatever units the caller uses (source chars of the markdown).
 */
class InkClock {
    private val runs = ArrayList<InkRun>()
    private var queueEnd = Double.NEGATIVE_INFINITY

    /** Text [from] to the end of [text] just arrived at [now]: schedule its words. */
    fun arrive(text: String, from: Int, now: Double) {
        if (from >= text.length) return
        val words = Ink.words(text.substring(from))
        val times = Ink.schedule(words.map { it.length }, now, queueEnd)
        var off = from
        words.forEachIndexed { i, w ->
            val t0 = times[i]
            val next = if (i + 1 < times.size) times[i + 1] else t0 + Stream.WORD
            runs.add(InkRun(off, off + w.length, t0, max(t0 + 16, min(next, t0 + Stream.WORD))))
            off += w.length
        }
        if (times.isNotEmpty()) queueEnd = times.last()
    }

    /** The text got shorter (markdown re-rendered): drop what is past the end. */
    fun shrink(total: Int) {
        val kept = runs.filter { it.start < total }.map { if (it.end > total) it.copy(end = total) else it }
        runs.clear()
        runs.addAll(kept)
    }

    /** True while any letter is unreleased or still cooling. */
    fun active(now: Double): Boolean = runs.isNotEmpty() && now - runs.last().t1 <= Ink.DONE_AFTER

    /**
     * Tier boundaries at [now], newest first: [0] is the first letter not yet
     * released; tier i covers [b[i], b[i - 1]) (tier 0 to [end]). Also
     * forgets words that have fully cooled.
     */
    fun boundaries(now: Double, end: Int, out: IntArray = IntArray(Ink.TIERS.size)): IntArray {
        for (i in Ink.TIERS.indices) out[i] = Ink.boundary(runs, now - Ink.TIERS[i], end)
        while (runs.isNotEmpty() && now - runs.first().t1 > Ink.DONE_AFTER) runs.removeAt(0)
        return out
    }

    fun clear() {
        runs.clear()
        queueEnd = Double.NEGATIVE_INFINITY
    }

    /** For tests. */
    val pending: List<InkRun> get() = runs
}
