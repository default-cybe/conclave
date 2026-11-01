package dev.conclave.client.motion

/*
 * Timings and small layout rules for Steps, Fold, the gap list, card to
 * panel and the toast stack (docs/design/CHAT-AND-MOTION.md 1.4), the same
 * numbers as the web primitives in packages/web/src/components/motion.
 */

/** The live status line: the old step leaves before the new one arrives, so two never share the line. */
object Steps {
    /** Old step out: lifts 4px and fades, its parts 10ms apart (at most 30ms). */
    const val OUT_MS = 150
    const val OUT_STEP = 10
    const val OUT_STEP_MAX = 30

    /** The new step starts this long after the change, once the old one is gone. */
    const val IN_AT = 190

    /** Its parts (icon, then each word) rise 32ms apart, 300ms each. */
    const val PART_MS = 32
    const val PART_DUR = 300

    /** The verb's one pass of light starts this long after the step has landed. */
    const val GLINT_AFTER = 600

    /** The pass: each letter lights 22ms after the one before, 420ms each, at most 0.85. */
    const val GLINT_STEP = 22
    const val GLINT_MS = 420

    /** When the new step has landed, with [parts] parts. */
    fun landed(parts: Int): Int = IN_AT + maxOf(0, parts - 1) * PART_MS + PART_DUR

    /** Opacity and rise (0..1 of the 4dp) of part [i] of the incoming step, [t] ms after the change. */
    fun partIn(t: Double, i: Int): Double = Ease.out(seg(t, IN_AT + i * PART_MS.toDouble(), IN_AT + i * PART_MS.toDouble() + PART_DUR))

    /** Progress 0..1 of part [i] of the leaving step, [t] ms after the change. */
    fun partOut(t: Double, i: Int): Double {
        val at = minOf(i * OUT_STEP, OUT_STEP_MAX).toDouble()
        return Ease.inn(seg(t, at, at + OUT_MS))
    }

    /** The glint on letter [i] of the verb, [t] ms after the step landed plus GLINT_AFTER: 0 to 0.85 and back. */
    fun glint(t: Double, i: Int): Double {
        val u = seg(t, i * GLINT_STEP.toDouble(), i * GLINT_STEP.toDouble() + GLINT_MS)
        if (u <= 0 || u >= 1) return 0.0
        return if (u < 0.4) 0.85 * u / 0.4 else 0.85 * (1 - (u - 0.4) / 0.6)
    }
}

/** The "Thought for Ns" row and its reasoning. */
object Fold {
    /** Folding closed: 320ms on --ease, 40ms after the answer starts. */
    const val CLOSE_MS = 320
    const val CLOSE_DELAY = 40

    /** Opening: 360ms on --ease-std; the rule draws down in 300ms from 30ms; paragraphs come in top first, 38ms apart. */
    const val OPEN_MS = 360
    const val RULE_MS = 300
    const val PARA_AT = 70
    const val PARA_STEP = 38
    const val PARA_MS = 240

    /** While closing, paragraphs fade bottom first, 26ms apart, 150ms each. */
    const val PARA_OUT_STEP = 26
    const val PARA_OUT_MS = 150
}

/** Approve and close the gap (ui.html approve-gap). */
object Gap {
    /** The chosen button confirms in place: its label swaps and the rule turns ok in 140ms. */
    const val CONFIRM_MS = 140

    /** The card holds the confirmed look this long before it leaves. */
    const val HOLD_MS = 440

    /** It slides 34dp right and fades in 170ms on --ease-in. */
    const val OUT_MS = 170
    const val SLIDE_DP = 34

    /** 90ms in, the rows below ride up on the spring. */
    const val CLOSE_DELAY = 90
}

/** Card to panel: a card grows into its panel. */
object CardPanel {
    /** Opening: 420ms on --ease-emph; the card's face fades out first, the panel's content fades in from 110ms. */
    const val OPEN_MS = 420
    const val FACE_OUT_MS = 110
    const val CONTENT_AT = 110
    const val CONTENT_MS = 240

    /** Closing: 320ms on --ease-std; the card's face returns before the box is empty. */
    const val CLOSE_MS = 320
}

/**
 * The toast stack (ui.html toast-stack). The newest toast is in front; older
 * ones sit 11dp higher and 5% smaller with their words hidden. Fanned (a
 * tap), every toast reads, 8dp apart.
 */
object ToastStack {
    const val PEEK = 11
    const val GAP = 8
    const val SHRINK = 0.05
    const val MAX = 3

    /** A toast rises 18dp and fades in; it leaves with a 6dp drop, or slides 22dp right when dismissed. */
    const val RISE = 18
    const val DROP = 6
    const val SLIDE = 22
    const val OUT_MS = 200
    const val GONE_MS = 180

    /** Auto dismiss after this long unless sticky; the timer waits while the stack is fanned. */
    const val TTL = 5000L

    /** Where one toast sits: its place from the front, its offset (dp, up from the bottom), its scale, and whether its words show. */
    data class Slot(val idx: Int, val offset: Int, val scale: Double, val words: Boolean)

    /**
     * Slots for toasts [front first] with their [heights] (dp). A leaving
     * toast keeps the slot it had while it goes; it does not push the others.
     */
    fun layout(heights: List<Int>, leaving: List<Boolean>, fan: Boolean): List<Slot> {
        var live = 0
        var offset = 0
        return heights.indices.map { i ->
            val idx = if (leaving[i]) maxOf(0, live - 1) else live++
            val fanned = offset
            if (!leaving[i]) offset += heights[i] + GAP
            Slot(
                idx = idx,
                offset = if (fan) fanned else idx * PEEK,
                scale = if (fan) 1.0 else 1 - idx * SHRINK,
                words = fan || idx == 0 || leaving[i],
            )
        }
    }

    /** The height the stack takes (dp). */
    fun height(heights: List<Int>, leaving: List<Boolean>, fan: Boolean): Int {
        val live = heights.indices.filter { !leaving[it] }
        if (live.isEmpty()) return heights.firstOrNull() ?: 0
        val front = heights[live.first()]
        return if (fan) maxOf(front, live.sumOf { heights[it] + GAP } - GAP) else front + maxOf(0, live.size - 1) * PEEK
    }
}
