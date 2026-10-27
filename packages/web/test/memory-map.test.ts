/**
 * Memory > Map (src/features/memory/graph-model.ts): the mind map of all
 * memory. Labels without ids or slugs, areas from the data, "k more" caps,
 * labels that never overlap, rings past the first folded into counts, and a
 * search path that hangs inside the tree.
 *
 *   bun test packages/web/test/memory-map.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { MemoryGraph, MemoryGraphNode } from '@conclave/core/client';
import { BRAIN, CAP_AREA, areaId, buildTree, chainTo, indexGraph, layoutTree, nodeLabel, nodeWords, pathInto, searchItems, type MapState, type MLayout, type TNode } from '../src/features/memory/graph-model';

const node = (id: string, over: Partial<MemoryGraphNode> = {}): MemoryGraphNode => ({ id, kind: 'note', source: 'basic-memory', title: id, area: 'Other', degree: 0, ...over });

/** A graph from nodes and [from, to, label] links; degrees filled in. */
function graph(nodes: MemoryGraphNode[], links: Array<[string, string, string]>): MemoryGraph {
  const ix = new Map(nodes.map((n, i) => [n.id, i]));
  const labels = [...new Set(links.map((l) => l[2]))];
  for (const [a, b] of links) (nodes[ix.get(a)!].degree++, nodes[ix.get(b)!].degree++);
  return { nodes, edges: links.map(([a, b, l]) => [ix.get(a)!, ix.get(b)!, labels.indexOf(l)]), labels, basicMemory: { state: 'ok', name: 'Basic Memory' } };
}

/** A hub like 'Kaivalya Ahir' (323 links over many relations), people, a homelab chain and a far note. */
function world(): MemoryGraph {
  const nodes: MemoryGraphNode[] = [node('me', { title: 'Kaivalya Ahir', area: 'People', folder: 'entities/people' })];
  const links: Array<[string, string, string]> = [];
  const rels = ['links to', 'owns', 'member of', 'advises', 'works at', 'located at', 'runs in', 'depends on', 'mentions', 'studies', 'uses', 'knows', 'owes'];
  rels.forEach((r, i) => {
    for (let j = 0; j < 30 - i * 2; j++) {
      const id = `${r}-${j}`;
      nodes.push(node(id, { title: `${r} thing ${j}`, area: j % 2 ? 'Homelab' : 'Projects' }));
      links.push(['me', id, r]);
    }
  });
  for (let i = 0; i < 40; i++) nodes.push(node(`p${i}`, { title: `Person ${i}`, area: 'People' }));
  nodes.push(node('madx', { title: 'Madx', area: 'Homelab' }), node('ct', { title: 'CT 127', area: 'Homelab' }), node('immich', { title: 'Immich', area: 'Services' }), node('ferox', { title: 'feroxbuster', area: 'Projects' }));
  links.push(['ct', 'madx', 'hosted on'], ['immich', 'ct', 'runs in'], ['ferox', 'immich', 'links to'], ['madx', 'owns-0', 'owns']);
  nodes.push(node('mem:x', { kind: 'fact', source: 'both', title: 'The user deploys Conclave with bun run build on the hub', area: 'Conclave', memoryId: 'x' }));
  return graph(nodes, links);
}

const state = (over: Partial<MapState> = {}): MapState => ({ center: BRAIN, depth: 1, hidden: new Set(['mentions']), dismissed: new Set(), open: new Set(), more: new Map(), ...over });
const flat = (t: TNode): TNode[] => [t, ...t.children.flatMap(flat)];

/** No two label boxes overlap. */
function overlaps(l: MLayout): string[] {
  const out: string[] = [];
  const ps = l.nodes;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y - a.h / 2 < b.y + b.h / 2 && b.y - b.h / 2 < a.y + a.h / 2) out.push(`${a.id} / ${b.id}`);
    }
  return out;
}

describe('memory map words', () => {
  test('labels are short titles, never ids or slugs', () => {
    expect(nodeLabel(node('mem:a', { kind: 'fact', title: 'The user deploys Conclave with bun run build on the hub' }))).toBe('Deploys Conclave with bun run');
    expect(nodeLabel(node('n', { title: 'proxmox-backup-server-notes' }))).toBe('Proxmox backup server notes');
    expect(nodeLabel(node('n', { kind: 'fact', title: 'ses_0mvq85rdvwmerqzy6gy' }))).toBe('Fact');
    expect(nodeLabel(node('t', { kind: 'tag', title: 'homelab' }))).toBe('#homelab');
  });

  test('where an item lives, in words', () => {
    expect(nodeWords(node('n', { folder: 'entities/nodes' }))).toBe('Note in Basic Memory, entities/nodes');
    expect(nodeWords(node('m', { kind: 'fact', source: 'both' }))).toBe('Fact in Conclave and Basic Memory');
  });
});

