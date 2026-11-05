/**
 * Where each node of a workflow graph sits (docs/design/VISUAL-PROGRAMMING.md 7.5).
 * Statement order runs left to right in phase bands: each run of nodes in the
 * same phase is one band, and inside it a node sits one column right of the
 * nodes that feed it, so wires run forward. Workflow graphs are nearly
 * linear, so this reads like the script without a layout library.
 * shortcut: no edge-crossing minimization inside a column; add @dagrejs/dagre if real graphs come out tangled.
 */
import type { WorkflowGraph } from '@conclave/core/client';

export const NODE_W = 248;
export const NODE_H = 92;
const ROW_GAP = 20;
// room for a wire and its value label between columns
const COL_GAP = 112;
// the phone's column: room for a value label between rows
const V_GAP = 36;
const BAND_GAP = 56;
const BAND_HEAD = 40;
const BAND_PAD = 16;
const ROWS = 5;

export interface Band {
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  pos: Map<string, { x: number; y: number }>;
  bands: Band[];
}

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * The viewport that moves a node out from under a panel (the inspector) into
 * the part of the canvas the panel leaves free, or undefined when the node is
 * clear already. node is in flow coordinates; canvas and cover are screen
 * rects. A cover starting right of the canvas's left edge is a side panel (the
 * free part is left of it); otherwise it is a bottom sheet (the free part is
 * above it).
 */
export function clearOf(node: { x: number; y: number; w: number; h: number }, vp: { x: number; y: number; zoom: number }, canvas: Rect, cover: Rect, margin = 24): { x: number; y: number; zoom: number } | undefined {
  const s = { left: canvas.left + vp.x + node.x * vp.zoom, top: canvas.top + vp.y + node.y * vp.zoom, right: 0, bottom: 0 };
  s.right = s.left + node.w * vp.zoom;
  s.bottom = s.top + node.h * vp.zoom;
  const side = cover.left > canvas.left;
  const free = side ? { ...canvas, right: Math.min(canvas.right, cover.left) } : { ...canvas, bottom: Math.max(canvas.top, cover.top) };
  // under the panel or off past it (a node just added far right): pan; already in the free part: leave it
  if (s.left >= free.left && s.right <= free.right && s.top >= free.top && s.bottom <= free.bottom) return undefined;
  const shift = (lo: number, hi: number, a: number, b: number) => {
    // already inside the free part on this axis: leave it
    if (a >= lo && b <= hi) return 0;
    let d = 0;
    if (hi - margin < b) d = hi - margin - b;
    // the start edge wins when the free part is smaller than the node
    if (a + d < lo + margin) d = lo + margin - a;
    return d;
  };
  const dx = shift(free.left, free.right, s.left, s.right);
  const dy = shift(free.top, free.bottom, s.top, s.bottom);
  return { x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom };
}

/** The runs of nodes in one phase, in statement order: one band each. */
function phaseRuns(g: WorkflowGraph): Array<{ title: string; ids: string[] }> {
  const runs: Array<{ title: string; ids: string[] }> = [];
  for (const n of g.nodes) {
    const title = n.phase ?? 'Start';
    const last = runs[runs.length - 1];
    if (last && last.title === title) last.ids.push(n.id);
    else runs.push({ title, ids: [n.id] });
  }
  return runs;
}

/**
 * Wide: each band's nodes go in columns by how many wires inside the band
 * lead to them, so every wire runs left to right into the next column (as in
 * ComfyUI and Blueprint); nodes nothing in the band feeds stack in the first
 * column. vertical: one node per row top to bottom, for a phone's narrow screen.
 */
