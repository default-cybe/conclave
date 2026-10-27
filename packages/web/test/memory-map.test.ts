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
import { BRAIN, CAP_AREA, areaId, buildTree, chainTo, indexGraph, layoutAll, layoutTree, nodeLabel, nodeWords, pathInto, searchItems, visibleLabels, type MapState, type MLayout, type ScreenLabel, type TNode } from '../src/features/memory/graph-model';
import { FISSURE, RX, RY, edgeOn, layoutBrain } from '../src/features/memory/brain-model';

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

/** Screen boxes that overlap. */
function screenOverlaps(ls: ScreenLabel[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++)
    for (let j = i + 1; j < ls.length; j++) {
      const a = ls[i];
      const b = ls[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.p.id} / ${b.p.id}`);
    }
  return out;
}

describe('memory map expand all', () => {
  test('expand all opens every area with every item, each once', () => {
    const g = world();
    const ix = indexGraph(g);
    const t = buildTree(ix, state({ all: true }));
    for (const a of t.root.children) expect(a.children.filter((c) => c.kind === 'node').length).toBe(ix.areas.find((x) => areaId(x.name) === a.id)!.ids.length);
    expect(flat(t.root).some((n) => n.kind === 'more')).toBe(false);
    for (const n of g.nodes) expect(t.items.has(n.id)).toBe(true);
    const l = layoutAll(t.root, ix);
    expect(l.blocks!.length).toBe(ix.areas.length);
    expect(l.rank!.length).toBe(g.nodes.length);
    expect(overlaps(l)).toEqual([]);
  });

  test('labels never overlap and are never under 11px, at any zoom, on a desktop and a phone', () => {
    const nodes = Array.from({ length: 3000 }, (_, i) => node(`n${i}`, { title: `A memory about thing number ${i}`, area: ['People', 'Projects', 'Homelab', 'Conversations', 'Courses'][i % 5] }));
    const g = graph(nodes, Array.from({ length: 2000 }, (_, i) => [`n${i}`, `n${(i * 7 + 3) % 3000}`, 'links to'] as [string, string, string]));
    const ix = indexGraph(g);
    const t = buildTree(ix, state({ all: true }));
    for (const phone of [false, true]) {
      const l = layoutAll(t.root, ix, { phone });
      const [w, h] = phone ? [390, 600] : [1440, 700];
      let shownFar = 0;
      for (const k of [0.04, 0.2, 0.45, 0.8, 1, 1.6, 3]) {
        let items = 0;
        // centred on the brain and on a corner of the busiest block
        for (const at of [{ x: 0, y: 0 }, { x: l.bounds.x + l.bounds.w * 0.8, y: l.bounds.y + 40 }]) {
          const v = { k, x: w / 2 - at.x * k, y: h / 2 - at.y * k };
          const ls = visibleLabels(l, v, w, h);
          expect(screenOverlaps(ls)).toEqual([]);
          for (const b of ls) expect(b.px).toBeGreaterThanOrEqual(11);
          if (k === 0.04) shownFar = Math.max(shownFar, ls.filter((b) => b.p.t.kind === 'node').length);
          items = Math.max(items, ls.filter((b) => b.p.t.kind === 'node').length);
        }
        // close in, a screen of rows reads
        if (k >= 1) expect(items).toBeGreaterThan(10);
      }
      // far out only the brain and the areas: items are ticks
      expect(shownFar).toBe(0);
    }
  });

  test('a picked or found item shows its label far out, still without overlap', () => {
    const g = world();
    const ix = indexGraph(g);
    const l = layoutAll(buildTree(ix, state({ all: true })).root, ix);
    const ls = visibleLabels(l, { k: 0.05, x: 700, y: 350 }, 1440, 700, undefined, new Set(['madx']));
    expect(ls.some((b) => b.p.id === 'madx')).toBe(true);
    expect(screenOverlaps(ls)).toEqual([]);
  });
});

describe('memory map brain view', () => {
  const g = world();
  const ix = indexGraph(g);
  const L = layoutBrain(g, ix);

  test('every item sits once in its area arc, on the outline', () => {
    expect(L.items.length).toBe(g.nodes.length);
    expect(new Set(L.items.map((i) => i.id)).size).toBe(g.nodes.length);
    for (const a of L.areas) {
      expect(a.t0).toBeLessThan(a.t1);
      for (let i = a.from; i < a.to; i++) {
        const it = L.items[i];
        expect(g.nodes[it.node].area).toBe(a.name);
        expect(it.side).toBe(a.side);
        expect(it.t).toBeGreaterThan(a.t0);
        expect(it.t).toBeLessThan(a.t1);
        // on the half-ellipse of its hemisphere
        expect(((Math.abs(it.x) - FISSURE) / RX) ** 2 + (it.y / RY) ** 2).toBeCloseTo(1, 3);
        expect(Math.sign(it.x)).toBe(it.side);
      }
    }
    // arcs on one side do not overlap
    for (const s of [1, -1]) {
      const arcs = L.areas.filter((a) => a.side === s).sort((a, b) => a.t0 - b.t0);
      for (let i = 1; i < arcs.length; i++) expect(arcs[i].t0).toBeGreaterThanOrEqual(arcs[i - 1].t1);
    }
  });

  test('records on the left, what they are about on the right', () => {
    const nodes = [node('c1', { area: 'Conversations' }), node('p1', { area: 'People' }), node('h1', { area: 'Homelab' })];
    const b = layoutBrain(graph(nodes, [['c1', 'p1', 'mentions']]), indexGraph(graph(nodes, [])));
    expect(b.areas.find((a) => a.name === 'Conversations')!.side).toBe(-1);
    expect(b.areas.find((a) => a.name === 'People')!.side).toBe(1);
  });

  test('only edges that exist are drawn, each once', () => {
    const real = new Set(g.edges.map(([a, b, l]) => `${g.nodes[a].id}|${g.nodes[b].id}|${g.labels[l]}`));
    expect(L.edges.length).toBe(g.edges.length);
    for (const e of L.edges) expect(real.has(`${L.items[e.a].id}|${L.items[e.b].id}|${e.label}`)).toBe(true);
    expect(new Set(L.edges.map((e) => `${e.a}|${e.b}|${e.label}`)).size).toBe(L.edges.length);
    for (const e of L.edges) expect(e.cross).toBe(L.items[e.a].area !== L.items[e.b].area);
  });

  test('bundled paths start and end at their items', () => {
    for (const e of L.edges) {
      const A = L.items[e.a];
      const B = L.items[e.b];
      const p = e.pts;
      expect(p[0]).toBeCloseTo(A.ix, 2);
      expect(p[1]).toBeCloseTo(A.iy, 2);
      expect(p[p.length - 2]).toBeCloseTo(B.ix, 2);
      expect(p[p.length - 1]).toBeCloseTo(B.iy, 2);
      expect((p.length - 2) % 6).toBe(0);
    }
    // a link across hemispheres passes near the middle: it bundles through the centre
    const across = L.edges.find((e) => L.items[e.a].side !== L.items[e.b].side);
    if (across) {
      let near = Infinity;
      for (let i = 0; i < across.pts.length; i += 2) near = Math.min(near, Math.hypot(across.pts[i], across.pts[i + 1]));
      expect(near).toBeLessThan(RX * 0.5);
    }
  });

  test('filters remove edges: hidden relations, across areas only, items stepped back', () => {
    const all = L.edges.filter((e) => edgeOn(L, e, { hidden: new Set(), crossOnly: false })).length;
    expect(all).toBe(L.edges.length);
    const noOwns = L.edges.filter((e) => edgeOn(L, e, { hidden: new Set(['owns']), crossOnly: false }));
    expect(noOwns.some((e) => e.label === 'owns')).toBe(false);
    expect(noOwns.length).toBe(L.edges.length - g.edges.filter(([, , l]) => g.labels[l] === 'owns').length);
    const cross = L.edges.filter((e) => edgeOn(L, e, { hidden: new Set(), crossOnly: true }));
    expect(cross.every((e) => e.cross)).toBe(true);
    expect(cross.length).toBeLessThan(all);
    const madx = g.nodes.findIndex((n) => n.id === 'madx');
    const gone = L.edges.filter((e) => edgeOn(L, e, { hidden: new Set(), crossOnly: false, gone: (i) => i === madx }));
    expect(gone.some((e) => L.items[e.a].node === madx || L.items[e.b].node === madx)).toBe(false);
  });

  test('builds fast for 3,000 items and links', () => {
    const nodes = Array.from({ length: 3000 }, (_, i) => node(`n${i}`, { area: ['People', 'Projects', 'Homelab', 'Conversations', 'Courses', 'Conclave'][i % 6] }));
    const big = graph(nodes, Array.from({ length: 3300 }, (_, i) => [`n${i % 3000}`, `n${(i * 13 + 5) % 3000}`, 'links to'] as [string, string, string]));
    const t0 = performance.now();
    const b = layoutBrain(big, indexGraph(big));
    expect(b.edges.length).toBeGreaterThan(3000);
    expect(performance.now() - t0).toBeLessThan(800);
  });
});
