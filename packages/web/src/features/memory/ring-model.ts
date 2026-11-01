/**
 * Memory > Map, Rings view (RingCanvas.tsx): the items and links on
 * concentric rings. Pure, so test/memory-map.test.ts checks it. Also the
 * 3D view's fallback when WebGL is missing.
 *
 * It reuses link-model.ts's items, edges and indexes as they are (so
 * edgeOn, edgesOf, byId and the filters work unchanged) and only gives
 * them places: every item a tick on one circle, grouped into its
 * area's arc and ordered by write time inside it; areas ordered in a chain
 * so the most linked pairs sit side by side; arc length by the square root
 * of the item count so one big area does not take a third of the circle.
 * Every real link, and only those, is bundled (Holten 2006) from its item
 * through its area's anchor, through the core when it crosses areas, to
 * the other item. The rings outside the items (area arcs, the time bezel)
 * are drawn in screen pixels by the canvas, so they keep their spacing at
 * any zoom.
 */
import { bundle, type LinkLayout } from './link-model';
import type { Indexed } from './graph-model';

/** The item ring's radius, in world units. */
export const R = 400;
/** The core in the middle, and where area anchors sit, as fractions of R. */
export const CORE = 0.17;
export const ANCHOR = 0.56;
/** Empty angle between two areas, radians. */
export const GAP = 0.035;
/** The time bezel's seam at the top, where the oldest and newest ends meet, radians. */
export const SEAM = 0.16;
const TAU = Math.PI * 2;
/** Angles start at the top and run clockwise. */
const TOP = -Math.PI / 2;

export interface HudArea {
  /** Index into LinkLayout.areas (and Indexed.areas). */
  i: number;
  name: string;
  /** Its arc on the item ring. */
  a0: number;
  a1: number;
  /** Item indexes (into LinkLayout.items) in arc order, oldest first. */
  items: number[];
  ax: number;
  ay: number;
}

export interface HudLayout {
  /** Per item (LinkLayout.items index): angle and where its tick starts. */
  angle: Float64Array;
  /** Per item: last write, 0 when unknown. */
  at: Float64Array;
  /** Areas in ring order. */
  areas: HudArea[];
  /** ringOf[LinkLayout area index] = index into areas. */
  ringOf: Int32Array;
  /** Per edge (LinkLayout.edges index): its bundled curve, Bézier points as bundle() gives them. */
  pts: Float32Array[];
  /** Items sorted by angle, for hit tests. */
  byAngle: Int32Array;
  /** Time span of the bezel. */
  lo: number;
  hi: number;
  /** Writes per bezel bin, oldest first. */
  bins: Int32Array;
}

export const norm = (a: number) => ((a % TAU) + TAU) % TAU;
/** The bezel angle of a time, and back. */
export const timeAngle = (t: number, lo: number, hi: number) => TOP + SEAM / 2 + ((t - lo) / Math.max(1, hi - lo)) * (TAU - SEAM);
export function angleTime(a: number, lo: number, hi: number): number {
  const f = norm(a - TOP - SEAM / 2) / (TAU - SEAM);
  // the seam: past the newest end clamps to it, before the oldest to it
  if (f > 1) return f > 1 + SEAM / 2 / (TAU - SEAM) ? lo : hi;
  return lo + f * (hi - lo);
}

/** Areas in a chain: start at the biggest, each next the one most linked to the last, so linked areas sit side by side. */
export function areaChain(L: LinkLayout): number[] {
  const A = L.areas.length;
  const W = L.areas.map(() => new Float64Array(A));
  for (const e of L.edges) {
    const x = L.items[e.a].area;
    const y = L.items[e.b].area;
    if (x !== y) (W[x][y]++, W[y][x]++);
  }
  const size = (i: number) => L.areas[i].to - L.areas[i].from;
  const left = L.areas.map((_, i) => i).sort((a, b) => size(b) - size(a));
  const chain: number[] = [];
  while (left.length) {
    const last = chain.at(-1);
    let pick = 0;
    if (last !== undefined) for (let j = 1; j < left.length; j++) if (W[last][left[j]] > W[last][left[pick]]) pick = j;
    chain.push(left.splice(pick, 1)[0]);
  }
  return chain;
}

