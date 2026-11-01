/**
 * The memory map's graph (memory/graph.ts): mirrored pairs are one node,
 * edges come only from real links, every item goes out once with compact
 * edges, areas come from the folders, and a Basic Memory that does not
 * answer leaves Conclave's own memory on the map.
 *
 *   bun test packages/core/test/memory/graph.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { AREA_MIN, buildMemoryGraph, parseBmActivity, type BmGraphData } from '../../src/memory/graph';
import type { MemoryGraph } from '../../src/client/memory-graph';
import { perFactPermalink } from '../../src/memory/connections/grouped';
import type { MemoryEntry } from '../../src/types';

const mem = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({ id, scope: 'global', kind: 'fact', content: `Fact ${id} about the homelab`, tags: [], importance: 0.5, createdAt: 1, updatedAt: 1, useCount: 0, ...over });
const ent = (permalink: string, title: string, file_path: string) => ({ type: 'entity', permalink, title, file_path, created_at: '2026-10-01T00:00:00Z' });
/** Edges with ids and words again. */
const links = (g: MemoryGraph) => g.edges.map(([a, b, l]) => ({ from: g.nodes[a].id, to: g.nodes[b].id, label: g.labels[l] }));
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
    expect(both[0]).toMatchObject({ folder: 'conclave/memories', area: 'Conclave' });
    expect(g.nodes.some((n) => n.id === 'mem:a')).toBe(false);
  });

  test('edges are only relations, shared tags, sessions and grouped notes', () => {
    const a = mem('a', { tags: ['homelab', 'source:claude-code'], sourceSessionId: 'ses_1' });
    const b = mem('b', { tags: ['homelab'] });
    const c = mem('c', { tags: ['lonely'] });
    const g = buildMemoryGraph({ memories: [a, b, c], sessionTitle: (id) => (id === 'ses_1' ? 'Fix the NAS' : undefined), bm: bmWith([]) });
    for (const [a, b, l] of g.edges) expect(g.nodes[a] && g.nodes[b] && g.labels[l]).toBeTruthy();
    const rels = links(g).filter((e) => e.from.startsWith('bm:')).map((e) => `${e.from} ${e.label} ${e.to}`);
    // the forward reference to a missing note draws nothing
    expect(rels.sort()).toEqual(['bm:main/entities/nodes/madx hosted on bm:main/entities/services/proxmox', 'bm:main/entities/people/kaivalya-ahir links to bm:main/entities/nodes/madx']);
    expect(g.nodes.find((n) => n.id === 'tag:homelab')).toBeDefined();
    // one memory alone on a tag, and where a row came from, are not links
    expect(g.nodes.some((n) => n.id === 'tag:lonely' || n.id === 'tag:source:claude-code')).toBe(false);
    expect(g.nodes.find((n) => n.id === 'ses:ses_1')?.title).toBe('Fix the NAS');
    expect(links(g).filter((e) => e.label === 'tagged')).toHaveLength(2);
    expect(links(g).filter((e) => e.label === 'from session')).toHaveLength(1);
    // c has no real link: no edge was made up for it
    expect(links(g).some((e) => e.from === 'mem:c' || e.to === 'mem:c')).toBe(false);
  });

  test('a memory links to the grouped note it is written into', () => {
    const a = mem('a', { kind: 'procedure', content: 'Deploy with bun run build' });
    const grouped = ent('main/conclave/procedures', 'procedures', 'conclave/procedures.md');
    const g = buildMemoryGraph({ memories: [a], bm: { ...bmWith([], [grouped]) } });
    expect(links(g).find((e) => e.label === 'in note')).toMatchObject({ from: 'mem:a', to: 'bm:main/conclave/procedures' });
  });

  test('every item goes out once, with edges as index triples', () => {
    const memories = Array.from({ length: 40 }, (_, i) => mem(`m${i}`, { kind: i === 0 ? 'profile' : 'fact', tags: ['homelab'] }));
    const notes = Array.from({ length: 3000 }, (_, i) => ent(`main/n/${i}`, `Note ${i}`, `n/${i}.md`));
    const g = buildMemoryGraph({ memories, bm: bmWith([], notes) });
    // 3 notes of bmWith, 3,000 notes, 40 memories and their shared tag: nothing capped
    expect(g.nodes).toHaveLength(3 + 3000 + 40 + 1);
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
    expect(g.edges).toHaveLength(2 + 40);
    expect(g.labels.sort()).toEqual(['hosted on', 'links to', 'tagged']);
    // compact: no repeated ids in the edges, no paths in the nodes
    expect(JSON.stringify(g).length).toBeLessThan(3043 * 160);
  });

  test('areas come from the folders, small ones fold into Other', () => {
    const f = (folder: string, n: number) => Array.from({ length: n }, (_, i) => ent(`main/${folder}/${i}`, `${folder} ${i}`, `${folder}/${i}.md`));
    const extra = [...f('entities/people', 3), ...f('people', 2), ...f('entities/containers', 2), ...f('homelab', 2), ...f('conversations/claude-ai/2026', 2), ...f('entities/recipes', AREA_MIN), ...f('entities/locations', 3), ...f('entities/cves', 1)];
    const g = buildMemoryGraph({ memories: [mem('p', { kind: 'profile' }), mem('a', { tags: ['x'] }), mem('b', { tags: ['x'] })], bm: bmWith([], extra) });
    const area = (id: string) => g.nodes.find((n) => n.id === id)?.area;
    expect(area('bm:main/entities/people/0')).toBe('People');
    expect(area('bm:main/people/1')).toBe('People');
    expect(area('bm:main/entities/containers/0')).toBe('Homelab');
    expect(area('bm:main/homelab/0')).toBe('Homelab');
    expect(area('bm:main/entities/nodes/madx')).toBe('Homelab');
    expect(area('bm:main/conversations/claude-ai/2026/0')).toBe('Conversations');
    expect(area('bm:main/entities/cves/0')).toBe('Security');
    // a folder no rule names: an area of its own when big enough, else Other
    expect(area('bm:main/entities/recipes/0')).toBe('Recipes');
    expect(area('bm:main/entities/locations/0')).toBe('Other');
    expect(area('mem:p')).toBe('People');
    expect(area('mem:a')).toBe('Conclave');
    expect(area('tag:x')).toBe('Conclave');
    expect(g.nodes.every((n) => n.area)).toBe(true);
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