describe('memory map tree', () => {
  test('the brain in the middle, the areas from the data around it, biggest first, Other last', () => {
    const ix = indexGraph(world());
    const { root, items } = buildTree(ix, state());
    expect(root.kind).toBe('brain');
    expect(root.count).toBe(ix.byId.size);
    expect(root.children.map((c) => c.via)).toEqual(['Homelab', 'Projects', 'People', 'Conclave', 'Services']);
    expect(root.children.every((c) => c.kind === 'area' && !c.children.length)).toBe(true);
    expect(root.children.find((c) => c.via === 'People')?.count).toBe(41);
    expect(items.size).toBe(0);
  });

  test('an open area shows its most linked items and a plain "k more" row', () => {
    const ix = indexGraph(world());
    const s = state({ open: new Set([areaId('People')]) });
    const people = buildTree(ix, s).root.children.find((c) => c.via === 'People')!;
    expect(people.children.slice(0, CAP_AREA).map((c) => c.item)[0]).toBe('me');
    expect(people.children.at(-1)).toMatchObject({ kind: 'more', count: 41 - CAP_AREA });
    // "k more" adds rows
    const more = buildTree(ix, { ...s, more: new Map([[areaId('People'), 20]]) }).root.children.find((c) => c.via === 'People')!;
    expect(more.children.filter((c) => c.kind === 'node')).toHaveLength(CAP_AREA + 20);
  });

  test('a big hub caps each relation group and keeps ring 1 within the budget', () => {
    const ix = indexGraph(world());
    for (const budget of [12, 38]) {
      const { root } = buildTree(ix, state({ center: 'me', budget }));
      expect(root.kind).toBe('focus');
      // mentions is off by default
      expect(root.children.some((g) => g.via === 'mentions')).toBe(false);
      for (const g of root.children) {
        const shown = g.children.filter((c) => c.kind === 'node').length;
        const more = g.children.find((c) => c.kind === 'more');
        // a group shows all of its items, or a few and "k more", or closes to one row with its count
        if (shown) expect(shown + (more?.count ?? 0)).toBe(g.count!);
        else expect(g.children).toHaveLength(0);
      }
      const rows = flat(root).filter((t) => !t.children.length).length;
      expect(rows).toBeLessThanOrEqual(budget + 2);
    }
  });

  test('rings past the first fold into counts until they fit or the owner zooms in', () => {
    const ix = indexGraph(world());
    const tight = buildTree(ix, state({ center: 'ct', depth: 3, budget: 2 }));
    const madx = flat(tight.root).find((t) => t.item === 'madx')!;
    expect(madx.children).toHaveLength(0);
    expect(madx.count).toBe(1);
    const zoomed = buildTree(ix, state({ center: 'ct', depth: 3, budget: 2, unfold: true }));
    expect(flat(zoomed.root).find((t) => t.item === 'madx')!.children.map((c) => c.item)).toEqual(['owns-0']);
  });

  test('labels never overlap, around the brain and around a hub, on both layouts', () => {
    const ix = indexGraph(world());
    const trees = [state({ open: new Set([areaId('People'), areaId('Homelab'), areaId('Projects')]) }), state({ center: 'me', budget: 38, depth: 2, unfold: true }), state({ center: 'ct', depth: 3, unfold: true })];
    for (const s of trees)
      for (const phone of [false, true]) {
        const l = layoutTree(buildTree(ix, s).root, ix, { sides: phone ? 'right' : 'both', phone });
        expect(overlaps(l)).toEqual([]);
        // a child is always further out than its parent, on its side
        for (const p of l.nodes) {
          const par = p.parent ? l.byId.get(p.parent)! : undefined;
          if (par && par.side) expect(p.side === 1 ? p.x > par.x + par.w : p.x + p.w < par.x).toBe(true);
        }
      }
  });

  test('search reaches every item and the path to a hit hangs inside the tree', () => {
    const ix = indexGraph(world());
    // the far note is not on the map around CT 127 at depth 1
    const s = state({ center: 'madx' });
    const t = buildTree(ix, s);
    expect(t.items.has('ferox')).toBe(false);
    const hits = searchItems(ix, 'ferox', t.items);
    expect(hits.map((h) => h.id)).toEqual(['ferox']);
    const pairs = pathInto(ix, 'madx', t.items, 'ferox')!;
    expect(pairs).toEqual([
      ['ct', 'immich'],
      ['immich', 'ferox'],
    ]);
    const after = buildTree(ix, { ...s, extra: pairs });
    const l = layoutTree(after.root, ix);
    // madx, then its group, then CT 127, Immich and feroxbuster, one column further out each
    expect(chainTo(l, 'ferox')).toEqual(['madx', 'grp:hosted on', 'ct', 'immich', 'ferox']);
    expect(overlaps(l)).toEqual([]);
    // around the brain the path is the item's area
    expect(pathInto(ix, BRAIN, new Set(), 'ferox')).toEqual([[areaId('Projects'), 'ferox']]);
    const b = layoutTree(buildTree(ix, state({ extra: [[areaId('Projects'), 'ferox']] })).root, ix);
    expect(chainTo(b, 'ferox')).toEqual([BRAIN, areaId('Projects'), 'ferox']);
  });

  test('about 3,000 items index and lay out fast', () => {
    const nodes = Array.from({ length: 3000 }, (_, i) => node(`n${i}`, { title: `Note ${i}`, area: ['People', 'Homelab', 'Projects', 'Courses'][i % 4] }));
    const links: Array<[string, string, string]> = nodes.slice(1).map((n, i) => [n.id, `n${Math.floor(i / 10)}`, i % 3 ? 'links to' : 'mentions']);
    const g = graph(nodes, links);
    const t0 = performance.now();
    const ix = indexGraph(g);
    const l = layoutTree(buildTree(ix, state({ center: 'n0', depth: 3, unfold: true, budget: 40 })).root, ix);
    expect(l.nodes.length).toBeGreaterThan(10);
    expect(searchItems(ix, 'note 2999', new Set()).map((n) => n.id)).toEqual(['n2999']);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
