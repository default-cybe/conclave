/**
 * The memory map's graph (memory/graph.ts): mirrored pairs are one node,
 * edges come only from real links, the cap holds, and a Basic Memory that
 * does not answer leaves Conclave's own memory on the map.
 *
 *   bun test packages/core/test/memory/graph.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { buildMemoryGraph, parseBmActivity, type BmGraphData } from '../../src/memory/graph';
import { perFactPermalink } from '../../src/memory/connections/grouped';
import type { MemoryEntry } from '../../src/types';

const mem = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({ id, scope: 'global', kind: 'fact', content: `Fact ${id} about the homelab`, tags: [], importance: 0.5, createdAt: 1, updatedAt: 1, useCount: 0, ...over });
const ent = (permalink: string, title: string, file_path: string) => ({ type: 'entity', permalink, title, file_path, created_at: '2026-10-01T00:00:00Z' });
const rel = (from: ReturnType<typeof ent>, type: string, target: string) => ({ type: 'relation', permalink: `${from.permalink}/${type}/${target}`, title: from.title, file_path: from.file_path });

const madx = ent('main/entities/nodes/madx', 'Madx', 'entities/nodes/Madx.md');
const kai = ent('main/entities/people/kaivalya-ahir', 'Kaivalya Ahir', 'entities/people/Kaivalya Ahir.md');
const proxmox = ent('main/entities/services/proxmox', 'Proxmox', 'entities/services/Proxmox.md');

function bmWith(memories: MemoryEntry[], extraEnt: unknown[] = [], extraRel: unknown[] = []): BmGraphData {
  // the per-fact notes Conclave mirrored, where perFactPermalink says they are
  const mirrored = memories.map((m) => perFactPermalink(m)).filter((p): p is string => !!p).map((p) => ent(`main/${p.toLowerCase().replace(/[^a-z0-9/]+/g, '-')}`, p.split('/').pop()!, `${p}.md`));
  const parsed = parseBmActivity([madx, kai, proxmox, ...mirrored, ...extraEnt], [rel(kai, 'links_to', 'madx'), rel(madx, 'hosted_on', 'entities/services/proxmox'), rel(madx, 'depends_on', 'nowhere'), ...extraRel]);
  return { connection: 'basic-memory', name: 'Basic Memory', folder: 'conclave', ...parsed };
}

describe('memory graph', () => {
  test('a mirrored fact and its note are one node, marked both', () => {
    const a = mem('a', { content: 'Madx runs Proxmox VE 9 with ZFS mirrors', sourceSessionId: 'ses_1' });
    const g = buildMemoryGraph({ memories: [a], bm: bmWith([a]) });
    const both = g.nodes.filter((n) => n.memoryId === 'a');
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ source: 'both', kind: 'fact', title: a.content });
    expect(both[0].note?.folder).toBe('conclave/memories');
    expect(g.nodes.some((n) => n.id === 'mem:a')).toBe(false);
  });

  test('edges are only relations, shared tags, sessions and grouped notes', () => {
    const a = mem('a', { tags: ['homelab', 'source:claude-code'], sourceSessionId: 'ses_1' });
    const b = mem('b', { tags: ['homelab'] });
    const c = mem('c', { tags: ['lonely'] });
    const g = buildMemoryGraph({ memories: [a, b, c], sessionTitle: (id) => (id === 'ses_1' ? 'Fix the NAS' : undefined), bm: bmWith([]) });
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    const rels = g.edges.filter((e) => e.kind === 'relation').map((e) => `${e.from} ${e.label} ${e.to}`);
    // the forward reference to a missing note draws nothing
    expect(rels.sort()).toEqual(['bm:main/entities/nodes/madx hosted on bm:main/entities/services/proxmox', 'bm:main/entities/people/kaivalya-ahir links to bm:main/entities/nodes/madx']);
    expect(g.nodes.find((n) => n.id === 'tag:homelab')).toBeDefined();
    // one memory alone on a tag, and where a row came from, are not links
    expect(g.nodes.some((n) => n.id === 'tag:lonely' || n.id === 'tag:source:claude-code')).toBe(false);
    expect(g.nodes.find((n) => n.id === 'ses:ses_1')?.title).toBe('Fix the NAS');
    expect(g.edges.filter((e) => e.kind === 'tag')).toHaveLength(2);
    expect(g.edges.filter((e) => e.kind === 'session')).toHaveLength(1);
    // c has no real link: no edge was made up for it
    expect(g.edges.some((e) => e.from === 'mem:c' || e.to === 'mem:c')).toBe(false);
  });

  test('a memory links to the grouped note it is written into', () => {
    const a = mem('a', { kind: 'procedure', content: 'Deploy with bun run build' });
    const grouped = ent('main/conclave/procedures', 'procedures', 'conclave/procedures.md');
    const g = buildMemoryGraph({ memories: [a], bm: { ...bmWith([], [grouped]) } });
    expect(g.edges.find((e) => e.kind === 'note')).toMatchObject({ from: 'mem:a', to: 'bm:main/conclave/procedures' });
  });

  test('the cap keeps the owner memories and the most linked notes', () => {
    const memories = Array.from({ length: 40 }, (_, i) => mem(`m${i}`, { kind: i === 0 ? 'profile' : 'fact' }));
    const notes = Array.from({ length: 200 }, (_, i) => ent(`main/n/${i}`, `Note ${i}`, `n/${i}.md`));
    const g = buildMemoryGraph({ memories, bm: bmWith([], notes), limit: 20 });
    expect(g.nodes).toHaveLength(20);
    expect(g.total).toBeGreaterThan(200);
    expect(g.limit).toBe(20);
    expect(g.nodes.some((n) => n.kind === 'profile')).toBe(true);
    expect(g.nodes.filter((n) => n.memoryId).length).toBe(10);
    expect(g.nodes.some((n) => n.id === 'bm:main/entities/nodes/madx')).toBe(true);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    expect(buildMemoryGraph({ memories, limit: 5000 }).limit).toBe(1000);
  });

  test('Basic Memory offline: Conclave memory alone, and it says so', () => {
    const g = buildMemoryGraph({ memories: [mem('a'), mem('b', { meta: { review: 'pending' } })], bmOffline: { name: 'Basic Memory', error: 'connect ECONNREFUSED' } });
    expect(g.basicMemory).toEqual({ state: 'offline', name: 'Basic Memory', error: 'connect ECONNREFUSED' });
    expect(g.nodes.map((n) => n.id)).toEqual(['mem:a']);
    expect(buildMemoryGraph({ memories: [] }).basicMemory.state).toBe('none');
  });

  test('parseBmActivity skips ambiguous and foreign rows', () => {
    const x1 = ent('main/a/dup', 'Dup', 'a/dup.md');
    const x2 = ent('main/b/dup', 'Dup', 'b/dup.md');
    const p = parseBmActivity([madx, x1, x2, 'junk', null], [rel(madx, 'mentions', 'dup'), { permalink: 'main/x/y/z', file_path: 'nope.md' }, rel(madx, 'mentions', 'madx')]);
    expect(p.notes).toHaveLength(3);
    expect(p.links).toEqual([]);
  });
});
