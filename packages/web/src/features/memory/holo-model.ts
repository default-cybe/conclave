/**
 * Memory > Map, 3D view (HoloCanvas.tsx): where every item sits in space,
 * and how each real link bends. Pure, no three.js, so
 * test/memory-map.test.ts checks it and it costs nothing until the view
 * opens.
 *
 * Two layouts, after Constellate (github.com/JCarterJohnson/constellate):
 *
 * Clusters: the core (the whole memory) in the middle and each area a
 * constellation on a sphere around it, high and low as well as round:
 * areas start on a golden spiral in areaChain order, then settle with the
 * areas they share links with pulled together and the rest pushed apart;
 * the sphere is turned so areas written more recently sit higher. Inside
 * its ball an item's height is its recency in the area (newer higher,
 * undated lowest), its bearing starts on a golden spiral, leans toward the
 * areas it links to and is relaxed toward its linked neighbours a few
 * rounds, so related items sit together; the most linked sit nearest the
 * middle of the ball. Settled once per graph and cached by the caller.
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
    // balls by the cube root of their count, on a sphere wide enough that none touch
    for (let a = 0; a < A; a++) radius[a] = 8 + 9 * Math.cbrt(size(a));
    const unit = areaSphere(L, chain, at);
    let R = CORE_R * 2 + Math.max(...radius);
    for (let a = 0; a < A; a++)
      for (let b = a + 1; b < A; b++) {
        const d = Math.hypot(unit[a * 3] - unit[b * 3], unit[a * 3 + 1] - unit[b * 3 + 1], unit[a * 3 + 2] - unit[b * 3 + 2]);
        R = Math.max(R, ((radius[a] + radius[b]) * 1.35) / Math.max(d, 0.05));
      }
    for (let k = 0; k < A * 3; k++) centers[k] = unit[k] * R;
    // height inside a ball: recency in its area, -1 oldest (and undated) to 1 newest
    const h = new Float32Array(n);
    for (let a = 0; a < A; a++) {
      const { from, to } = L.areas[a];
      const ids = Array.from({ length: to - from }, (_, k) => from + k).sort((x, y) => at[x] - at[y] || x - y);
      ids.forEach((i, rank) => (h[i] = ids.length > 1 ? (2 * rank) / (ids.length - 1) - 1 : 0));
    }
    const dir = new Float32Array(n * 3);
    for (let a = 0; a < A; a++) {
      const { from, to } = L.areas[a];
      for (let i = from; i < to; i++) {
        // a golden spiral round the ball, in the item's place by degree
        const k = i - from;
        dir.set([Math.cos(k * GOLD), 0, Math.sin(k * GOLD)], i * 3);
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
    // the most linked nearest the middle of the ball: radius by degree rank, as evenly filled as a ball is;
    // height mostly by recency (an even y on a sphere covers it evenly), a little from the relaxed direction
    for (let a = 0; a < A; a++) {
      const { from, to } = L.areas[a];
      const ids = Array.from({ length: to - from }, (_, k) => from + k).sort((x, y) => deg[y] - deg[x] || x - y);
      ids.forEach((i, rank) => {
        const r = radius[a] * (0.12 + 0.88 * Math.cbrt((rank + 0.5) / ids.length));
        const y = Math.max(-0.98, Math.min(0.98, 0.85 * h[i] + 0.15 * dir[i * 3 + 1]));
        // bearing: the relaxed one, with some of the spiral's kept so a big hub's neighbours do not collapse onto a few meridians
        const k = i - from;
        const bx = dir[i * 3] + 0.7 * Math.cos(k * GOLD);
        const bz = dir[i * 3 + 2] + 0.7 * Math.sin(k * GOLD);
        const s = Math.sqrt(1 - y * y) / (Math.hypot(bx, bz) || 1);
        pos[i * 3] = centers[a * 3] + bx * s * r;
        pos[i * 3 + 1] = centers[a * 3 + 1] + y * r;
        pos[i * 3 + 2] = centers[a * 3 + 2] + bz * s * r;
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

/**
 * Clusters: each area's direction from the core, unit vectors. A golden
 * spiral in areaChain order, then 160 rounds where areas sharing links pull
 * together and every pair pushes apart, kept on the sphere; finally flipped
 * upside down if that puts the more recently written areas higher.
 */
function areaSphere(L: LinkLayout, chain: number[], at: Float64Array): Float32Array {
  const A = L.areas.length;
  const u = new Float32Array(A * 3);
  chain.forEach((a, k) => {
    const y = A > 1 ? 1 - (2 * (k + 0.5)) / A : 0;
    const r = Math.sqrt(1 - y * y);
    u.set([Math.cos(k * GOLD) * r, y, Math.sin(k * GOLD) * r], a * 3);
  });
  if (A < 2) return u;
  const W = Array.from({ length: A }, () => new Float64Array(A));
  let top = 0;
  for (const e of L.edges) {
    const x = L.items[e.a].area;
    const y = L.items[e.b].area;
    if (x !== y) (W[x][y]++, W[y][x]++, (top = Math.max(top, W[x][y])));
  }
  const f = new Float64Array(A * 3);
  for (let round = 0; round < 160; round++) {
    f.fill(0);
    for (let a = 0; a < A; a++)
      for (let b = 0; b < A; b++) {
        if (a === b) continue;
        const d = [0, 1, 2].map((c) => u[b * 3 + c] - u[a * 3 + c]);
        const len = Math.hypot(d[0], d[1], d[2]) || 1e-3;
        // pull by shared links (strongest pair 1, square root so a few big pairs do not take over), push by 1/d^2
        const k = (top ? 0.3 * Math.sqrt(W[a][b] / top) : 0) * len - 0.1 / (len * len);
        for (let c = 0; c < 3; c++) f[a * 3 + c] += (k * d[c]) / len;
      }
    for (let a = 0; a < A; a++) for (let c = 0; c < 3; c++) u[a * 3 + c] += 0.05 * f[a * 3 + c];
    // keep the whole sphere in use: linked groups would otherwise crowd one side
    for (let c = 0; c < 3; c++) {
      let m = 0;
      for (let a = 0; a < A; a++) m += u[a * 3 + c] / A;
      for (let a = 0; a < A; a++) u[a * 3 + c] -= m;
    }
    for (let a = 0; a < A; a++) normalize(u, a);
  }
  // newer areas up: compare each area's mean write time with its height
  const mean = L.areas.map((ar) => {
    let s = 0;
    let m = 0;
    for (let i = ar.from; i < ar.to; i++) if (at[i]) ((s += at[i]), m++);
    return m ? s / m : 0;
  });
  const dated = mean.filter(Boolean);
  const avg = dated.reduce((s, t) => s + t, 0) / (dated.length || 1);
  let cov = 0;
  for (let a = 0; a < A; a++) if (mean[a]) cov += (mean[a] - avg) * u[a * 3 + 1];
  if (cov < 0) for (let a = 0; a < A; a++) (u[a * 3 + 1] *= -1);
  return u;
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
