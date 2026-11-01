/**
 * The Knot's motion: where the light is on the knot, in every state. Pure
 * math and the state rules, no DOM. components/brand/KnotSvg.tsx draws it,
 * test/knot.test.ts checks it, and Android's dev.conclave.client.motion.Knot
 * is the same thing line for line (docs/design/CHAT-AND-MOTION.md 1.7).
 *
 * Positions are on the knot's path, 0 to 100 (KNOT_LENGTH), any real number:
 * 112 is the same point as 12. The light is the span from `tail` to `head`.
 * The geometry and the numbers come from docs/design/brand/knot.json.
 */
import { KNOT_LENGTH, KNOT_LIGHT, ROPE, ROPE_PATHS, type KnotPiece, type RopeTimes } from '../brand/knotGeometry';
import { EASE, clamp, cubicBezier, lerp, mod, seg } from './ease';
import { DUR } from './tokens';

const L = KNOT_LENGTH;

// ---------------------------------------------------------------------------
// Thinking: the light writes the knot, then lets go from the tail
// ---------------------------------------------------------------------------

/** One loop of thinking, ms. */
export const KNOT_LOOP = KNOT_LIGHT.thinking.loop;
/** The write runs from 0 to here (ms), the letting go from here to the end of the loop. */
export const KNOT_TURN = Math.round(KNOT_LOOP * KNOT_LIGHT.thinking.turn);
/** The ease of the write and of the letting go, each on its own. */
export const knotEase = cubicBezier(...KNOT_LIGHT.thinking.ease);
/** The still pose of thinking (reduced motion): the loop at this many ms, the light about 3/4 written. */
export const KNOT_STILL = KNOT_LIGHT.thinking.still;
/** One lap of the tool light, ms, and its length. */
export const KNOT_TOOL_LOOP = KNOT_LIGHT.tool.loop;
export const KNOT_TOOL_LEN = KNOT_LIGHT.tool.length;