export function layoutGraph(g: WorkflowGraph, vertical = false): Layout {
  const pos = new Map<string, { x: number; y: number }>();
  const bands: Band[] = [];
  const runs = phaseRuns(g);
  if (vertical) {
    let y = 0;
    for (const r of runs) {
      r.ids.forEach((id, i) => pos.set(id, { x: BAND_PAD, y: y + BAND_HEAD + i * (NODE_H + V_GAP) }));
      const h = BAND_HEAD + r.ids.length * NODE_H + (r.ids.length - 1) * V_GAP + BAND_PAD;
      bands.push({ title: r.title, x: 0, y, w: NODE_W + BAND_PAD * 2, h });
      y += h + ROW_GAP;
    }
    return { pos, bands };
  }
  const into = new Map<string, string[]>();
  for (const e of g.edges) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  let x = 0;
  for (const r of runs) {
    const here = new Set(r.ids);
    const depth = new Map<string, number>();
    // statement order: a node's sources inside the band come before it
    for (const id of r.ids) depth.set(id, Math.max(-1, ...(into.get(id) ?? []).filter((f) => here.has(f)).map((f) => depth.get(f) ?? -1)) + 1);
    const cols: string[][] = [];
    for (const id of r.ids) (cols[depth.get(id)!] ??= []).push(id);
    // a column of many independent nodes wraps after ROWS, into columns of its own
    const placed = cols.flatMap((c) => Array.from({ length: Math.ceil(c.length / ROWS) }, (_, k) => c.slice(k * ROWS, (k + 1) * ROWS)));
    placed.forEach((c, ci) => c.forEach((id, ri) => pos.set(id, { x: x + BAND_PAD + ci * (NODE_W + COL_GAP), y: BAND_HEAD + ri * (NODE_H + ROW_GAP) })));
    const rows = Math.max(...placed.map((c) => c.length));
    const w = BAND_PAD * 2 + placed.length * NODE_W + (placed.length - 1) * COL_GAP;
    bands.push({ title: r.title, x, y: 0, w, h: BAND_HEAD + rows * NODE_H + (rows - 1) * ROW_GAP + BAND_PAD });
    x += w + BAND_GAP;
  }
  return { pos, bands };
}

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < NODE_W + 8 && Math.abs(a.y - b.y) < NODE_H + 8;

/**
 * The auto layout with the positions the owner dragged put over it (the
 * layout side file). A dragged node stays inside its own phase's band, left
 * to right (the band grows down, never over the next band), and a node
 * dropped on another one moves down until it is clear. Only the wide layout:
 * the phone keeps its one column.
 */
export function placedGraph(g: WorkflowGraph, vertical: boolean, saved?: Record<string, { x: number; y: number }>): Layout {
  const auto = layoutGraph(g, vertical);
  if (vertical || !saved || !g.nodes.some((n) => saved[n.id])) return auto;
  const pos = new Map(auto.pos);
  const runs = phaseRuns(g);
  const bands = auto.bands.map((b, i) => {
    const ids = runs[i].ids;
    const fixed = ids.filter((id) => !saved[id]).map((id) => pos.get(id)!);
    for (const id of ids) {
      const s = saved[id];
      if (!s) continue;
      // up to the gap before the next band; the last band has room to its right
      const next = auto.bands[i + 1];
      const maxX = Math.max(b.x + b.w - BAND_PAD - NODE_W, next ? next.x - BAND_GAP / 2 - BAND_PAD - NODE_W : Infinity);
      const p = { x: Math.min(Math.max(s.x, b.x + BAND_PAD), maxX), y: Math.max(s.y, BAND_HEAD) };
      while (fixed.some((q) => overlaps(p, q))) p.y = Math.max(...fixed.filter((q) => overlaps(p, q)).map((q) => q.y)) + NODE_H + ROW_GAP;
      fixed.push(p);
      pos.set(id, p);
    }
    const bottom = Math.max(...ids.map((id) => pos.get(id)!.y)) + NODE_H + BAND_PAD;
    const right = Math.max(...ids.map((id) => pos.get(id)!.x)) + NODE_W + BAND_PAD;
    return { ...b, w: Math.max(b.w, right - b.x), h: Math.max(b.h, bottom) };
  });
  return { pos, bands };
}
