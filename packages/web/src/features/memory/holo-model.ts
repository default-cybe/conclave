/**
 * Memory > Map, 3D view (HoloCanvas.tsx): where every item sits in space,
 * and how each real link bends. Pure, no three.js, so
 * test/memory-map.test.ts checks it and it costs nothing until the view
 * opens.
 *
 * Two layouts, after Constellate (github.com/JCarterJohnson/constellate):
 *
 * Clusters: the core (the whole memory) in the middle and each area a
 * constellation around it on a gently tilted ring, ordered so the most
 * linked areas sit side by side (areaChain). Inside its ball an item's
 * direction starts on a golden spiral, leans toward the areas it links to,
 * then is relaxed toward its linked neighbours a few rounds, so related
 * items sit together; the most linked sit nearest the middle of the ball.
 * Settled once per graph and cached by the caller.
 *
 * Timeline: time runs along x, oldest left. x mixes the real date and the
 * date's rank half and half, so quiet months still show as gaps but a busy
 * week does not take the whole axis; items with no date wait just before
 * the start. Areas are lanes around the axis, each at its own angle.
 *
 * Links: only real ones (LinkLayout.edges). A link inside an area bows
 * gently toward its area; one across areas bends through the core
 * (Clusters) or the time spine (Timeline), so links between the same two
 * areas run together instead of a hairball.
 */
import type { MemoryGraphNode } from '@conclave/core/client';
import type { LinkLayout } from './link-model';
import { areaChain } from './ring-model';

export type HoloMode = 'clusters' | 'timeline';
/** The core's radius, world units. */
export const CORE_R = 60;
/** Timeline: the axis length. */
export const SPAN = 1800;
const TAU = Math.PI * 2;
const GOLD = Math.PI * (3 - Math.sqrt(5));

export interface HoloLayout {
  mode: HoloMode;
  /** x, y, z per item (LinkLayout.items index). */
  pos: Float32Array;
  /** Per area (LinkLayout.areas index): where its label hangs, and its ball's radius (Clusters) or lane's (Timeline). */
  centers: Float32Array;
  radius: Float32Array;
  /** Radius of a sphere that holds everything, around the origin. */
  extent: number;
  /** Timeline: dated items' times sorted, and the span. */
  times: Float64Array;
  lo: number;
  hi: number;
  /** Timeline: month starts along the axis. */
  ticks: Array<{ x: number; t: number; label: string; year: boolean }>;
}

