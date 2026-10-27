/**
 * Memory > Map (src/features/memory/graph-model.ts): labels without ids or
 * slugs, the status line, filters and a layout that lands the same way.
 *
 *   bun test packages/web/test/memory-map.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { MemoryGraph, MemoryGraphNode } from '@conclave/core/client';
import { labelBudget, layoutGraph, linksOf, nextLimit, nodeLabel, nodeWords, placeLabels, statusLine, visibleIds, type Placed } from '../src/features/memory/graph-model';

const node = (id: string, over: Partial<MemoryGraphNode> = {}): MemoryGraphNode => ({ id, kind: 'fact', source: 'conclave', title: id, degree: 1, ...over });
const graph = (over: Partial<MemoryGraph> = {}): MemoryGraph => ({
  nodes: [
    node('mem:a', { title: 'The user deploys Conclave with bun run build on the hub' }),
    node('bm:main/entities/nodes/madx', { kind: 'note', source: 'basic-memory', title: 'Madx', note: { permalink: 'main/entities/nodes/madx', path: 'entities/nodes/Madx.md', folder: 'entities/nodes' } }),
    node('bm:main/conclave/memories/x', { source: 'both', title: 'Madx runs Proxmox', memoryId: 'x' }),
    node('tag:homelab', { kind: 'tag', title: 'homelab' }),
    node('ses:ses_0mvq85rdvwmerqzy6gy', { kind: 'session', title: 'A past session' }),
  ],
  edges: [
    { from: 'bm:main/conclave/memories/x', to: 'bm:main/entities/nodes/madx', kind: 'relation', label: 'relates to' },
    { from: 'mem:a', to: 'tag:homelab', kind: 'tag', label: 'tagged' },
    { from: 'mem:a', to: 'ses:ses_0mvq85rdvwmerqzy6gy', kind: 'session', label: 'from session' },
  ],
  basicMemory: { state: 'ok', name: 'Basic Memory' },
  total: 5,
  limit: 300,
  ...over,
});

describe('memory map words', () => {
  test('labels are short titles, never ids or slugs', () => {
    expect(nodeLabel(node('mem:a', { title: 'The user deploys Conclave with bun run build on the hub' }))).toBe('Deploys Conclave with bun run');
    expect(nodeLabel(node('n', { title: 'proxmox-backup-server-notes' }))).toBe('Proxmox backup server notes');
    expect(nodeLabel(node('n', { title: 'ses_0mvq85rdvwmerqzy6gy' }))).toBe('Fact');
    expect(nodeLabel(node('t', { kind: 'tag', title: 'homelab' }))).toBe('#homelab');
    for (const n of graph().nodes) expect(nodeLabel(n)).not.toMatch(/ses_|mem_|main\//);
  });

  test('where a node lives, in words', () => {
    const [, note, both] = graph().nodes;
    expect(nodeWords(note)).toBe('Note in Basic Memory, entities/nodes');
    expect(nodeWords(both)).toBe('Fact in Conclave and Basic Memory');
  });

  test('status line says when the cap applied and when Basic Memory is offline', () => {
    expect(statusLine(graph(), 3)).toBe('3 of 5 items.');
    expect(statusLine(graph({ total: 2980 }), 300)).toBe('300 of 2,980 items, the 300 with the most links.');
    expect(statusLine(graph({ basicMemory: { state: 'offline', name: 'Basic Memory' } }), 1)).toBe('1 of 5 items, Basic Memory is offline, so only Conclave memory is shown.');
  });
});

describe('memory map logic', () => {
  test('filters keep mirrored nodes under either source, and hubs of what is shown', () => {
    const g = graph();
    expect([...visibleIds(g, { source: 'basic-memory', kind: 'all', q: '' })].sort()).toEqual(['bm:main/conclave/memories/x', 'bm:main/entities/nodes/madx']);
    const c = visibleIds(g, { source: 'conclave', kind: 'all', q: '' });
    expect(c.has('bm:main/conclave/memories/x') && c.has('tag:homelab') && !c.has('bm:main/entities/nodes/madx')).toBe(true);
    expect([...visibleIds(g, { source: 'all', kind: 'note', q: '' })]).toEqual(['bm:main/entities/nodes/madx']);
    expect([...visibleIds(g, { source: 'all', kind: 'all', q: 'proxmox' })]).toEqual(['bm:main/conclave/memories/x']);
  });

  test('labels never overlap, and more fit as the map zooms in', () => {
    // a dense row of marks 20 world units apart
    const pos = new Map<string, Placed>(Array.from({ length: 40 }, (_, i) => [`n${i}`, { x: (i % 8) * 20, y: Math.floor(i / 8) * 12, r: 5 }]));
    const cands = [...pos.keys()].map((id) => ({ id, text: 'Homelab notes' }));
    const boxes = (k: number) => {
      const ids = placeLabels(cands, pos, k, 100);
      return [...ids].map((id) => {
        const p = pos.get(id)!;
        const x = p.x * k + 5 * Math.sqrt(k) + 4;
        return [x, p.y * k - 8, x + 13 * 6.6 + 4, p.y * k + 8];
      });
    };
    for (const k of [0.5, 1, 3]) {
      const b = boxes(k);
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) expect(b[i][0] < b[j][2] && b[j][0] < b[i][2] && b[i][1] < b[j][3] && b[j][1] < b[i][3]).toBe(false);
    }
    expect(boxes(0.5).length).toBeLessThan(boxes(3).length);
    // the first candidate (the picked node) always gets its label
    expect(placeLabels(cands, pos, 0.5, 100).has('n0')).toBe(true);
    expect(labelBudget(0.5)).toBeLessThan(labelBudget(3));
  });

  test('show more steps up to the endpoint caps', () => {
    expect(nextLimit(150, 2980)).toBe(300);
    expect(nextLimit(300, 2980)).toBe(1000);
    expect(nextLimit(1000, 2980)).toBeUndefined();
    expect(nextLimit(150, 120)).toBeUndefined();
  });

  test('layout is the same every time and places every node', () => {
    const g = graph();
    const a = layoutGraph(g, 50);
    const b = layoutGraph(g, 50);
    expect(a.size).toBe(5);
    expect([...a.entries()]).toEqual([...b.entries()]);
    for (const p of a.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(linksOf(g, 'mem:a').map((l) => l.label)).toEqual(['tagged', 'from session']);
  });
});
