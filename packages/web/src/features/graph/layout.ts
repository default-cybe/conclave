/**
 * Where each node of a workflow graph sits (docs/design/VISUAL-PROGRAMMING.md 7.5).
 * Statement order runs left to right in phase bands: each run of nodes in the
 * same phase is one band, its nodes stacked top to bottom, wrapping into a new
 * column after ROWS. Workflow graphs are nearly linear, so this reads like the
 * script without a layout library.
 * shortcut: no edge-crossing minimization; add @dagrejs/dagre if real graphs come out tangled.
 */
import type { WorkflowGraph } from '@conclave/core/client';

export const NODE_W = 248;
export const NODE_H = 92;
const ROW_GAP = 20;
const COL_GAP = 64;
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
  const overlaps = s.left < cover.right && s.right > cover.left && s.top < cover.bottom && s.bottom > cover.top;
  if (!overlaps) return undefined;
  const side = cover.left > canvas.left;
  const free = side ? { ...canvas, right: Math.min(canvas.right, cover.left) } : { ...canvas, bottom: Math.max(canvas.top, cover.top) };
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

/** vertical: bands top to bottom with one node per row, for a phone's narrow screen. */
export function layoutGraph(g: WorkflowGraph, vertical = false): Layout {
  const pos = new Map<string, { x: number; y: number }>();
  const bands: Band[] = [];
  const runs: Array<{ title: string; ids: string[] }> = [];
  for (const n of g.nodes) {
    const title = n.phase ?? 'Start';
    const last = runs[runs.length - 1];
    if (last && last.title === title) last.ids.push(n.id);
    else runs.push({ title, ids: [n.id] });
  }
  if (vertical) {
    let y = 0;
    for (const r of runs) {
      r.ids.forEach((id, i) => pos.set(id, { x: BAND_PAD, y: y + BAND_HEAD + i * (NODE_H + ROW_GAP) }));
      const h = BAND_HEAD + r.ids.length * NODE_H + (r.ids.length - 1) * ROW_GAP + BAND_PAD;
      bands.push({ title: r.title, x: 0, y, w: NODE_W + BAND_PAD * 2, h });
      y += h + ROW_GAP;
    }
    return { pos, bands };
  }
  let x = 0;
  for (const r of runs) {
    const cols = Math.ceil(r.ids.length / ROWS);
    const rows = Math.min(ROWS, r.ids.length);
    r.ids.forEach((id, i) => {
      const col = Math.floor(i / ROWS);
      pos.set(id, { x: x + BAND_PAD + col * (NODE_W + COL_GAP), y: BAND_HEAD + (i % ROWS) * (NODE_H + ROW_GAP) });
    });
    const w = BAND_PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP;
    bands.push({ title: r.title, x, y: 0, w, h: BAND_HEAD + rows * NODE_H + (rows - 1) * ROW_GAP + BAND_PAD });
    x += w + BAND_GAP;
  }
  return { pos, bands };
}
