/**
 * The Map's layout (src/features/map/layout.ts): no two marks or labels
 * overlap, whatever the hub holds, and the same snapshot always gives the
 * same picture.
 *
 *   bun test packages/web/test/map-layout.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { MapGroup, MapNode, MapSnapshot, MapState } from '@conclave/core/client';
import { cubicAt, focusBox, layoutMap, overlaps, ROW, type Layout } from '../src/features/map/layout';
import { groupStats } from '../src/features/map/model';
import { fitView, LABEL_SMALLEST, READ_K, startView } from '../src/features/map/view';
import { MAP_IDS as I, mapFixture } from '../src/mock/map-data';

const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);

/** A small seeded random generator, so a failing case can be run again. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (s % 100_000) / 100_000;
  };
}

const WORDS = ['Fix', 'login', 'redirect', 'Move', 'auth', 'middleware', 'to', 'jose', 'Write', 'tests', 'for', 'the', 'checkout', 'flow', 'Audit', 'bundle', 'size', 'Rotate', 'certificates', 'a', 'very', 'long', 'title', 'that', 'keeps', 'going', 'past', 'the', 'edge'];
const STATES: MapState[] = ['running', 'waiting', 'idle', 'done', 'failed', 'paused'];

/** A random hub: up to 6 groups on up to 4 devices, up to 40 nodes with subagents and runs. */
function randomSnap(seed: number): MapSnapshot {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const devices = ['local', 'arch', 'mac', 'pve'].slice(0, 1 + Math.floor(r() * 4));
  const groups: MapGroup[] = [];
  const nGroups = 1 + Math.floor(r() * 6);
  for (let i = 0; i < nGroups; i++) {
    const device = pick(devices);
    groups.push(i === 0 && r() < 0.5 ? { id: 'chats', kind: 'chats', name: 'Chats', device: 'local' } : { id: `g${i}`, kind: r() < 0.6 ? 'project' : 'folder', name: Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(WORDS)).join('-'), device });
  }
  const nodes: MapNode[] = [];
  const n = Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    const parent = nodes.length && r() < 0.35 ? pick(nodes) : undefined;
    const g = parent ? groups.find((x) => x.id === parent.group)! : pick(groups);
    const kind = parent ? (parent.kind === 'workflow' ? 'agent' : r() < 0.15 ? 'workflow' : 'subagent') : g.kind === 'chats' ? 'chat' : r() < 0.15 ? 'workflow' : 'session';
    nodes.push({
      id: `ses_${seed}_${String(i).padStart(3, '0')}`,
      kind,
      title: Array.from({ length: 1 + Math.floor(r() * 9) }, () => pick(WORDS)).join(' '),
      state: pick(STATES),
      device: g.device,
      group: g.id,
      ...(parent ? { parentId: parent.id } : {}),
      startedAt: NOW - Math.floor(r() * 86_400_000),
      lastActivityAt: NOW,
      tools: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      tokensPerMin: 0,
      rate: 0,
      ...(r() < 0.1 ? { stuckSince: NOW - 6 * 60_000 } : {}),
    });
  }
  return {
    at: NOW,
    live: true,
    from: NOW - 86_400_000,
    hub: { name: pick(['madx', 'homelab', 'a-hub-with-a-long-name']), state: 'running' },
    devices: devices.map((id) => ({ id, name: id === 'local' ? 'madx' : id, online: r() < 0.8 })),
    groups,
    nodes,
    totals: { running: 0, waiting: 0, today: { from: 0, tokens: 0, costUsd: 0 } },
  };
}

const xy = (l: Layout) => l.nodes.map((n) => [n.id, Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100]);

describe('nothing overlaps', () => {
  test('the mock hub, on a desktop and on a phone', () => {
    const snap = mapFixture(NOW);
    for (const opts of [{ now: NOW }, { now: NOW, aspect: 1.9 }, { now: NOW, sides: 'right' as const, compact: true, aspect: 0.6 }]) {
      const l = layoutMap(snap, opts);
      expect(overlaps(l)).toEqual([]);
      // the hub, five devices, four groups and every node
      expect(l.nodes.length).toBe(1 + 4 + 4 + snap.nodes.length);
    }
  });

  test('300 random hubs, both layouts', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const snap = randomSnap(seed);
      for (const opts of [{ now: NOW }, { now: NOW, aspect: 1.9 }, { now: NOW, sides: 'right' as const, compact: true }, { now: NOW, sides: 'right' as const, compact: true, aspect: 0.55 }]) {
        const l = layoutMap(snap, opts);
        const bad = overlaps(l);
        if (bad.length) throw new Error(`seed ${seed} ${opts.sides ?? 'both'}: ${bad.slice(0, 3).join(' | ')}`);
      }
    }
  });

  test('an empty hub is the hub and its devices', () => {
    const l = layoutMap({ hub: { name: 'madx', state: 'idle' }, nodes: [], groups: [], devices: [{ id: 'local', name: 'madx', online: true }, { id: 'mac', name: 'MacBook', online: false }], live: true });
    expect(l.nodes.map((n) => n.id)).toEqual(['hub', 'dev:mac']);
    expect(l.links.map((k) => [k.from, k.to])).toEqual([['dev:mac', 'hub']]);
    expect(overlaps(l)).toEqual([]);
  });
});

