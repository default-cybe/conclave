/**
 * Mock routes for the Map (docs/DESIGN.md 29): GET /api/map from the
 * fixture in map-data.ts, a replay with ?at, and map.delta events that move
 * the running agents' token rates and start new tools now and then, as a
 * real hub sends them.
 *
 * Open the app with ?alerts=1 to see the two alerts the hub does not fill
 * yet: a stuck agent and a file two agents change at once.
 */
import type { MapNodePatch, MapSnapshot, MapTool } from '@conclave/core/client';
import type { MockCtx } from './index';
import { MAP_IDS as I, hash01, mapFixture, mapFixtureAt } from './map-data';

const TOOLS: Record<string, Array<[string, string]>> = {
  [I.auth]: [
    ['Read', 'auth.ts'],
    ['Edit', 'auth.ts'],
    ['Bash', 'bun test packages/server'],
    ['Grep', 'jwtVerify'],
  ],
  [I.paths]: [
    ['Glob', 'packages/**/package.json'],
    ['Read', 'tsconfig.json'],
  ],
  [I.correct]: [
    ['Read', 'auth.ts'],
    ['Read', 'pair.ts'],
  ],
  [I.security]: [
    ['Grep', 'alg.*none'],
    ['Read', 'auth.ts'],
  ],
  [I.login]: [
    ['Edit', 'redirect.ts'],
    ['Bash', 'bun test src/auth'],
    ['Read', 'redirect.test.ts'],
  ],
  [I.backup]: [
    ['Bash', 'proxmox-backup-client list'],
    ['Bash', 'pct exec 104 -- df -h'],
  ],
};

function withAlerts(s: MapSnapshot, now: number): MapSnapshot {
  let on = false;
  try {
    on = new URLSearchParams(location.search).has('alerts');
  } catch {
    /* no location in tests */
  }
  if (!on) return s;
  return {
    ...s,
    nodes: s.nodes.map((n) => (n.id === I.backup ? { ...n, stuckSince: now - 6 * 60_000, rate: 0, tokensPerMin: 0 } : n)),
    conflicts: [{ a: I.auth, b: I.correct, file: 'auth.ts', since: now - 90_000 }],
  };
}

export function registerMap(ctx: MockCtx) {
  let world: MapSnapshot | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const base = new Map<string, number>();
  let tickN = 0;

  const tick = () => {
    if (!world) return;
    const now = Date.now();
    tickN++;
    const patches: MapNodePatch[] = [];
    for (const n of world.nodes) {
      if (n.state !== 'running' || n.kind === 'workflow' || n.stuckSince) continue;
      const b = base.get(n.id) ?? n.rate;
      base.set(n.id, b);
      // the rate wanders around its own pace, with a lull now and then
      const lull = Math.sin(now / 9_000 + hash01(n.id) * 6.28) > 0.85;
      const rate = lull ? 0 : Math.max(0, Math.round(b * (0.65 + 0.7 * Math.random()) * 10) / 10);
      const p: MapNodePatch = { id: n.id, rate, tokensPerMin: Math.round((n.tokensPerMin * 4 + rate * 60) / 5) };
      n.rate = rate;
      n.tokensPerMin = p.tokensPerMin!;
      // a new tool every few seconds
      const list = TOOLS[n.id];
      if (list && Math.random() < 0.07) {
        const [name, target] = list[Math.floor(Math.random() * list.length)];
        const done: MapTool[] = n.tool ? [{ ...n.tool, durationMs: now - n.tool.startedAt }] : [];
        const tool: MapTool = { id: `tu_${now.toString(36)}_${tickN}`, name, target, startedAt: now };
        n.tools = [...done, ...n.tools].slice(0, 5);
        n.tool = tool;
        p.tool = tool;
        p.done = done;
        p.lastActivityAt = now;
        n.lastActivityAt = now;
      }
      patches.push(p);
    }
    if (patches.length) ctx.emit({ type: 'map.delta', delta: { at: now, nodes: patches } });
  };

  ctx.on('GET', '/api/map', ({ query }) => {
    const now = Date.now();
    const at = query.get('at');
    if (at) {
      const t = Number(at);
      if (!Number.isFinite(t)) ctx.fail(400, 'at must be a time');
      return withAlerts(mapFixtureAt(now, Math.max(now - 86_400_000, t)), t);
    }
    // a hub that was just set up: the hub and its devices, nothing ran yet
    if (ctx.FRESH) {
      const empty = mapFixture(now);
      return { ...empty, hub: { ...empty.hub, state: 'idle' }, devices: [...ctx.db.devices.values()].map((d) => ({ id: d.id, name: d.name, online: d.online })), groups: [], nodes: [], totals: { running: 0, waiting: 0, today: { ...empty.totals.today, tokens: 0, costUsd: 0 } } };
    }
    if (!world) world = withAlerts(mapFixture(now), now);
    if (!timer && !ctx.FRESH) timer = setInterval(tick, 600);
    return structuredClone({ ...world, at: now });
  });
}
