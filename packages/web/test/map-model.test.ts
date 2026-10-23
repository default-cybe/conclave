/**
 * The Map on the client (src/features/map): deltas on a snapshot, the
 * words it shows, pan and zoom, and the streams.
 *
 *   bun test packages/web/test/map-model.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { MapDelta, MapNode, MapSnapshot } from '@conclave/core/client';
import { applyDelta, canStop, groupLine, hubKnot, hubState, nodeHref, replayTicks, shortId, stuckWords } from '../src/features/map/model';
import { clampView, fitView, pinch, toScreen, toWorld, wheelFactor, zoomAt, ZOOM_MAX, ZOOM_MIN } from '../src/features/map/view';
import { CAP, emitRate, Quality, Streams } from '../src/features/map/streams';
import type { LLink } from '../src/features/map/layout';
import { MAP_IDS as I, mapFixture, mapFixtureAt } from '../src/mock/map-data';

const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);
const byId = (s: MapSnapshot) => Object.fromEntries(s.nodes.map((n) => [n.id, n]));

describe('deltas', () => {
  const snap = mapFixture(NOW);

  test('a token rate, a tool that started and one that finished', () => {
    const before = byId(snap)[I.login];
    const tool = { id: 'tu_new', name: 'Bash', target: 'bun test src/auth', startedAt: NOW + 1_000 };
    const done = { ...before.tool!, durationMs: 900 };
    const next = applyDelta(snap, { at: NOW + 1_000, nodes: [{ id: I.login, rate: 51.5, tokensPerMin: 3_000, tool, done: [done], lastActivityAt: NOW + 1_000 }] });
    const n = byId(next)[I.login];
    expect(n.rate).toBe(51.5);
    expect(n.tokensPerMin).toBe(3_000);
    expect(n.tool).toEqual(tool);
    expect(n.tools[0]).toEqual(done);
    expect(n.tools.length).toBeLessThanOrEqual(5);
    expect(n.lastActivityAt).toBe(NOW + 1_000);
    // the snapshot it came from is untouched
    expect(byId(snap)[I.login].rate).toBe(before.rate);
    expect(next.at).toBe(NOW + 1_000);
  });

  test('usage that grew adds to today', () => {
    const n = byId(snap)[I.auth];
    const usage = { ...n.usage, inputTokens: n.usage.inputTokens + 1_000, outputTokens: n.usage.outputTokens + 200, costUsd: n.usage.costUsd + 0.05 };
    const next = applyDelta(snap, { at: NOW, nodes: [{ id: I.auth, usage }] });
    expect(next.totals.today.tokens).toBe(snap.totals.today.tokens + 1_200);
    expect(next.totals.today.costUsd).toBeCloseTo(snap.totals.today.costUsd + 0.05, 6);
  });

  test('a tool that ends with nothing after it clears the current one', () => {
    const next = applyDelta(snap, { at: NOW, nodes: [{ id: I.auth, tool: null }] });
    expect(byId(next)[I.auth].tool).toBeUndefined();
  });

  test('whole nodes come and go, with the groups they need; counts and the hub follow', () => {
    const fresh: MapNode = { ...byId(snap)[I.login], id: 'ses_new', title: 'New one', group: 'f:local:/srv', state: 'waiting', waitingOn: 'question', parentId: undefined };
    const delta: MapDelta = {
      at: NOW,
      nodes: [{ id: 'ses_new', node: fresh }, { id: I.push, removed: true }],
      groups: [{ id: 'f:local:/srv', kind: 'folder', name: 'srv', device: 'local', path: '/srv' }],
    };
    const next = applyDelta(snap, delta);
    expect(byId(next).ses_new.state).toBe('waiting');
    expect(byId(next)[I.push]).toBeUndefined();
    expect(next.groups.some((g) => g.id === 'f:local:/srv')).toBe(true);
    expect(next.totals.waiting).toBe(1);
    expect(next.hub.state).toBe('waiting');
    // the node that waited is gone and the new one waits: still one
    const calm = applyDelta(next, { at: NOW, nodes: [{ id: 'ses_new', state: 'running', waitingOn: null }] });
    expect(calm.totals.waiting).toBe(0);
    expect(calm.hub.state).toBe('running');
    expect(byId(calm).ses_new.waitingOn).toBeUndefined();
  });

  test('a child whose parent left stands on its own; patches for unknown nodes are skipped', () => {
    const next = applyDelta(snap, { at: NOW, nodes: [{ id: I.auth, removed: true }, { id: 'nobody', rate: 9 }] });
    expect(byId(next)[I.paths].parentId).toBeUndefined();
    expect(byId(next).nobody).toBeUndefined();
  });
});

describe('words', () => {
  test('short ids are the last four of the random part', () => {
    expect(shortId('ses_mgwk9p34y6n3wd25rq4')).toBe('5rq4');
    expect(shortId('wf:wfr_mgwqw8y9xw1sb09b9u7')).toBe('b9u7');
  });

  test('the hub waits before it runs, and runs count through agents, not runs', () => {
    const n = (state: MapNode['state'], kind: MapNode['kind'] = 'session') => ({ state, kind }) as MapNode;
    expect(hubState([n('running'), n('waiting')])).toBe('waiting');
    expect(hubState([n('running'), n('idle')])).toBe('running');
    expect(hubState([n('running', 'workflow'), n('done')])).toBe('idle');
    expect(hubKnot('running', [{ ...n('running'), tool: { name: 'Bash', startedAt: 0 } }], true)).toBe('tool');
    expect(hubKnot('running', [n('running')], true)).toBe('thinking');
    expect(hubKnot('waiting', [], true)).toBe('waiting');
    expect(hubKnot('idle', [], true)).toBe('done');
    expect(hubKnot('running', [], false)).toBe('paused');
  });

  test('group lines, links, stop and stuck', () => {
    expect(groupLine({ agents: 4, running: 2, waiting: 1 })).toBe('4 agents, 2 running, 1 waiting');
    expect(groupLine({ agents: 1, running: 0, waiting: 0 })).toBe('1 agent');
    expect(groupLine({ agents: 2, running: 0, waiting: 0 }, true)).toBe('2 chats');
    const s = byId(mapFixture(NOW));
    expect(nodeHref(s[I.week])).toBe(`/chat/${I.week}`);
    expect(nodeHref(s[I.auth])).toBe(`/s/${I.auth}`);
    expect(nodeHref(s[`wf:${I.run}`])).toBe(`/workflows/runs/${I.run}`);
    expect(canStop(s[I.auth])).toBe(true);
    expect(canStop(s[I.push])).toBe(true);
    expect(canStop(s[I.review])).toBe(false);
    expect(stuckWords({ ...s[I.backup], stuckSince: NOW - 6 * 60_000 }, NOW)).toBe('No progress 6m');
    expect(stuckWords({ ...s[I.backup], stuckSince: NOW - 75 * 60_000 }, NOW)).toBe('No progress 1h 15m');
    expect(stuckWords(s[I.backup], NOW)).toBeUndefined();
  });

  test('replay ticks fall on the hour, every three hours', () => {
    const from = new Date(2026, 9, 19, 15, 20).getTime();
    const ticks = replayTicks(from, from + 24 * 3_600_000);
    expect(ticks.length).toBe(8);
    for (const t of ticks) {
      expect(new Date(t).getMinutes()).toBe(0);
      expect(new Date(t).getHours() % 3).toBe(0);
    }
  });

  test('the mock replay keeps only what had started', () => {
    const snap = mapFixtureAt(NOW, NOW - 2 * 3_600_000);
    expect(snap.live).toBe(false);
    expect(snap.nodes.every((n) => n.startedAt <= NOW - 2 * 3_600_000)).toBe(true);
    expect(snap.devices.every((d) => d.online === undefined)).toBe(true);
  });
});

describe('pan and zoom', () => {
  const box = { x: -500, y: -200, w: 1000, h: 400 };

  test('fit puts the whole map inside the screen, centered between the overlays', () => {
    const v = fitView(box, 1200, 800, { top: 100, right: 0, bottom: 100, left: 0 }, 2);
    expect(v.k).toBeCloseTo(1.2, 6);
    const [x0, y0] = toScreen(v, box.x, box.y);
    const [x1, y1] = toScreen(v, box.x + box.w, box.y + box.h);
    expect(x0).toBeCloseTo(0, 6);
    expect(x1).toBeCloseTo(1200, 6);
    expect((y0 + y1) / 2).toBeCloseTo(400, 6);
    // never past the zoom it may fit at
    expect(fitView({ x: 0, y: 0, w: 10, h: 10 }, 1200, 800, undefined, 1.25).k).toBe(1.25);
  });

  test('zoom keeps the point under the cursor, within its limits', () => {
    const v = { x: 30, y: -20, k: 1 };
    const [wx, wy] = toWorld(v, 400, 300);
    const z = zoomAt(v, 400, 300, 1.5);
    const [sx, sy] = toScreen(z, wx, wy);
    expect(sx).toBeCloseTo(400, 6);
    expect(sy).toBeCloseTo(300, 6);
    expect(zoomAt(v, 0, 0, 100).k).toBe(ZOOM_MAX);
    expect(zoomAt(v, 0, 0, 0.001).k).toBe(ZOOM_MIN);
  });

  test('a pinch zooms by the fingers\' distance and follows their middle', () => {
    const v = { x: 0, y: 0, k: 1 };
    const p = pinch(v, [100, 100], [200, 100], [80, 120], [280, 120]);
    expect(p.k).toBeCloseTo(2, 6);
    // the world point under the old middle (150, 100) is under the new middle (180, 120)
    const [sx, sy] = toScreen(p, 150, 100);
    expect(sx).toBeCloseTo(180, 6);
    expect(sy).toBeCloseTo(120, 6);
  });

  test('a wheel notch zooms a little, a pinch on a trackpad more per pixel', () => {
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(3, 1, false)).toBeCloseTo(wheelFactor(48, 0, false), 6);
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false));
  });

  test('a drag cannot lose the map off screen', () => {
    const v = clampView({ x: 5_000, y: 0, k: 1 }, box, 1200, 800);
    const [x0] = toScreen(v, box.x, 0);
    expect(x0).toBeLessThanOrEqual(1200 - 80 + 1e-6);
  });
});

describe('streams', () => {
  /** Hub, a project, two agents: one fast, one quiet. */
  const links: LLink[] = [
    { id: 'grp', from: 'grp', to: 'hub', p: [200, 0, 100, 0, 100, 0, 0, 0] },
    { id: 'a', from: 'a', to: 'grp', p: [400, -40, 300, -40, 300, 0, 200, 0] },
    { id: 'b', from: 'b', to: 'grp', p: [400, 40, 300, 40, 300, 0, 200, 0] },
  ];

  test('the rate follows tokens a second; quiet is a third; lines is none', () => {
    expect(emitRate(0, 'full')).toBe(0);
    expect(emitRate(40, 'full')).toBeGreaterThan(emitRate(10, 'full'));
    expect(emitRate(40, 'quiet')).toBeCloseTo(emitRate(40, 'full') * 0.3, 6);
    expect(emitRate(40, 'lines')).toBe(0);
    expect(emitRate(500, 'full')).toBe(72);
    // a tool running, or a request in flight, still trickles
    expect(emitRate(0, 'full', 'tool')).toBeGreaterThan(0);
    expect(emitRate(0, 'full', 'waiting')).toBeGreaterThan(0);
  });

  test('particles leave the agent, pass the project and end at the hub', () => {
    const s = new Streams();
    s.setLinks(links);
    s.setSources([{ id: 'a', rate: 40, working: 'tokens' }]);
    for (let i = 0; i < 30; i++) s.step(1 / 30);
    expect(s.count).toBeGreaterThan(20);
    expect(s.active).toBe(true);
    // the source stops: the ones in flight run out at the hub
    s.setSources([]);
    for (let i = 0; i < 400; i++) s.step(1 / 30);
    expect(s.count).toBe(0);
    expect(s.active).toBe(false);
  });

  test('a pulse runs to the hub on its own; lines mode empties the links', () => {
    const s = new Streams();
    s.setLinks(links);
    s.pulse('b');
    expect(s.count).toBe(1);
    s.step(0.05);
    expect(s.count).toBe(1);
    s.mode = 'lines';
    s.setSources([{ id: 'a', rate: 40, working: 'tokens' }]);
    s.step(0.05);
    expect(s.count).toBe(0);
    s.pulse('b');
    expect(s.count).toBe(0);
  });

  test('a link that leaves the layout takes its particles with it', () => {
    const s = new Streams();
    s.setLinks(links);
    s.setSources([{ id: 'b', rate: 60, working: 'tokens' }]);
    for (let i = 0; i < 10; i++) s.step(1 / 30);
    const n = s.count;
    expect(n).toBeGreaterThan(0);
    s.setLinks(links.filter((k) => k.id !== 'b'));
    expect(s.count).toBe(0);
  });

  test('over budget, fewer particles; with room again, back up slowly', () => {
    const q = new Quality();
    for (let i = 0; i < 40; i++) q.update(12, 40);
    expect(q.q).toBeLessThan(0.2);
    for (let i = 0; i < 400; i++) q.update(1, 16);
    expect(q.q).toBe(1);
    expect(CAP.full).toBeGreaterThan(CAP.quiet);
  });
});
