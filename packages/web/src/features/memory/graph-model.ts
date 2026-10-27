/**
 * The memory map's words and layout (MemoryMap.tsx), pure so
 * test/memory-map.test.ts checks them. Labels are short titles made the way
 * the Map makes them (features/map/model.ts mapLabel), never ids or slugs.
 */
import type { MemoryGraph, MemoryGraphNode } from '@conclave/core/client';
import { mapLabel } from '@/features/map/model';

export type SourceFilter = 'all' | 'conclave' | 'basic-memory';
export type KindFilter = 'all' | 'fact' | 'procedure' | 'profile' | 'episode' | 'note';

const KIND_WORD: Record<MemoryGraphNode['kind'], string> = { fact: 'Fact', profile: 'Profile', procedure: 'Procedure', episode: 'Episode', note: 'Note', tag: 'Tag', session: 'Session' };

/** "Fact, in Conclave and Basic Memory", "Note in Basic Memory, entities/people". */
export function nodeWords(n: MemoryGraphNode): string {
  if (n.kind === 'tag') return 'Tag two or more memories share';
  if (n.kind === 'session') return 'Session memories came from';
  const where = n.source === 'both' ? 'in Conclave and Basic Memory' : n.source === 'basic-memory' ? 'in Basic Memory' : 'in Conclave';
  const folder = n.kind === 'note' && n.note?.folder ? `, ${n.note.folder}` : '';
  return `${KIND_WORD[n.kind]} ${where}${folder}`;
}

/** A short name: 2 to 5 words, no ids, dates or slugs. A tag reads as the tag. */
export function nodeLabel(n: MemoryGraphNode): string {
  if (n.kind === 'tag') return `#${n.title}`;
  const base = n.title.replace(/^the (user|owner)('s)?\s+/i, '');
  const l = mapLabel({ title: base, kind: 'chat', agent: undefined, cwd: undefined });
  return l === 'Chat' ? KIND_WORD[n.kind] : l;
}

/** The line over the map: what is drawn and what is missing. */
export function statusLine(g: MemoryGraph, shown: number): string {
  const parts = [`${shown.toLocaleString('en-US')} of ${g.total.toLocaleString('en-US')} items`];
  if (g.total > g.nodes.length) parts.push(`the ${g.limit.toLocaleString('en-US')} with the most links`);
  if (g.basicMemory.state === 'offline') parts.push(`${g.basicMemory.name ?? 'Basic Memory'} is offline, so only Conclave memory is shown`);
  if (g.basicMemory.state === 'none') parts.push('no Basic Memory connection');
  return parts.join(', ') + '.';
}

/** Filters and search. Tags and sessions stay while a node they link is shown. */
export function visibleIds(g: MemoryGraph, f: { source: SourceFilter; kind: KindFilter; q: string }): Set<string> {
  const q = f.q.trim().toLowerCase();
  const keep = new Set<string>();
  for (const n of g.nodes) {
    if (n.kind === 'tag' || n.kind === 'session') continue;
    if (f.source !== 'all' && n.source !== f.source && n.source !== 'both') continue;
    if (f.kind !== 'all' && n.kind !== f.kind) continue;
    if (q && !n.title.toLowerCase().includes(q) && !(n.note?.path.toLowerCase().includes(q) ?? false)) continue;
    keep.add(n.id);
  }
  if (f.source === 'basic-memory') return keep;
  const hubs: string[] = [];
  for (const e of g.edges)
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ])
      if (keep.has(a) && (b.startsWith('tag:') || b.startsWith('ses:'))) hubs.push(b);
  for (const h of hubs) keep.add(h);
  return keep;
}

export interface Placed {
  x: number;
  y: number;
  r: number;
}

/** Nodes the map asks for at first open; Show more asks for the next step (the endpoint's caps are 300 and 1,000). */
export const FIRST_LIMIT = 150;
export const MORE_LIMITS = [300, 1000];
export function nextLimit(limit: number, total: number): number | undefined {
  return total > limit ? MORE_LIMITS.find((l) => l > limit) : undefined;
}

/** A mark's radius on screen at zoom k (marks grow slower than the zoom). */
export const markRadius = (r: number, k: number) => r * Math.sqrt(k);
const LABEL_H = 16;
const CHAR_W = 6.6;

/** How many labels the map tries at zoom k: more as the owner zooms in. */
export const labelBudget = (k: number) => Math.min(80, Math.max(10, Math.round(16 * k)));

