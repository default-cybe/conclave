/**
 * Conclave's own ASCII art: a conclave seen from a little above. A hub sits
 * in the middle, seven agents sit on a ring around it that turns once every
 * two minutes, each tied to the hub by a link, and a faint constellation of
 * far nodes drifts behind. Every few seconds one agent sends a message: a
 * violet packet runs down its link and the hub answers with a small swell.
 *
 * Pure logic only (no DOM): the scene for a grid and a seed, and the frame
 * at a time t as one density level per cell plus a few "hot" cells that the
 * canvas draws in --signal. AsciiField.tsx draws it.
 */

/** Density ramp, light to heavy. ASCII only (the style check bans other glyphs). */
export const RAMP = ' .:-=+*#%@';

/** Frames a second while it moves. */
export const FPS = 20;
/** Seconds between two messages. */
export const PERIOD = 4.5;
/** The time a still frame shows: a packet halfway down its link. */
export const STILL_T = PERIOD * 3 + PERIOD * 0.3;

const SEATS = 7;
const TAU = Math.PI * 2;
/** Ring turn speed, radians a second (one turn in about 2 minutes). */
const SPIN = TAU / 120;
/** How flat the ring looks: its height over its width. */
const TILT = 0.34;

export interface Star {
  x: number;
  y: number;
  ph: number;
}

export interface Scene {
  cols: number;
  rows: number;
  /** Cell height over cell width: distances are measured in cell widths. */
  aspect: number;
  hx: number;
  hy: number;
  /** Ring radius in cell widths. */
  R: number;
  seats: number[];
  stars: Star[];
  links: Array<[number, number]>;
  /** Which seat speaks first. */
  first: number;
  /** Draw the hub; off when the page puts its mark there. */
  hub: boolean;
}

export interface Frame {
  cols: number;
  rows: number;
  /** RAMP index per cell, row by row. */
  level: Uint8Array;
  /** 1 where the cell is drawn in --signal. */
  hot: Uint8Array;
}

/** Small seeded PRNG (mulberry32): the same seed gives the same scene. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The scene for a grid. `align: 'start'` puts the hub in the left part of
 * the field (empty states are left aligned with their column); 'center' in
 * the middle (the sign-in hero).
 */
export function makeScene(cols: number, rows: number, aspect: number, seed: number, align: 'start' | 'center' = 'center', hub = true): Scene {
  const r = rng(seed);
  const H = rows * aspect;
  // the ring fits the height with room for the nodes; centred it may span 60% of a narrow width (the phone sign-in)
  const R = Math.max(3, Math.min((H * 0.4) / TILT, cols * (align === 'start' ? 0.22 : 0.3), 40));
  const hx = align === 'start' ? Math.min(cols / 2, R + 4) : cols / 2;
  const hy = H / 2;
  const seats = Array.from({ length: SEATS }, (_, i) => (i / SEATS) * TAU + (r() - 0.5) * 0.35);
  // far nodes: about one per 120 cells, kept off the ring
  const stars: Star[] = [];
  const want = Math.round((cols * rows) / 120);
  for (let n = 0; n < want * 4 && stars.length < want; n++) {
    const x = r() * cols;
    const y = r() * H;
    const ph = r() * TAU;
    const ex = (x - hx) / (R + 5);
    const ey = (y - hy) / (R * TILT + 4);
    if (ex * ex + ey * ey < 1) continue;
    stars.push({ x, y, ph });
  }
  // the constellation: each far node links to its nearest neighbour when it is close
  const links: Array<[number, number]> = [];
  const reach = Math.max(6, Math.min(10, cols / 12));
  for (let i = 0; i < stars.length; i++) {
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < stars.length; j++) {
      if (j === i) continue;
      const d = Math.hypot(stars[i]!.x - stars[j]!.x, stars[i]!.y - stars[j]!.y);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best >= 0 && bd < reach && !links.some(([a, b]) => (a === best && b === i) || (a === i && b === best))) links.push([i, best]);
  }
  return { cols, rows, aspect, hx, hy, R, seats, stars, links, first: Math.floor(r() * SEATS), hub };
}

function put(buf: Float32Array, s: Scene, cx: number, cy: number, v: number): number {
  if (cx < 0 || cy < 0 || cx >= s.cols || cy >= s.rows) return -1;
  const i = cy * s.cols + cx;
  if (v > buf[i]!) buf[i] = v;
  return i;
}

/** A soft round node: brightness v at the centre, falling to nothing at radius rad. */
function node(buf: Float32Array, s: Scene, x: number, y: number, rad: number, v: number) {
  const ry = rad / s.aspect;
  for (let cy = Math.floor(y / s.aspect - ry); cy <= Math.ceil(y / s.aspect + ry); cy++) {
    for (let cx = Math.floor(x - rad); cx <= Math.ceil(x + rad); cx++) {
      const d = Math.hypot(cx + 0.5 - x, (cy + 0.5) * s.aspect - y) / rad;
      if (d < 1) put(buf, s, cx, cy, v * (1 - d * d));
    }
  }
}

