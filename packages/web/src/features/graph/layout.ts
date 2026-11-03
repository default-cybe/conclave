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

export function layoutGraph(g: WorkflowGraph): Layout {
  const pos = new Map<string, { x: number; y: number }>();
  const bands: Band[] = [];
  const runs: Array<{ title: string; ids: string[] }> = [];
  for (const n of g.nodes) {
    const title = n.phase ?? 'Start';
    const last = runs[runs.length - 1];
    if (last && last.title === title) last.ids.push(n.id);
    else runs.push({ title, ids: [n.id] });
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
