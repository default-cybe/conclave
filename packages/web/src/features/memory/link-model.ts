/**
 * Memory > Map, Rings and 3D views: every item once, grouped by area, and
 * every real link once, by index. Pure, so test/memory-map.test.ts checks
 * it. The Rings view (ring-model.ts) and the 3D view (holo-model.ts) give
 * these items their places; the filters here apply to both.
 */
import type { MemoryGraph } from '@conclave/core/client';
import type { Indexed } from './graph-model';

/** How tightly links bundle: 1 follows the hierarchy, 0 is a straight line. */
export const BETA = 0.85;

export interface LinkItem {
  id: string;
  /** Index into MemoryGraph.nodes. */
  node: number;
  /** Index into LinkLayout.areas (and Indexed.areas). */
  area: number;
}

export interface LinkArea {
  name: string;
  /** The first and one past the last of its items in LinkLayout.items. */
  from: number;
  to: number;
}

export interface LinkEdge {
  /** Indexes into LinkLayout.items. */
  a: number;
  b: number;
  label: string;
  /** Its items are in different areas. */
  cross: boolean;
}

export interface LinkLayout {
  items: LinkItem[];
  byId: Map<string, number>;
  areas: LinkArea[];
  edges: LinkEdge[];
  /** Each item's edges, as indexes into edges. */
  edgesOf: number[][];
}

/** Items in area order (Indexed.areas, most linked first inside each), and the real links between them. */
export function layoutLinks(g: MemoryGraph, ix: Indexed): LinkLayout {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  const items: LinkItem[] = [];
  const areas: LinkArea[] = ix.areas.map((a, i) => {
    const from = items.length;
    const ids = [...a.ids].sort((x, y) => ix.byId.get(y)!.degree - ix.byId.get(x)!.degree);
    for (const id of ids) items.push({ id, node: index.get(id)!, area: i });
    return { name: a.name, from, to: items.length };
  });
  const byId = new Map(items.map((it, i) => [it.id, i]));
  const at = new Int32Array(g.nodes.length).fill(-1);
  items.forEach((it, i) => (at[it.node] = i));
  const edges: LinkEdge[] = [];
  const edgesOf: number[][] = items.map(() => []);
  for (const [a, b, l] of g.edges) {
    const ia = at[a];
    const ib = at[b];
    if (ia < 0 || ib < 0 || ia === ib) continue;
    edgesOf[ia].push(edges.length);
    edgesOf[ib].push(edges.length);
    edges.push({ a: ia, b: ib, label: g.labels[l], cross: items[ia].area !== items[ib].area });
  }
  return { items, byId, areas, edges, edgesOf };
}

/**
 * A bundled curve through control points (Holten 2006): straightened by
 * BETA, then a cubic B-spline with its ends repeated so it starts and ends
 * on them, as Bézier segments: x0, y0, then (c1x, c1y, c2x, c2y, x, y) per
 * segment.
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
export interface LinkFilter {
  hidden: ReadonlySet<string>;
  crossOnly: boolean;
  /** An item steps back (and its links go) when this says so: the time scrubber and the store filter. */
  gone?: (node: number) => boolean;
}

export function edgeOn(l: LinkLayout, e: LinkEdge, f: LinkFilter): boolean {
  if (f.hidden.has(e.label)) return false;
  if (f.crossOnly && !e.cross) return false;
  return !f.gone || (!f.gone(l.items[e.a].node) && !f.gone(l.items[e.b].node));
}