/** x for knotEase(x) = y (bisection; the ease rises monotonically). */
function easeInverse(y: number): number {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (knotEase(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface KnotSpan {
  tail: number;
  head: number;
}

/**
 * The light at time t of the thinking loop (t in ms, any value). It writes
 * from 0 to the whole knot (eased), then lets go from the tail (eased), and
 * starts again one lap on, so the values never jump at the seam.
 */
export function knotSpan(t: number): KnotSpan {
  const laps = Math.floor(t / KNOT_LOOP);
  const u = t - laps * KNOT_LOOP;
  const base = laps * L;
  if (u < KNOT_TURN) return { tail: base, head: base + L * knotEase(u / KNOT_TURN) };
  return { tail: base + L * knotEase((u - KNOT_TURN) / (KNOT_LOOP - KNOT_TURN)), head: base + L };
}

/** The thinking clock (ms, within the first loop) while the light is written from its tail to `length`. */
export const knotWritePhase = (length: number) => KNOT_TURN * easeInverse(length / L);
/** The thinking clock (ms) while the light lets go and is still `length` long. */
export const knotReleasePhase = (length: number) => KNOT_TURN + (KNOT_LOOP - KNOT_TURN) * easeInverse(1 - length / L);

/** The tool light after `lap` ms, started with its tail at `at`: 14 long, one lap per 2s. */
export function knotTravel(lap: number, at: number): KnotSpan {
  const tail = at + (L * lap) / KNOT_TOOL_LOOP;
  return { tail, head: tail + KNOT_TOOL_LEN };
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** brand: the still mark, the light at home. A Knot that settles here lets go of its light from the tail until the home 16 is left. */
export type KnotState = 'thinking' | 'tool' | 'waiting' | 'paused' | 'failed' | 'done' | 'brand';

export interface KnotPose extends KnotSpan {
  /** How much of the light shows, 0 to 1 (done fades it out). */
  light: number;
}

/** The brand pose (the Mark): the light at home, the last 16 of the path, down the right lobe to its bottom. */
export const knotBrand = (): KnotPose => ({ tail: KNOT_LIGHT.brand.from, head: KNOT_LIGHT.brand.from + KNOT_LIGHT.brand.length, light: 1 });

/** Blend into each state, ms: the light's span and how much of it shows. */
export const KNOT_BLEND: Record<KnotState, number> = {
  thinking: DUR.d3,
  tool: DUR.d4,
  waiting: DUR.d3,
  paused: DUR.d3,
  failed: DUR.d3,
  done: 600,
  brand: 900,
};

/** The end of the light's home at or after `head`: a multiple of the path's length (the home is the 16 before it). */
export const knotHomeAfter = (head: number) => Math.ceil(head / L - 1e-9) * L;

const held = (s: KnotState) => s === 'waiting' || s === 'paused' || s === 'failed';

/**
 * One still, clear pose per state (reduced motion, rows in lists). Waiting
 * and failed hold the pose of the working state they came from (`via`).
 */
export function knotStill(state: KnotState, via?: 'thinking' | 'tool'): KnotPose {
  switch (state) {
    case 'thinking':
      return { ...knotSpan(KNOT_STILL), light: 1 };
    case 'tool':
      return { ...knotTravel(0, KNOT_LIGHT.brand.from), light: 1 };
    case 'waiting':
    case 'failed':
      return knotStill(via ?? 'thinking');
    case 'paused':
      return { tail: KNOT_LIGHT.paused.from, head: KNOT_LIGHT.paused.from + KNOT_LIGHT.paused.length, light: 1 };
    case 'done':
      return { ...knotBrand(), light: 0 };
    case 'brand':
      return knotBrand();
  }
}

function mixPose(a: KnotPose, b: KnotPose, k: number): KnotPose {
  // a light that did not show moves at once; only its strength blends
  const ks = a.light <= 0 ? 1 : k;
  return { tail: lerp(a.tail, b.tail, ks), head: lerp(a.head, b.head, ks), light: lerp(a.light, b.light, k) };
}

/**
 * The live Knot through every state. Feed it the state and the clock; it
 * returns the pose to draw. Two clocks, each running only in its own state,
 * so waiting, paused and failed hold the exact frame and going back to work
 * resumes from it.
 *
 *   thinking  the light writes the knot, then lets go from the tail (3s a loop)
 *   tool      a 14 long light travels the knot, one lap per 2s
 *   waiting   holds where it is (amber)
 *   paused    holds where it is (fg-3); a limit
 *   failed    stops where it is (the fault color)
 *   done      the light fades out (the knot turns fg-3)
 *   brand     the light lets go from its tail until it is the home 16 (the still mark)
 *
 * Changing between thinking and tool keeps the light where it is: tool
 * starts with its head on the written head; thinking picks up the tool
 * light as a stroke letting go of its tail.
 */
export class KnotMotion {
  state: KnotState;
  /** Thinking clock (ms), advances only while thinking. */
  phase = 0;
  /** Tool clock (ms), advances only while a tool runs. */
  lap = 0;
  /** Shift of the thinking loop along the path. */
  anchor = 0;
  /** Where the tool light's tail was when the tool started. */
  closeAt: number = KNOT_LIGHT.brand.from;
  /** The working state that waiting, paused and failed hold. */
  live: 'thinking' | 'tool' = 'thinking';
  /** Brand: where the light's home ends (a multiple of 100). */
  home: number = L;
  private from: KnotPose | null = null;
  private fromAt = 0;
  private blend = 0;
  private last: number | null = null;
  private drawn: KnotPose;

  constructor(state: KnotState = 'thinking', now = 0, via?: 'thinking' | 'tool') {
    this.state = state;
    this.last = now;
    if (state === 'tool' || (held(state) && via === 'tool')) this.live = 'tool';
    // mounted already waiting or failed: hold the clear still pose, not an empty loop
    if ((state === 'waiting' || state === 'failed') && this.live === 'thinking') this.phase = KNOT_STILL;
    // mounted in a limit: the short light at rest; thinking writes on from it
    if (state === 'paused' && this.live === 'thinking') {
      this.phase = knotWritePhase(KNOT_LIGHT.paused.length);
      this.anchor = KNOT_LIGHT.paused.from;
    }
    if (state === 'done') {
      this.phase = knotWritePhase(KNOT_LIGHT.brand.length);
      this.anchor = KNOT_LIGHT.brand.from;
    }
    this.drawn = this.target();
  }

  /** Start the thinking loop `elapsed` ms in (a Knot that takes over from another). Only while thinking and before anything blends. */
  seek(elapsed: number, now: number) {
    if (this.state !== 'thinking' || this.from) return;
    this.phase = Math.max(0, elapsed);
    this.last = now;
    this.drawn = this.target();
  }

  /** Change state at time now. The new pose blends in from the one last drawn. */
  set(state: KnotState, now: number) {
    if (state === this.state) return;
    this.advance(now);
    const cur = this.pose(now);
    const prev = this.state;
    this.state = state;
    const was = prev === 'done' || prev === 'brand' ? 'done' : held(prev) ? this.live : prev;
    if (state === 'brand') {
      // the light keeps its head and lets go of its tail until the home 16 is left
      this.home = knotHomeAfter(cur.head);
    }
    if (state === 'thinking') {
      if (was === 'tool') {
        // the tool light becomes a stroke letting go of its tail
        this.phase = knotReleasePhase(cur.head - cur.tail);
        this.anchor = cur.head - L;
      } else if (was === 'done') {
        // a new write from the start of the path, where the light's home ends
        this.phase = 0;
        this.anchor = 0;
      }
      this.live = 'thinking';
    } else if (state === 'tool') {
      if (was !== 'tool') {
        // the light keeps its head and travels on from there
        this.closeAt = was === 'done' ? KNOT_LIGHT.brand.from : cur.head - KNOT_TOOL_LEN;
        this.lap = 0;
      }
      this.live = 'tool';
    }
    this.from = cur;
    this.fromAt = now;
    this.blend = KNOT_BLEND[state];
  }

  private advance(now: number) {
    const dt = this.last === null ? 0 : Math.min(100, Math.max(0, now - this.last));
    this.last = now;
    if (this.state === 'thinking') this.phase += dt;
    else if (this.state === 'tool') this.lap += dt;
  }

  private target(): KnotPose {
    if (this.state === 'brand') return { tail: this.home - KNOT_LIGHT.brand.length, head: this.home, light: 1 };
    const span = this.live === 'tool' ? knotTravel(this.lap, this.closeAt) : knotSpan(this.phase);
    const shift = this.live === 'tool' ? 0 : this.anchor;
    return { tail: span.tail + shift, head: span.head + shift, light: this.state === 'done' ? 0 : 1 };
  }

  /** The pose at time now (advances the clocks). */
  pose(now: number): KnotPose {
    this.advance(now);
    let p = this.target();
    if (this.from) {
      const k = EASE.out(seg(now, this.fromAt, this.fromAt + this.blend));
      if (k >= 1) this.from = null;
      else p = mixPose(this.from, p, k);
    }
    this.drawn = p;
    return p;
  }

  /** True while frames change: a live state, or a blend still running. */
  moving(now: number): boolean {
    if (this.state === 'thinking' || this.state === 'tool') return true;
    return !!this.from && now < this.fromAt + this.blend;
  }

  get lastPose(): KnotPose {
    return this.drawn;
  }
}

// ---------------------------------------------------------------------------
// Drawing: where the light falls on each piece
// ---------------------------------------------------------------------------

/**
 * The light's intervals on piece p, in the piece's own length units (its
 * pathLength): none, one, or two when the light wraps round the path's end
 * onto the same piece. The last piece runs past 100 (round to the start).
 * Android draws each with PathMeasure.getSegment.
 */
export function knotLit(p: KnotPiece, pose: KnotSpan): Array<[number, number]> {
  const len = Math.min(L, pose.head - pose.tail);
  if (len <= 1e-3) return [];
  if (len >= L - 1e-3) return [[0, p.length]];
  const from = ((pose.tail % L) + L) % L;
  const out: Array<[number, number]> = [];
  for (const shift of [-L, 0, L]) {
    const a = Math.max(from + shift - p.from, 0);
    const b = Math.min(from + len + shift - p.from, p.length);
    if (b - a > 1e-3) out.push([a, b]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/**
 * The light on piece p as SVG dashes (the path has pathLength = p.length),
 * or null when none of it is lit. One dash for one interval, two for two.
 */
export function knotDash(p: KnotPiece, pose: KnotSpan): { array: string; offset: number } | null {
  const lit = knotLit(p, pose);
  // + 0 turns -0 into 0
  const r = (x: number) => Math.round(x * 1000) / 1000 + 0;
  if (!lit.length) return null;
  if (lit.length === 1) {
    const [a, b] = lit[0];
    return { array: `${r(b - a)} ${r(p.length + 1)}`, offset: r(-a) };
  }
  const [[a0, b0], [a1, b1]] = lit;
  return { array: `${r(b0 - a0)} ${r(a1 - b0)} ${r(b1 - a1)} ${r(p.length + 1)}`, offset: r(-a0) };
}

// ---------------------------------------------------------------------------
// The rope (docs/design/KNOT-MOTION.md): the knot ties itself
// ---------------------------------------------------------------------------

/**
 * The knot as one rope that slides along its own path; nothing morphs.
 * Positions are on the rope: the knot is 100 to 200 (ROPE.knot), the lead
 * in comes from the right to 100, the lead out leaves to the left from 200.
 * The rope is 100 long: at progress w it covers [w, w + 100]. w = 0 lies
 * straight on the lead in, w = 100 is the tied knot (the still mark), w =
 * 250 has left. The light is the rope's last 16 (the head light); a tied
 * rope runs it round with a separate position p (the lap light, wrapping).
 * components/motion/KnotRope.tsx draws it; Android's
 * dev.conclave.client.motion is the same, line for line.
 */
export type RopeMoment = 'launch' | 'launchLong' | 'run' | 'success' | 'receive' | 'send';

const RK = ROPE.knot;

/** A stretch of the rope: a path, a halo, anything with a start and a length on it. */
export interface RopeStretch {
  from: number;
  length: number;
}

/** The part of the window [a, b] that falls on p, in p's own units (its pathLength), or null. */
export function ropeSpan(p: RopeStretch, a: number, b: number): [number, number] | null {
  const s = Math.max(a - p.from, 0);
  const e = Math.min(b - p.from, p.length);
  return e - s > 1e-3 ? [s, e] : null;
}

/**
 * The parts of [a, b] (at most 100 long) on knot path p when positions go
 * round the knot (above 200 wraps back to 100), in p's own units: none,
 * one, or two when the span wraps onto the same path. The lap light, the
 * run piece and the trail use it.
 */
export function ropeRing(p: RopeStretch, a: number, b: number): Array<[number, number]> {
  const len = Math.min(L, b - a);
  if (len <= 1e-3) return [];
  if (len >= L - 1e-3) return [[0, p.length]];
  const from = RK + mod(a - RK, L);
  const out: Array<[number, number]> = [];
  for (const shift of [-L, 0, L]) {
    const s = Math.max(from + shift - p.from, 0);
    const e = Math.min(from + len + shift - p.from, p.length);
    if (e - s > 1e-3) out.push([s, e]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** The head light at progress w: the rope's last 16, [w + 84, w + 100]. */
export const ropeHead = (w: number): [number, number] => [w + ROPE.light.back, w + L];
/** The lap light at p: 16 from p, round the knot (ropeRing). */
export const ropeLap = (p: number): [number, number] => [p, p + ROPE.light.length];

export const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const successEase = cubicBezier(...ROPE.success.ease);

/** The cinch at share k of its time: the knot's scale around the box's center (1, .93, 1.025, 1). */
export function ropeCinch(k: number): number {
  const { at, scale } = ROPE.cinch;
  if (k <= 0 || k >= 1) return 1;
  for (let i = 1; i < at.length; i++) if (k <= at[i]) return lerp(scale[i - 1], scale[i], (k - at[i - 1]) / (at[i] - at[i - 1]));
  return 1;
}

/** w at t ms: held at `from` while straight, then eased to `to` (in out cubic, or x^easeIn). */
export function ropeW(m: RopeTimes, t: number): number {
  const k = clamp((t - m.straight) / m.move);
  return m.from + (m.to - m.from) * (m.easeIn > 0 ? Math.pow(k, m.easeIn) : easeInOutCubic(k));
}

/** The lap light's start at t ms: at home, then one lap (in out cubic) from lapAt after the move. */
export function ropeLapAt(m: RopeTimes, t: number): number {
  if (m.lap <= 0) return ROPE.light.home;
  const end = m.straight + m.move;
  return ROPE.light.home + L * easeInOutCubic(clamp((t - end - m.lapAt) / m.lap));
}

/**
 * Which light shows: the head light while the rope moves, the lap light
 * once a tie is done. At the swap both cover the same 16 (184 to 200), so
 * it never shows. An untie (send) keeps the head light: it leads.
 */
export function ropeSwap(m: RopeTimes, t: number): 'head' | 'lap' {
  return m.to === RK && t >= m.straight + m.move ? 'lap' : 'head';
}

/** How long a moment plays, ms (run loops: Infinity). */
export function ropeDuration(moment: RopeMoment): number {
  if (moment === 'run') return Infinity;
  if (moment === 'success') return Math.max(ROPE.success.spin, ROPE.success.cinchAt + ROPE.success.cinch);
  const m = ROPE[moment];
  const end = m.straight + m.move;
  return Math.max(end, m.cinch > 0 ? end + m.cinch : 0, m.lap > 0 ? end + m.lapAt + m.lap : 0, m.word > 0 ? end + m.wordAt + m.word : 0);
}

export interface RopePose {
  /** The rope covers [w, w + 100]. Run and success keep it tied (100). */
  w: number;
  /** The light that shows: the head light, the lap light, or the run piece's light. */
  light: 'head' | 'lap' | 'run';
  /** The lap light's start (and the trail's place). */
  lap: number;
  /** Run: where the running piece starts (it goes round the knot). */
  run: number;
  /** Success: how much of the trail shows, 0 to 1 (times ROPE.success.trail.opacity). */
  trail: number;
  /** The knot's scale around the box's center. */
  cinch: number;
  /** How much of the whole shows (a launch fades in), 0 to 1. */
  fade: number;
  /** The word under the first run's launch, 0 to 1. */
  word: number;
}

/** The trail's strength at share u of the spin: in, held, out. */
function trailAt(u: number): number {
  const [i0, i1] = ROPE.success.trail.in;
  const [o0, o1] = ROPE.success.trail.out;
  if (u <= i0 || u >= o1) return 0;
  if (u < i1) return (u - i0) / (i1 - i0);
  if (u <= o0) return 1;
  return 1 - (u - o0) / (o1 - o0);
}

/** The pose of a moment at t ms after it starts. */
export function ropePose(moment: RopeMoment, t: number): RopePose {
  if (moment === 'run') {
    const r = ROPE.run;
    return { w: RK, light: 'run', lap: ROPE.light.home, run: r.from + (L * Math.max(0, t)) / r.loop, trail: 0, cinch: 1, fade: 1, word: 0 };
  }
  if (moment === 'success') {
    const s = ROPE.success;
    const u = clamp(t / s.spin);
    return { w: RK, light: 'lap', lap: ROPE.light.home + L * s.laps * successEase(u), run: 0, trail: trailAt(u), cinch: ropeCinch((t - s.cinchAt) / s.cinch), fade: 1, word: 0 };
  }
  const m = ROPE[moment];
  const end = m.straight + m.move;
  return {
    w: ropeW(m, t),
    light: ropeSwap(m, t),
    lap: ropeLapAt(m, t),
    run: 0,
    trail: 0,
    cinch: m.cinch > 0 ? ropeCinch((t - end) / m.cinch) : 1,
    fade: m.fade > 0 ? clamp(t / m.fade) : 1,
    word: m.word > 0 ? clamp((t - end - m.wordAt) / m.word) : 0,
  };
}

/** The tied knot with the light at rest: the still mark, and every moment under reduced motion. */
export const ropeRest = (): RopePose => ({ w: RK, light: 'lap', lap: ROPE.light.home, run: 0, trail: 0, cinch: 1, fade: 1, word: 0 });

// Where things are: the rope's points, for the round ends and the launch camera

/** Each path's points (x, y pairs) and the rope position of each point. */
const ROPE_LINES = ROPE_PATHS.map((p) => {
  const xy = [...p.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
  const cum = [0];
  for (let i = 2; i < xy.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]));
  const total = cum[cum.length - 1];
  return { xy, at: cum.map((c) => p.from + (p.length * c) / total) };
});

/** The point at rope position pos (clamped to the rope's ends). */
export function ropePoint(pos: number): [number, number] {
  const first = ROPE_PATHS[0];
  const last = ROPE_PATHS[ROPE_PATHS.length - 1];
  const g = clamp(pos, first.from, last.from + last.length);
  for (let i = 0; i < ROPE_PATHS.length; i++) {
    const p = ROPE_PATHS[i];
    if (g > p.from + p.length + 1e-9) continue;
    const { xy, at } = ROPE_LINES[i];
    let j = 1;
    while (j < at.length - 1 && at[j] < g) j++;
    const k = at[j] > at[j - 1] ? clamp((g - at[j - 1]) / (at[j] - at[j - 1])) : 0;
    return [lerp(xy[2 * j - 2], xy[2 * j], k), lerp(xy[2 * j - 1], xy[2 * j + 1], k)];
  }
  return [0, 0];
}

/**
 * The over paths' base has flat ends (as the still mark), so a rope end on
 * one gets a round end of its own. A tail belongs to the path after it, a
 * head to the path before it.
 */
const onOver = (pos: number, head: boolean) => ROPE_PATHS.some((p) => p.kind === 'over' && (head ? pos > p.from + 1e-9 && pos <= p.from + p.length + 1e-9 : pos >= p.from - 1e-9 && pos < p.from + p.length - 1e-9));

/**
 * Where the base needs a round dot: a rope end on an over path (the
 * window's two ends, or the run piece's), and the join of k6 and k0 when
 * the base runs across it (two flat ends meet there, where the still mark
 * has one piece). Tied, the rope's ends meet at that join.
 */
export function ropeCaps(pose: RopePose): number[] {
  const out: number[] = [];
  if (pose.light === 'run') {
    const tail = RK + mod(pose.run - RK, L);
    const end = tail + ROPE.run.length;
    const head = end > RK + L ? end - L : end;
    if (onOver(tail, false)) out.push(tail);
    if (onOver(head, true)) out.push(head);
    if (end > RK + L + 1e-9) out.push(RK);
    return out;
  }
  if (Math.abs(pose.w - RK) < 1e-6) return [RK];
  if (onOver(pose.w, false)) out.push(pose.w);
  if (onOver(pose.w + L, true)) out.push(pose.w + L);
  return out;
}

/** The box around the rope's centerline over [a, b]: [x0, y0, x1, y1], or null when none of it is there. */
export function ropeBox(a: number, b: number): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  ROPE_PATHS.forEach((p, i) => {
    const s = ropeSpan(p, a, b);
    if (!s) return;
    const { xy, at } = ROPE_LINES[i];
    for (let j = 0; j < at.length; j++) if (at[j] > p.from + s[0] && at[j] < p.from + s[1]) add(xy[2 * j], xy[2 * j + 1]);
    add(...ropePoint(p.from + s[0]));
    add(...ropePoint(p.from + s[1]));
  });
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

export interface RopeCamera {
  /** scale */
  s: number;
  /** the point at the view's center, in box units */
  x: number;
  y: number;
}

/**
 * The camera on the rope at progress w, for a view vw by vh box units: it
 * fits the visible rope (and its stroke) inside the padding, never closer
 * than scale 1, centered on it. Tied, it is the knot at scale 1.
 */
export function ropeCameraAt(w: number, vw: number, vh: number, stroke: number): RopeCamera {
  if (w >= RK) return { s: 1, x: 32, y: 32 };
  const b = ropeBox(w, w + L);
  if (!b) return { s: 1, x: 32, y: 32 };
  const [px, py] = ROPE.camera.pad;
  const s = Math.min(1, (vw - 2 * px) / (b[2] - b[0] + stroke), (vh - 2 * py) / (b[3] - b[1] + stroke));
  return { s, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
}

/**
 * The launch camera at t ms: it follows the box of the visible rope,
 * smoothed over time (a triangle of ± smooth steps, each 1 / steps of the
 * tie), and ends on the knot at scale 1. Still before the tie and after it.
 */
export function ropeCamera(m: RopeTimes, t: number, vw: number, vh: number, stroke: number): RopeCamera {
  const w = ropeW(m, t);
  if (w <= m.from || w >= m.to) return ropeCameraAt(w, vw, vh, stroke);
  const n = ROPE.camera.smooth;
  const dt = m.move / ROPE.camera.steps;
  let sum = 0;
  let s = 0;
  let x = 0;
  let y = 0;
  for (let k = -n; k <= n; k++) {
    const weight = n + 1 - Math.abs(k);
    const c = ropeCameraAt(ropeW(m, t + k * dt), vw, vh, stroke);
    sum += weight;
    s += weight * c.s;
    x += weight * c.x;
    y += weight * c.y;
  }
  return { s: s / sum, x: x / sum, y: y / sum };
}

/** Parts of a path as SVG dashes (the path has pathLength = length): one dash per part, or null when there are none. */
export function ropeDash(parts: Array<[number, number]>, length: number): { array: string; offset: number } | null {
  const r = (x: number) => Math.round(x * 1000) / 1000 + 0;
  if (!parts.length) return null;
  const out: number[] = [];
  parts.forEach(([a, b], i) => {
    if (i) out.push(a - parts[i - 1][1]);
    out.push(b - a);
  });
  out.push(length + 1);
  return { array: out.map(r).join(' '), offset: r(-parts[0][0]) };
}
