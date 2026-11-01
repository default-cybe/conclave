package dev.conclave.client.motion

/*
 * Roll: one number component for tokens, cost, countdowns and counts. Only
 * the characters that change roll, each in its own clipped cell: lower digits
 * first, each higher one 28ms later, up when the value rises and down when it
 * falls. The same rules as packages/web/src/components/motion/Roll.tsx.
 */

/** One character of the shown value. [prev] is null when it did not change; "" when it is new. */
data class RollCell(val cur: Char, val prev: String?, val rank: Int)

object Roll {
    /** Lag between neighbouring changed digits, lower ones first. */
    const val LAG = 28

    /** Roll time per digit for counts. */
    const val COUNT_MS = 240

    /** Roll time per digit for a clock (a countdown). */
    const val CLOCK_MS = 380

    /** How far a digit travels, as a share of the line height. */
    const val TRAVEL = 0.9

    /** Compare right aligned: which cells changed, and in what order they roll. */
    fun cells(prev: String, next: String): List<RollCell> {
        val n = next.length
        val off = prev.length - n
        val ranks = IntArray(n)
        var rank = 0
        for (i in n - 1 downTo 0) {
            val p = prev.getOrNull(i + off)
            ranks[i] = if (p != next[i]) rank++ else -1
        }
        return List(n) { i ->
            val p = prev.getOrNull(i + off)
            if (p != next[i]) RollCell(next[i], p?.toString() ?: "", ranks[i]) else RollCell(next[i], null, -1)
        }
    }

    /** The number in a text such as "4:59", "$0.031", "1,962" (0 when there is none). */
    fun valueOf(text: String): Double = text.replace(Regex("[^\\d.-]"), "").toDoubleOrNull() ?: 0.0

    /** True when the digits should roll up (the value rose or stayed). */
    fun up(prev: String, next: String): Boolean = valueOf(next) >= valueOf(prev)

    /**
     * Where a rolling cell is at [t] ms after the change: progress 0..1 of
     * the new digit (the old one leaves on the same curve), after its lag.
     */
    fun progress(t: Double, rank: Int, duration: Int): Double = Ease.out(seg(t, rank * LAG.toDouble(), rank * LAG.toDouble() + duration))

    /** How long a change with these cells takes to finish. */
    fun total(cells: List<RollCell>, duration: Int): Int = (cells.maxOfOrNull { it.rank } ?: -1).coerceAtLeast(0) * LAG + duration

    /** "4:59", "1:02:03": a countdown that reads at a glance (ms left, rounded up). */
    fun clockLeft(ms: Long): String {
        val s = maxOf(0L, (ms + 999) / 1000)
        val h = s / 3600
        val m = (s % 3600) / 60
        val ss = (s % 60).toString().padStart(2, '0')
        return if (h > 0) "$h:${m.toString().padStart(2, '0')}:$ss" else "$m:$ss"
    }
}
