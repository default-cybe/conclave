/**
 * Motion tokens for code that draws from time (canvas, rAF, the Web
 * Animations API). Each value mirrors a custom property in styles/motion.css
 * or styles/index.css; test/motion-tokens.test.ts keeps the two in step.
 * Android mirrors the same numbers in ui/motion/Motion.kt.
 */
export const DUR = {
  /** --dur-0: press feedback */
  d0: 80,
  /** --dur-1: hover, swaps, exits */
  d1: 120,
  /** --dur-2: entrances, menus, toasts */
  d2: 180,
  /** --dur-3: panels, state words, a digit roll */
  d3: 240,
  /** --dur-4: a live mark settling, a container growing */
  d4: 360,
} as const;

export const LOOP = {
  /** --loop-knot: write, hold, let go */
  knot: 3000,
  /** --loop-knot-tool: one lap of the light along the knot while a tool runs */
  knotTool: 2000,
  /** --loop-rim: one lap of the light around the composer edge */
  rim: 4000,
  /** --loop-breath: amber in 1600ms, out 2200ms, rest 575ms */
  breath: 4375,
  /** --loop-shimmer: one pass across a live label, then a rest */
  shimmer: 2200,
} as const;

export const STREAM = {
  /** --stream-word: words are released this far apart */
  word: 40,
  /** --stream-lag: never more than this far behind the stream */
  lag: 320,
} as const;

/** The one spring on the web: critically damped, so it never overshoots. */
export const SPRING = {
  /** period in ms */
  response: 420,
  damping: 1,
  /** --dur-spring: until it is within 0.1% of rest (visually done by about 300ms) */
  settle: 620,
} as const;
