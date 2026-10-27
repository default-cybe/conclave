/**
 * Memory > Map, Brain view (BrainCanvas.tsx): how memories connect across
 * areas, drawn as a brain seen from above. Pure, so test/memory-map.test.ts
 * checks it.
 *
 * Every item sits on the outline of one of two hemispheres, grouped into
 * its area's arc (a lobe). The left hemisphere holds the records, what was
 * said: Conversations (past sessions) and Conclave (Conclave's own
 * memories). The right holds what they are about: people, projects, the
 * homelab, services, courses. In the real graph nearly every link from a
 * record crosses to the right, so the middle carries the thickest tract,
 * like the corpus callosum. Without those two areas the areas alternate
 * between the hemispheres by size.
 *
 * Every real link, and only those, is a curve bundled through the
 * hierarchy (Holten 2006, hierarchical edge bundling): item, its area's
 * anchor, its hemisphere's, the middle when it crosses, then down the
 * other side to the other item. The control points are pulled toward the
 * straight line by 1 - BETA, then drawn as a clamped cubic B-spline, so
 * the curve starts and ends exactly at its items. All of it is computed
 * once per graph; drawing only strokes the stored Bézier points.
 */
import type { MemoryGraph } from '@conclave/core/client';
import type { Indexed } from './graph-model';

/** Areas that are records of what was said: the left hemisphere. */
export const RECORDS = ['Conversations', 'Conclave'];
/** How tightly links bundle: 1 follows the hierarchy, 0 is a straight line. */
export const BETA = 0.85;
/** The outline: half-width and half-height of a hemisphere, and the gap between them (the fissure). */
export const RX = 380;
export const RY = 440;
export const FISSURE = 26;

export interface BrainItem {
  id: string;
  /** Index into MemoryGraph.nodes. */
  node: number;
  area: number;
  side: 1 | -1;
  /** On the outline, and where links leave it (a little inside). */
  x: number;
  y: number;
  ix: number;
  iy: number;
  /** Outward normal, unit length. */
  nx: number;
  ny: number;
  /** Place along its hemisphere's outline, 0 at the top to 1 at the bottom. */
  t: number;
}

export interface BrainArea {
  name: string;
  side: 1 | -1;
  /** Its arc along the hemisphere's outline. */
  t0: number;
  t1: number;
  /** The first and one past the last of its items in BrainLayout.items. */
  from: number;
  to: number;
  /** Where its links gather. */
  ax: number;
  ay: number;
  /** The middle of its arc on the outline, and the normal there. */
  mx: number;
  my: number;
  nx: number;
  ny: number;
}

export interface BrainEdge {
  /** Indexes into BrainLayout.items. */
  a: number;
  b: number;
  label: string;
  /** Its items are in different areas. */
  cross: boolean;
  /** Bézier points: x0, y0, then (c1x, c1y, c2x, c2y, x, y) per segment. */
  pts: Float32Array;
}

export interface BrainLayout {
  items: BrainItem[];
  byId: Map<string, number>;
  areas: BrainArea[];
  edges: BrainEdge[];
  /** Each item's edges, as indexes into edges. */
  edgesOf: number[][];
  /** Hemisphere anchors. */
  hemi: { [s in 1 | -1]: { x: number; y: number; names: string[] } };
  bounds: { x: number; y: number; w: number; h: number };
}

/** A point on a hemisphere's outline at angle th (0 at the top, PI at the bottom). */
const outline = (side: 1 | -1, th: number) => ({ x: side * (FISSURE + RX * Math.sin(th)), y: -RY * Math.cos(th) });

