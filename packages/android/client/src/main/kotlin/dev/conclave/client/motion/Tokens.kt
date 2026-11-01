package dev.conclave.client.motion

/*
 * Motion tokens, the numbers in packages/web/src/styles/motion.css and
 * packages/web/src/components/motion/tokens.ts. MotionTest keeps them in
 * step with the CSS. The app's ui/motion/Motion.kt reads them from here.
 */

/** Durations in ms. */
object Dur {
    /** --dur-0: press feedback, a copy icon turning into a check. */
    const val D0 = 80

    /** --dur-1: hover, swaps, exits. */
    const val D1 = 120

    /** --dur-2: entrances, menus, toasts. */
    const val D2 = 180

    /** --dur-3: panels, state words, a digit roll. */
    const val D3 = 240

    /** --dur-4: a live mark settling, a fold opening. */
    const val D4 = 360
}

/** Loops in ms. */
object Loop {
    /** --loop-knot: the light writes the knot 1650, lets go 1350. */
    const val KNOT = 3000

    /** --loop-knot-tool: one lap of the light along the knot while a tool runs. */
    const val KNOT_TOOL = 2000

    /** --loop-rim: one lap of the light round the composer edge. */
    const val RIM = 4000

    /** --loop-breath: amber in 1600, out 2200, rest 575. */
    const val BREATH = 4375

    /** --loop-shimmer: one pass across a live label, then a rest. */
    const val SHIMMER = 2200
}

/** Ink's pace. */
object Stream {
    /** --stream-word: words are released this far apart. */
    const val WORD = 40

    /** --stream-lag: never more than this far behind the stream. */
    const val LAG = 320
}

/** The one spring: critically damped, so it never overshoots. */
object Spring {
    /** Period in ms. */
    const val RESPONSE = 420

    const val DAMPING = 1.0

    /** --dur-spring: until it is within 0.1% of rest (it looks done by about 300ms). */
    const val SETTLE = 620
}