/** A small stable hash in [0, 1). */
const hash = (i: number, s: number) => {
  let x = (i * 374761393 + s * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

export function layoutHolo(L: LinkLayout, nodes: readonly MemoryGraphNode[], mode: HoloMode): HoloLayout {
  const n = L.items.length;
  const A = L.areas.length;
  const pos = new Float32Array(n * 3);
  const centers = new Float32Array(A * 3);
  const radius = new Float32Array(A);
  const deg = Float64Array.from(L.items, (it) => nodes[it.node]?.degree ?? 0);
  const at = Float64Array.from(L.items, (it) => nodes[it.node]?.at ?? 0);
  const chain = areaChain(L);
  const size = (a: number) => Math.max(1, L.areas[a].to - L.areas[a].from);
  const dated = [...at].filter((t) => t > 0).sort((x, y) => x - y);
  const times = Float64Array.from(dated);
  const lo = times[0] ?? 0;
  const hi = times.at(-1) ?? 1;
  let extent = 0;

  if (mode === 'clusters') {
    // balls by the cube root of their count, on a ring wide enough that none touch
    for (let a = 0; a < A; a++) radius[a] = 8 + 9 * Math.cbrt(size(a));
    const room = chain.reduce((s, a) => s + 2 * radius[a] * 1.7, 0);
    const R = Math.max(CORE_R * 3 + Math.max(...radius), room / TAU);
    let arc = 0;
    chain.forEach((a, k) => {
      const th = ((arc + radius[a] * 1.7) / room) * TAU;
      arc += 2 * radius[a] * 1.7;
      // a gentle wave up and down, so the ring has depth from any side
      const y = Math.sin(k * 2.4) * R * 0.14;
      centers.set([Math.cos(th) * R, y, Math.sin(th) * R], a * 3);
    });
    const dir = new Float32Array(n * 3);
    for (let a = 0; a < A; a++) {
      const { from, to } = L.areas[a];
      for (let i = from; i < to; i++) {
        // a golden spiral over the ball, in the item's place by degree
        const k = i - from;
        const m = to - from;
        const y = 1 - (2 * (k + 0.5)) / m;
        const r = Math.sqrt(1 - y * y);
        dir.set([Math.cos(k * GOLD) * r, y, Math.sin(k * GOLD) * r], i * 3);
      }
    }
    // lean toward the areas an item links to
    const bias = new Float32Array(n * 3);
    for (const e of L.edges) {
      if (!e.cross) continue;
      for (const [u, v] of [[e.a, e.b], [e.b, e.a]] as const) {
        const ca = L.items[u].area * 3;
        const cb = L.items[v].area * 3;
        const dx = centers[cb] - centers[ca];
        const dy = centers[cb + 1] - centers[ca + 1];
        const dz = centers[cb + 2] - centers[ca + 2];
        const d = Math.hypot(dx, dy, dz) || 1;
        bias[u * 3] += dx / d;
        bias[u * 3 + 1] += dy / d;
        bias[u * 3 + 2] += dz / d;
      }
    }
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(bias[i * 3], bias[i * 3 + 1], bias[i * 3 + 2]);
      if (d) for (let c = 0; c < 3; c++) dir[i * 3 + c] += (0.9 * bias[i * 3 + c]) / d;
      normalize(dir, i);
    }
    // relax toward linked neighbours in the same area
    const acc = new Float32Array(n * 3);
    const cnt = new Float32Array(n);
    for (let round = 0; round < 6; round++) {
      acc.fill(0);
      cnt.fill(0);
      for (const e of L.edges) {
        if (e.cross) continue;
        for (const [u, v] of [[e.a, e.b], [e.b, e.a]] as const) {
          for (let c = 0; c < 3; c++) acc[u * 3 + c] += dir[v * 3 + c];
          cnt[u]++;
        }
      }
      for (let i = 0; i < n; i++) {
        if (!cnt[i]) continue;
        for (let c = 0; c < 3; c++) dir[i * 3 + c] += (0.45 * acc[i * 3 + c]) / cnt[i];
        normalize(dir, i);
      }
    }
    // the most linked nearest the middle of the ball: radius by degree rank, as evenly filled as a ball is
    for (let a = 0; a < A; a++) {
      const { from, to } = L.areas[a];
      const ids = Array.from({ length: to - from }, (_, k) => from + k).sort((x, y) => deg[y] - deg[x] || x - y);
      ids.forEach((i, rank) => {
        const r = radius[a] * (0.12 + 0.88 * Math.cbrt((rank + 0.5) / ids.length));
        for (let c = 0; c < 3; c++) pos[i * 3 + c] = centers[a * 3 + c] + dir[i * 3 + c] * r;
      });
      extent = Math.max(extent, Math.hypot(centers[a * 3], centers[a * 3 + 1], centers[a * 3 + 2]) + radius[a]);
    }
  } else {
    const ticks = monthTicks(lo, hi);
    const ring = 210;
    const lane = new Float64Array(A);
    chain.forEach((a, k) => (lane[a] = (k / A) * TAU));
    for (let i = 0; i < n; i++) {
      const a = L.items[i].area;
      const x = at[i] ? timeX(times, lo, hi, at[i]) : -SPAN / 2 - 70 - hash(i, 3) * 40;
      // hubs ride close to the axis; the rest fill the lane
      const rho = 40 + (ring - 40) * Math.sqrt(hash(i, 1)) / (1 + 0.12 * Math.log2(1 + deg[i]));
      const th = lane[a] + (hash(i, 2) - 0.5) * (TAU / A) * 0.8;
      pos.set([x, Math.cos(th) * rho, Math.sin(th) * rho], i * 3);
    }
    for (let a = 0; a < A; a++) {
      radius[a] = ring;
      // lane names at the oldest end, where a flight along history starts
      centers.set([-SPAN / 2 - 40, Math.cos(lane[a]) * (ring + 40), Math.sin(lane[a]) * (ring + 40)], a * 3);
    }
    extent = SPAN / 2 + 120;
    return { mode, pos, centers, radius, extent, times, lo, hi, ticks: ticks.map((t) => ({ ...t, x: timeX(times, lo, hi, t.t) })) };
  }
  return { mode, pos, centers, radius, extent, times, lo, hi, ticks: [] };
}

function normalize(v: Float32Array, i: number) {
  const d = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]) || 1;
  for (let c = 0; c < 3; c++) v[i * 3 + c] /= d;
}