/**
 * Which labels to draw: candidates in order (the caller puts the selected
 * node and its links first, then the rest by links), each placed only when
 * its box on screen hits no box already placed. Two labels never overlap;
 * the rest keep their tooltip. With `view` (pan offset and box size) a label
 * that would run past the edge of the map is left out too.
 */
export function placeLabels(cands: Array<{ id: string; text: string }>, pos: Map<string, Placed>, k: number, max: number, view?: { x: number; y: number; w: number; h: number }): Set<string> {
  const boxes: Array<[number, number, number, number]> = [];
  const out = new Set<string>();
  for (const c of cands) {
    if (out.size >= max) break;
    const p = pos.get(c.id);
    if (!p || out.has(c.id)) continue;
    const x0 = p.x * k + markRadius(p.r, k) + 4;
    const y0 = p.y * k - LABEL_H / 2;
    const b: [number, number, number, number] = [x0, y0, x0 + c.text.length * CHAR_W + 4, y0 + LABEL_H];
    if (view && (b[0] + view.x < 0 || b[2] + view.x > view.w || b[1] + view.y < 0 || b[3] + view.y > view.h)) continue;
    if (boxes.some((o) => b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3])) continue;
    boxes.push(b);
    out.add(c.id);
  }
  return out;
}

/**
 * Positions: a few hundred steps of a plain force layout (links pull,
 * everyone pushes harder the bigger the two marks are, a weak pull to the
 * middle, and marks never sit on each other), from a fixed spiral start so
 * the same graph always lands the same way. Positions do not move after.
 */
export function layoutGraph(g: MemoryGraph, steps = 300): Map<string, Placed> {
  const ns = [...g.nodes].sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
  const idx = new Map(ns.map((n, i) => [n.id, i]));
  const N = ns.length;
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const r = ns.map((n) => (n.kind === 'tag' || n.kind === 'session' ? 4 : 4 + Math.min(10, Math.sqrt(n.degree) * 1.6)));
  for (let i = 0; i < N; i++) {
    const a = i * 2.39996;
    const d = 18 * Math.sqrt(i + 1);
    x[i] = Math.cos(a) * d;
    y[i] = Math.sin(a) * d;
  }
  const links = g.edges.map((e) => [idx.get(e.from), idx.get(e.to)]).filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined);
  for (let s = 0; s < steps; s++) {
    const t = 1 - s / steps;
    const dx = new Float64Array(N);
    const dy = new Float64Array(N);
    // shortcut: O(n^2) repulsion, fine for the 1,000 node cap; a quadtree when the cap grows
    for (let i = 0; i < N; i++)
      for (let j = i + 1; j < N; j++) {
        const ux = x[i] - x[j];
        const uy = y[i] - y[j];
        const d2 = ux * ux + uy * uy + 0.01;
        if (d2 > 360_000) continue;
        const gap = r[i] + r[j] + 10;
        // size-aware push, and a hard shove when two marks touch
        const f = (2600 * (1 + (r[i] + r[j]) / 10)) / d2 + (d2 < gap * gap ? 0.5 / Math.sqrt(d2) : 0);
        dx[i] += ux * f;
        dy[i] += uy * f;
        dx[j] -= ux * f;
        dy[j] -= uy * f;
      }
    for (const [a, b] of links) {
      const ux = x[b] - x[a];
      const uy = y[b] - y[a];
      const d = Math.sqrt(ux * ux + uy * uy) || 1;
      const f = (d - (60 + r[a] + r[b])) * 0.03;
      dx[a] += (ux / d) * f;
      dy[a] += (uy / d) * f;
      dx[b] -= (ux / d) * f;
      dy[b] -= (uy / d) * f;
    }
    for (let i = 0; i < N; i++) {
      dx[i] -= x[i] * 0.006;
      dy[i] -= y[i] * 0.006;
      const m = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      const cap = 12 * t + 0.5;
      const k = m > cap ? cap / m : 1;
      x[i] += dx[i] * k;
      y[i] += dy[i] * k;
    }
  }
  return new Map(ns.map((n, i) => [n.id, { x: x[i], y: y[i], r: r[i] }]));
}

/** A node's links in words, for the drawer. */
export function linksOf(g: MemoryGraph, id: string): Array<{ id: string; label: string }> {
  return g.edges.flatMap((e) => (e.from === id ? [{ id: e.to, label: e.label }] : e.to === id ? [{ id: e.from, label: e.label }] : []));
}