/** Angle for each of n+1 evenly spaced arc lengths along a hemisphere's outline. */
function arcTable(n = 512): Float64Array {
  const len = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const a = outline(1, (Math.PI * (i - 1)) / n);
    const b = outline(1, (Math.PI * i) / n);
    len[i] = len[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

export function layoutBrain(g: MemoryGraph, ix: Indexed): BrainLayout {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  const areaOf = new Map<string, number>();
  ix.areas.forEach((a, i) => a.ids.forEach((id) => areaOf.set(id, i)));

  // links between areas, by count: they order the lobes and the items in them
  const W = ix.areas.map(() => new Float64Array(ix.areas.length));
  const toArea = new Map<string, Float64Array>();
  for (const [a, b] of g.edges) {
    const x = areaOf.get(g.nodes[a]?.id ?? '');
    const y = areaOf.get(g.nodes[b]?.id ?? '');
    if (x === undefined || y === undefined) continue;
    W[x][y]++;
    W[y][x]++;
    for (const [u, v] of [[a, y], [b, x]] as const) {
      const id = g.nodes[u].id;
      const row = toArea.get(id) ?? (toArea.set(id, new Float64Array(ix.areas.length)), toArea.get(id)!);
      row[v]++;
    }
  }

  // hemispheres: the records on the left; otherwise alternate by size
  const names = ix.areas.map((a) => a.name);
  const records = names.some((n) => RECORDS.includes(n));
  const sideOf = (i: number): 1 | -1 => (records ? (RECORDS.includes(names[i]) ? -1 : 1) : i % 2 ? -1 : 1);
  const order = (side: 1 | -1): number[] => {
    // a chain: each next lobe is the one most linked to the last, so neighbours share tracts
    const left = names.map((_, i) => i).filter((i) => sideOf(i) === side);
    const out: number[] = [];
    while (left.length) {
      const last = out.at(-1);
      let pick = 0;
      if (last !== undefined) for (let j = 1; j < left.length; j++) if (W[last][left[j]] > W[last][left[pick]]) pick = j;
      out.push(left.splice(pick, 1)[0]);
    }
    return out;
  };

  const table = arcTable();
  const total = table[table.length - 1];
  const thAt = (t: number) => {
    // the angle at fraction t of the arc length
    const want = t * total;
    let lo = 0;
    let hi = table.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid] < want) lo = mid;
      else hi = mid;
    }
    const f = (want - table[lo]) / Math.max(1e-9, table[hi] - table[lo]);
    return (Math.PI * (lo + f)) / (table.length - 1);
  };
  const normal = (side: 1 | -1, th: number) => {
    const x = side * Math.sin(th) / RX;
    const y = -Math.cos(th) / RY;
    const d = Math.hypot(x, y) || 1;
    return { nx: x / d, ny: y / d };
  };

  const items: BrainItem[] = [];
  const areas: BrainArea[] = new Array(names.length);
  const hemi = { [1]: { x: FISSURE + RX * 0.42, y: 0, names: [] as string[] }, [-1]: { x: -(FISSURE + RX * 0.42), y: 0, names: [] as string[] } } as BrainLayout['hemi'];
  const lobesOf = { [-1]: order(-1), [1]: order(1) } as Record<1 | -1, number[]>;
  // how far down each lobe sits, roughly: items line up by the lobe they link to most, so their curves run side by side
  const lobeY = new Float64Array(names.length);
  for (const side of [-1, 1] as const) {
    const n = lobesOf[side].reduce((s, i) => s + ix.areas[i].ids.length, 0) || 1;
    let c = 0;
    for (const i of lobesOf[side]) (lobeY[i] = -Math.cos(Math.PI * ((c + ix.areas[i].ids.length / 2) / n))), (c += ix.areas[i].ids.length);
  }
  for (const side of [-1, 1] as const) {
    const lobes = lobesOf[side];
    hemi[side].names = lobes.map((i) => names[i]);
    const n = lobes.reduce((s, i) => s + ix.areas[i].ids.length, 0);
    // empty room between lobes and at the two ends, in item slots
    const gap = Math.max(4, Math.round(n * 0.014));
    const slots = n + gap * (lobes.length - 1) + 2 * gap;
    let slot = gap;
    for (const i of lobes) {
      const rank = (id: string) => {
        const row = toArea.get(id);
        let best = -1;
        if (row) for (let j = 0; j < row.length; j++) if (j !== i && row[j] > 0 && (best < 0 || row[j] > row[best])) best = j;
        return best < 0 ? 2 : lobeY[best];
      };
      const ids = [...ix.areas[i].ids].sort((a, b) => rank(a) - rank(b) || (ix.byId.get(b)!.degree - ix.byId.get(a)!.degree));
      const from = items.length;
      const t0 = slot / slots;
      for (const id of ids) {
        const t = (slot + 0.5) / slots;
        const th = thAt(t);
        const p = outline(side, th);
        const nrm = normal(side, th);
        items.push({ id, node: index.get(id)!, area: i, side, x: p.x, y: p.y, ix: p.x - nrm.nx * 3, iy: p.y - nrm.ny * 3, ...nrm, t });
        slot++;
      }
      const t1 = slot / slots;
      const mid = outline(side, thAt((t0 + t1) / 2));
      const nrm = normal(side, thAt((t0 + t1) / 2));
      const h = hemi[side];
      areas[i] = { name: names[i], side, t0, t1, from, to: items.length, ax: h.x + (mid.x - h.x) * 0.5, ay: h.y + (mid.y - h.y) * 0.5, mx: mid.x, my: mid.y, ...nrm };
      slot += gap;
    }
  }
  const byId = new Map(items.map((it, i) => [it.id, i]));
  const at = new Int32Array(g.nodes.length).fill(-1);
  items.forEach((it, i) => (at[it.node] = i));
  const edges: BrainEdge[] = [];
  const edgesOf: number[][] = items.map(() => []);
  for (const [a, b, l] of g.edges) {
    const ia = at[a];
    const ib = at[b];
    if (ia < 0 || ib < 0 || ia === ib) continue;
    const A = items[ia];
    const B = items[ib];
    const ctl: Array<[number, number]> = [[A.ix, A.iy], [areas[A.area].ax, areas[A.area].ay]];
    if (A.area !== B.area) {
      ctl.push([hemi[A.side].x, hemi[A.side].y]);
      if (A.side !== B.side) ctl.push([0, 0]);
      ctl.push([hemi[B.side].x, hemi[B.side].y], [areas[B.area].ax, areas[B.area].ay]);
    }
    ctl.push([B.ix, B.iy]);
    edgesOf[ia].push(edges.length);
    edgesOf[ib].push(edges.length);
    edges.push({ a: ia, b: ib, label: g.labels[l], cross: A.area !== B.area, pts: bundle(ctl) });
  }
  const r = { x: -(FISSURE + RX), y: -RY, w: 2 * (FISSURE + RX), h: 2 * RY };
  return { items, byId, areas, edges, edgesOf, hemi, bounds: r };
}