/** A line sampled once per cell, from (x0, y0) to (x1, y1). */
function line(buf: Float32Array, s: Scene, x0: number, y0: number, x1: number, y1: number, v: number) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0) / s.aspect)));
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    put(buf, s, Math.floor(x0 + (x1 - x0) * f), Math.floor((y0 + (y1 - y0) * f) / s.aspect), v);
  }
}

const ease = (p: number) => p * p * (3 - 2 * p);

/** Where seat i is at time t, and how near the viewer it is (0 back, 1 front). */
export function seat(s: Scene, i: number, t: number): { x: number; y: number; near: number } {
  const a = s.seats[i]! + SPIN * t;
  return { x: s.hx + s.R * Math.cos(a), y: s.hy + s.R * TILT * Math.sin(a), near: 0.5 + 0.5 * Math.sin(a) };
}

/** The frame at time t (seconds). Pass `out` to reuse its buffers. */
export function renderFrame(s: Scene, t: number, out?: Frame): Frame {
  const n = s.cols * s.rows;
  const f = out && out.level.length === n ? out : { cols: s.cols, rows: s.rows, level: new Uint8Array(n), hot: new Uint8Array(n) };
  f.hot.fill(0);
  const buf = new Float32Array(n);

  // far nodes drift a little and twinkle slowly; their links stay faint
  const at = s.stars.map((p) => ({ x: p.x + 0.8 * Math.sin(t * 0.05 + p.ph), y: p.y + 0.5 * Math.cos(t * 0.04 + p.ph * 1.3) }));
  for (const [a, b] of s.links) line(buf, s, at[a]!.x, at[a]!.y, at[b]!.x, at[b]!.y, 0.11);
  s.stars.forEach((p, i) => put(buf, s, Math.floor(at[i]!.x), Math.floor(at[i]!.y / s.aspect), 0.22 + 0.12 * Math.sin(t * 0.35 + p.ph)));

  // the orbit the agents sit on, its far side dimmer
  const steps = Math.ceil(TAU * s.R);
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * TAU;
    put(buf, s, Math.floor(s.hx + s.R * Math.cos(a)), Math.floor((s.hy + s.R * TILT * Math.sin(a)) / s.aspect), 0.12 + 0.12 * (0.5 + 0.5 * Math.sin(a)));
  }
  const seats = s.seats.map((_, i) => seat(s, i, t));

  // one agent speaks: its spoke lights, a packet runs down it over the first 60% of a period, then the hub swells
  const k = Math.floor(t / PERIOD);
  const phase = t / PERIOD - k;
  const who = seats[(s.first + k * 3) % seats.length]!;
  let swell = 0;
  // with the hub left out (a real mark sits there), the spoke and packet stop short of the centre
  const reach = s.hub ? 1 : 0.6;
  if (phase < 0.6) {
    line(buf, s, who.x, who.y, who.x + (s.hx - who.x) * reach, who.y + (s.hy - who.y) * reach, 0.3);
    const p = ease(phase / 0.6) * reach;
    for (let tr = 3; tr >= 0; tr--) {
      const q = Math.max(0, p - tr * 0.035);
      const x = who.x + (s.hx - who.x) * q;
      const y = who.y + (s.hy - who.y) * q;
      const i = put(buf, s, Math.floor(x), Math.floor(y / s.aspect), tr === 0 ? 0.95 : 0.6 - tr * 0.12);
      if (tr === 0 && i >= 0) f.hot[i] = 1;
    }
  } else swell = Math.sin(Math.PI * ((phase - 0.6) / 0.4));

  // nodes keep their size to the ring, so a short band is not all hub
  const z = Math.max(0.55, Math.min(1.3, s.R / 20));
  for (const p of seats) node(buf, s, p.x, p.y, (1.6 + 0.9 * p.near) * z, 0.42 + 0.4 * p.near);
  if (s.hub) {
    node(buf, s, s.hx, s.hy, (3.2 + 0.8 * swell) * z, 0.92 + 0.08 * swell);
    const core = put(buf, s, Math.floor(s.hx), Math.floor(s.hy / s.aspect), 1);
    if (core >= 0) f.hot[core] = 1;
  }

  const top = RAMP.length - 1;
  for (let i = 0; i < n; i++) f.level[i] = Math.min(top, Math.floor(Math.max(0, buf[i]!) * RAMP.length));
  return f;
}

/**
 * Decides which animation frames draw: at most `fps` a second, and under
 * reduced motion only the first one.
 */
export class Pacer {
  private last = -Infinity;
  private drawn = false;
  constructor(
    private fps: number,
    private still: boolean,
  ) {}
  due(now: number): boolean {
    if (this.still) {
      if (this.drawn) return false;
      this.drawn = true;
      return true;
    }
    // 1ms slack so a 60Hz display draws every third frame, not every fourth
    if (now - this.last < 1000 / this.fps - 1) return false;
    this.last = now;
    return true;
  }
}