export function layoutHud(L: LinkLayout, ix: Indexed, nBins = 120): HudLayout {
  const n = L.items.length;
  const at = new Float64Array(n);
  for (let i = 0; i < n; i++) at[i] = ix.byId.get(L.items[i].id)?.at ?? 0;
  const A = L.areas.length;
  const size = (i: number) => L.areas[i].to - L.areas[i].from;
  const chain = areaChain(L);

  // arcs by the square root of the count
  const weight = chain.map((i) => Math.sqrt(Math.max(1, size(i))));
  const total = weight.reduce((s, w) => s + w, 0);
  const room = TAU - GAP * chain.length;
  const angle = new Float64Array(n);
  const areas: HudArea[] = [];
  const ringOf = new Int32Array(A).fill(-1);
  let a = TOP + GAP / 2;
  chain.forEach((i, k) => {
    const span = (weight[k] / total) * room;
    const ids: number[] = [];
    for (let j = L.areas[i].from; j < L.areas[i].to; j++) ids.push(j);
    ids.sort((x, y) => at[x] - at[y] || x - y);
    ids.forEach((j, m) => (angle[j] = a + ((m + 0.5) / ids.length) * span));
    const mid = a + span / 2;
    ringOf[i] = areas.length;
    areas.push({ i, name: L.areas[i].name, a0: a, a1: a + span, items: ids, ax: Math.cos(mid) * R * ANCHOR, ay: Math.sin(mid) * R * ANCHOR });
    a += span + GAP;
  });

  // links leave a little inside the ring
  const pts = L.edges.map((e) => {
    const A0 = L.items[e.a];
    const B0 = L.items[e.b];
    const ri = R - 3;
    const ctl: Array<[number, number]> = [[Math.cos(angle[e.a]) * ri, Math.sin(angle[e.a]) * ri]];
    const pa = areas[ringOf[A0.area]];
    const pb = areas[ringOf[B0.area]];
    ctl.push([pa.ax, pa.ay]);
    if (A0.area !== B0.area) ctl.push([0, 0], [pb.ax, pb.ay]);
    ctl.push([Math.cos(angle[e.b]) * ri, Math.sin(angle[e.b]) * ri]);
    return bundle(ctl);
  });

  const byAngle = Int32Array.from(L.items.map((_, i) => i).sort((x, y) => norm(angle[x]) - norm(angle[y])));

  let lo = Infinity;
  let hi = -Infinity;
  for (const t of at) if (t) (lo = Math.min(lo, t), hi = Math.max(hi, t));
  if (!(hi > lo)) (lo = 0, hi = 1);
  const bins = new Int32Array(nBins);
  for (const t of at) if (t) bins[Math.min(nBins - 1, Math.floor(((t - lo) / (hi - lo)) * nBins))]++;
  return { angle, at, areas, ringOf, pts, byAngle, lo, hi, bins };
}

/** The item whose angle is nearest `a`, within `tol` radians. */
export function itemAtAngle(h: HudLayout, a: number, tol: number): number | undefined {
  const x = norm(a);
  const s = h.byAngle;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (norm(h.angle[s[m]]) < x) lo = m + 1;
    else hi = m;
  }
  let best: number | undefined;
  let bd = tol;
  for (const k of [lo - 1, lo, lo + 1]) {
    const i = s[(k + s.length) % s.length];
    if (i === undefined) continue;
    const d = Math.abs(norm(h.angle[i] - x + Math.PI) - Math.PI);
    if (d <= bd) (bd = d), (best = i);
  }
  return best;
}

/** The ring area at angle `a`, if it falls on an arc. */
export function areaAtAngle(h: HudLayout, a: number): HudArea | undefined {
  return h.areas.find((r) => norm(a - r.a0) <= r.a1 - r.a0);
}