/** Timeline x of a time: half its place in the span, half its rank among the dated items. */
export function timeX(times: Float64Array, lo: number, hi: number, t: number): number {
  let a = 0;
  let b = times.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (times[m] < t) a = m + 1;
    else b = m;
  }
  const lin = hi > lo ? (t - lo) / (hi - lo) : 0.5;
  const rank = times.length > 1 ? a / (times.length - 1) : 0.5;
  return -SPAN / 2 + (0.5 * Math.max(0, Math.min(1, lin)) + 0.5 * Math.min(1, rank)) * SPAN;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthTicks(lo: number, hi: number): Array<{ t: number; label: string; year: boolean }> {
  const out: Array<{ t: number; label: string; year: boolean }> = [];
  if (!(hi > lo)) return out;
  const d = new Date(lo);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  for (d.setMonth(d.getMonth() + 1); d.getTime() < hi && out.length < 240; d.setMonth(d.getMonth() + 1)) {
    const year = d.getMonth() === 0;
    out.push({ t: d.getTime(), label: year ? String(d.getFullYear()) : `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`, year });
  }
  return out;
}

/**
 * The links to draw: the ones the filters leave, and on a small screen at
 * most `cap` of them, those between the most linked items first.
 */
export function pickEdges(L: LinkLayout, on: readonly boolean[], cap: number, deg: ArrayLike<number>): Int32Array {
  const ids: number[] = [];
  for (let e = 0; e < L.edges.length; e++) if (on[e]) ids.push(e);
  if (ids.length <= cap) return Int32Array.from(ids);
  const w = (e: number) => deg[L.edges[e].a] + deg[L.edges[e].b];
  return Int32Array.from(ids.sort((x, y) => w(y) - w(x) || x - y).slice(0, cap)).sort();
}

/**
 * One link as `seg` straight pieces of a quadratic curve, written into
 * `out` at `o` as line-segment pairs (2 * seg points, 6 * seg floats).
 */
export function linkCurve(h: HoloLayout, L: LinkLayout, e: number, seg: number, out: Float32Array, o: number): void {
  const E = L.edges[e];
  const p = h.pos;
  const a = E.a * 3;
  const b = E.b * 3;
  const mx = (p[a] + p[b]) / 2;
  const my = (p[a + 1] + p[b + 1]) / 2;
  const mz = (p[a + 2] + p[b + 2]) / 2;
  let cx: number;
  let cy: number;
  let cz: number;
  if (h.mode === 'clusters') {
    const ca = L.items[E.a].area * 3;
    const cb = L.items[E.b].area * 3;
    // across: through the core, near the middle of the two areas; inside: bowed toward the area's middle
    const k = E.cross ? 0.32 : 0.5;
    const tx = E.cross ? (h.centers[ca] + h.centers[cb]) / 2 : h.centers[ca];
    const ty = E.cross ? (h.centers[ca + 1] + h.centers[cb + 1]) / 2 : h.centers[ca + 1];
    const tz = E.cross ? (h.centers[ca + 2] + h.centers[cb + 2]) / 2 : h.centers[ca + 2];
    cx = E.cross ? tx * k : mx + (tx - mx) * k;
    cy = E.cross ? ty * k : my + (ty - my) * k;
    cz = E.cross ? tz * k : mz + (tz - mz) * k;
  } else {
    // across: through the time spine; inside: a little toward it
    const k = E.cross ? 0.12 : 0.6;
    cx = mx;
    cy = my * k;
    cz = mz * k;
  }
  let px = p[a];
  let py = p[a + 1];
  let pz = p[a + 2];
  for (let s = 1; s <= seg; s++) {
    const t = s / seg;
    const u = 1 - t;
    const x = u * u * p[a] + 2 * u * t * cx + t * t * p[b];
    const y = u * u * p[a + 1] + 2 * u * t * cy + t * t * p[b + 1];
    const z = u * u * p[a + 2] + 2 * u * t * cz + t * t * p[b + 2];
    out[o++] = px;
    out[o++] = py;
    out[o++] = pz;
    out[o++] = x;
    out[o++] = y;
    out[o++] = z;
    px = x;
    py = y;
    pz = z;
  }
}

export interface HoloStats {
  items: number;
  links: number;
  cross: number;
  last?: number;
}

/** The readouts: items still shown, links drawn, how many cross areas, the last write. */
export function holoStats(L: LinkLayout, nodes: readonly MemoryGraphNode[], on: readonly boolean[], gone: (node: number) => boolean): HoloStats {
  let items = 0;
  let last = 0;
  for (const it of L.items) {
    if (gone(it.node)) continue;
    items++;
    last = Math.max(last, nodes[it.node]?.at ?? 0);
  }
  let links = 0;
  let cross = 0;
  L.edges.forEach((e, k) => on[k] && (links++, e.cross && cross++));
  return { items, links, cross, last: last || undefined };
}