describe('a stable picture', () => {
  test('the same snapshot gives the same layout, whatever order its nodes come in', () => {
    const snap = mapFixture(NOW);
    const a = layoutMap(snap, { now: NOW });
    const b = layoutMap({ ...snap, nodes: [...snap.nodes].reverse(), groups: [...snap.groups].reverse() }, { now: NOW });
    expect(xy(b).sort()).toEqual(xy(a).sort());
  });

  test('a new agent goes under its older siblings and leaves the other side alone', () => {
    const snap = mapFixture(NOW);
    const before = layoutMap(snap, { now: NOW });
    const added: MapNode = { ...snap.nodes.find((n) => n.id === I.login)!, id: 's_new', title: 'A new one', startedAt: NOW, tool: undefined };
    const after = layoutMap({ ...snap, nodes: [...snap.nodes, added] }, { now: NOW });
    const at = (l: Layout, id: string) => l.byId.get(id)!;
    expect(at(after, 's_new').y).toBeGreaterThan(at(after, I.bundle).y);
    expect(at(after, 's_new').side).toBe(at(after, I.login).side);
    // nodes on the other side of the hub do not move
    const other = before.nodes.filter((n) => n.side && n.side !== at(before, I.login).side);
    expect(other.length).toBeGreaterThan(0);
    for (const n of other) {
      expect(at(after, n.id).y).toBeCloseTo(n.y, 5);
      expect(at(after, n.id).x).toBeCloseTo(n.x, 5);
    }
  });

  test('children sit outside their parent, a row apart, oldest first', () => {
    const l = layoutMap(mapFixture(NOW), { now: NOW });
    const run = l.byId.get(`wf:${I.run}`)!;
    const agents = l.nodes.filter((n) => n.parent === run.id);
    expect(agents.map((n) => n.id)).toEqual([I.correct, I.security, I.tests, I.docs, I.refute]);
    for (const a of agents) expect(Math.abs(a.x)).toBeGreaterThan(Math.abs(run.x));
    for (let i = 1; i < agents.length; i++) expect(agents[i].y - agents[i - 1].y).toBeGreaterThanOrEqual(ROW - 0.01);
    // a parent with children carries its label above it, a leaf beside it
    expect(run.label.place).toBe('above');
    expect(agents[0].label.place).toBe('beside');
  });

  test('links run from each child to its parent, and the hub is the root', () => {
    const l = layoutMap(mapFixture(NOW), { now: NOW });
    expect(l.links.length).toBe(l.nodes.length - 1);
    const roots = l.links.filter((k) => k.to === 'hub').map((k) => k.from);
    expect(roots.sort()).toEqual(['dev:arch-desktop', 'dev:kali-vm', 'dev:macbook', 'dev:pve', 'grp:chats'].sort());
    const k = l.links.find((x) => x.from === I.auth)!;
    expect(cubicAt(k.p, 0)).toEqual([l.byId.get(I.auth)!.x, l.byId.get(I.auth)!.y]);
    const end = cubicAt(k.p, 1);
    expect(end[0]).toBeCloseTo(l.byId.get(k.to)!.x, 6);
  });
});

describe('the phone opens where labels read', () => {
  // a 390x844 phone: the map under the 56px top bar, less the sentence above it and Fit and the scrubber below
  const W = 390;
  const H = 844 - 56;
  const IN = { top: 84, right: 12, bottom: 120, left: 12 };

  test('at 12px words or more, on the hub and its busiest project; Fit still shows it all', () => {
    const snap = mapFixture(NOW);
    const l = layoutMap(snap, { now: NOW, sides: 'right', compact: true, aspect: 0.6 });
    const busiest = l.nodes
      .filter((n) => n.kind === 'group' && n.group?.kind !== 'chats')
      .map((n) => ({ n, s: groupStats(n.group!.id, snap.nodes) }))
      .sort((a, b) => b.s.running + b.s.waiting - (a.s.running + a.s.waiting) || b.s.agents - a.s.agents)[0].n;
    const v = startView(l.bounds, focusBox(l, snap.nodes), W, H, IN);
    // the whole map at Fit has labels far under 12px; the opening view does not
    const fit = fitView(l.bounds, W, H, IN, 1);
    expect(fit.k * LABEL_SMALLEST).toBeLessThan(8);
    expect(v.k).toBe(READ_K);
    expect(v.k * LABEL_SMALLEST).toBeGreaterThanOrEqual(12);
    // the hub and the busiest project on screen, with most of the project's label
    const sx = (x: number) => x * v.k + v.x;
    const sy = (y: number) => y * v.k + v.y;
    const hub = l.byId.get('hub')!;
    for (const n of [hub, busiest]) {
      expect(sx(n.x - n.r)).toBeGreaterThanOrEqual(IN.left);
      expect(sx(n.x + n.r)).toBeLessThanOrEqual(W - IN.right);
      expect(sy(n.y - n.r)).toBeGreaterThanOrEqual(IN.top);
      expect(sy(n.y + n.r)).toBeLessThanOrEqual(H - IN.bottom);
    }
    expect(W - sx(busiest.label.x)).toBeGreaterThan((busiest.label.w * v.k) * 0.75);
  });

  test('a map that fits at that zoom opens whole, as on a desktop', () => {
    // a new hub: the hub and a laptop
    const l = layoutMap({ hub: { name: 'madx', state: 'idle' }, nodes: [], groups: [], devices: [{ id: 'local', name: 'madx', online: true }, { id: 'mac', name: 'MacBook', online: true }], live: true }, { sides: 'right', compact: true });
    const v = startView(l.bounds, focusBox(l, []), W, H, IN);
    expect(v).toEqual(fitView(l.bounds, W, H, IN, READ_K));
    expect(v.k).toBe(READ_K);
  });
});