/**
 * A bundled curve through control points: straightened by BETA (Holten),
 * then a cubic B-spline with its ends repeated so it starts and ends on
 * them, as Bézier segments.
 */
export function bundle(ctl: Array<[number, number]>, beta = BETA): Float32Array {
  const n = ctl.length;
  const [x0, y0] = ctl[0];
  const [x1, y1] = ctl[n - 1];
  const s = ctl.map(([x, y], i) => {
    const f = i / (n - 1);
    return [beta * x + (1 - beta) * (x0 + f * (x1 - x0)), beta * y + (1 - beta) * (y0 + f * (y1 - y0))] as const;
  });
  const p = [s[0], s[0], ...s, s[n - 1], s[n - 1]];
  const out = new Float32Array(2 + 6 * (p.length - 3));
  out[0] = s[0][0];
  out[1] = s[0][1];
  let o = 2;
  // a uniform cubic B-spline segment over p[i..i+3] as a Bézier: it starts at (a + 4b + c)/6, where the last one ended
  for (let i = 1; i + 2 < p.length; i++) {
    const [b, c, d] = [p[i], p[i + 1], p[i + 2]];
    for (const k of [0, 1]) out[o + k] = (2 * b[k] + c[k]) / 3;
    for (const k of [0, 1]) out[o + 2 + k] = (b[k] + 2 * c[k]) / 3;
    for (const k of [0, 1]) out[o + 4 + k] = (b[k] + 4 * c[k] + d[k]) / 6;
    o += 6;
  }
  return out;
}

/** What the filters leave: relations shown, across areas only, items that existed then and are in the chosen store. */
export interface BrainFilter {
  hidden: ReadonlySet<string>;
  crossOnly: boolean;
  /** An item steps back (and its links go) when this says so: the time scrubber and the store filter. */
  gone?: (node: number) => boolean;
}

export function edgeOn(l: BrainLayout, e: BrainEdge, f: BrainFilter): boolean {
  if (f.hidden.has(e.label)) return false;
  if (f.crossOnly && !e.cross) return false;
  return !f.gone || (!f.gone(l.items[e.a].node) && !f.gone(l.items[e.b].node));
}
