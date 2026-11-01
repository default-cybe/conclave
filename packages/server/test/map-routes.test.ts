/**
 * The Map over HTTP and the socket (routes-map.ts, ws/clients.ts):
 * GET /api/map, the replay with ?at, and map.delta only for sockets that
 * asked for it.
 *
 *   bun test packages/server/test/map-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MapSnapshot } from '@conclave/core/client/map.ts';
import type { Session } from '@conclave/core/types.ts';
import { OWNER, openWs, startHub, type TestHub } from './helpers';

let hub: TestHub;
let wsUrl: string;
const MIN = 60_000;

function session(id: string, extra: Partial<Session>, at: number): Session {
  const s: Session = {
    id,
    title: id,
    agent: 'coder',
    model: 'anthropic/claude-sonnet-5-5',
    mode: 'agent',
    permissionMode: 'default',
    cwd: '/home/sam/code/app',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: at,
    updatedAt: at,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ...extra,
  };
  hub.engine.repos.sessions.insert(s);
  return s;
}

beforeAll(() => {
  hub = startHub();
  wsUrl = hub.url.replace(/^http/, 'ws') + '/api/ws';
  const now = Date.now();
  const repos = hub.engine.repos;
  session('ses_run', { title: 'Fix login redirect', status: 'running' }, now - 10 * MIN);
  repos.messages.insert({ id: 'm1', sessionId: 'ses_run', seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'fix' }], createdAt: now - 10 * MIN });
  repos.messages.insert({ id: 'm2', sessionId: 'ses_run', seq: 2, role: 'assistant', kind: 'normal', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/home/sam/code/app/src/a.ts' } }], createdAt: now - 9 * MIN });
  repos.messages.insert({ id: 'm3', sessionId: 'ses_run', seq: 3, role: 'user', kind: 'normal', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'x', meta: { durationMs: 900 } }], createdAt: now - 9 * MIN + 900 });
  const turn = repos.turns.start({ sessionId: 'ses_run', startedAt: now - 10 * MIN });
  void turn;
  repos.usage.insert({ id: 'u1', ts: now - 9 * MIN, sessionId: 'ses_run', source: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.02 });
  session('ses_chat', { kind: 'chat', title: 'Plan the week' }, now - 30 * MIN);
});

afterAll(async () => {
  await hub.stop();
});

describe('GET /api/map', () => {
  test('needs the token', async () => {
    expect((await hub.api('/api/map', { token: null })).status).toBe(401);
  });

  test('the live map: the hub, its nodes with tools and usage, the groups', async () => {
    // a zone where it is now about noon, so the usage 9 minutes back is always "today"
    // (a fixed UTC+2 failed every day between 22:00 and 22:09 UTC)
    const d = new Date();
    const res = await hub.api(`/api/map?tz=${d.getUTCHours() * 60 + d.getUTCMinutes() - 720}`);
    expect(res.status).toBe(200);
    const map = (await res.json()) as MapSnapshot;
    expect(map.live).toBe(true);
    expect(map.hub).toEqual({ name: 'test hub', state: 'running' });
    const run = map.nodes.find((n) => n.id === 'ses_run')!;
    expect(run).toMatchObject({ kind: 'session', state: 'running', title: 'Fix login redirect', group: 'f:local:/home/sam/code/app' });
    expect(run.tools[0]).toMatchObject({ name: 'Read', target: 'a.ts', durationMs: 900 });
    expect(run.usage.outputTokens).toBe(200);
    expect(map.nodes.find((n) => n.id === 'ses_chat')).toMatchObject({ kind: 'chat', state: 'idle', group: 'chats' });
    expect(map.groups.map((g) => g.id).sort()).toEqual(['chats', 'f:local:/home/sam/code/app']);
    expect(map.totals.running).toBe(1);
    expect(map.totals.today.tokens).toBeGreaterThanOrEqual(1_200);
  });

  test('a replay: before the session started it is not there', async () => {
    const at = Date.now() - 20 * MIN;
    const map = (await (await hub.api(`/api/map?at=${at}`)).json()) as MapSnapshot;
    expect(map.live).toBe(false);
    expect(map.at).toBe(at);
    expect(map.nodes.map((n) => n.id)).toEqual(['ses_chat']);
    const iso = new Date(Date.now() - 9 * MIN + 300).toISOString();
    const mid = (await (await hub.api(`/api/map?at=${encodeURIComponent(iso)}`)).json()) as MapSnapshot;
    expect(mid.nodes.find((n) => n.id === 'ses_run')?.tool).toMatchObject({ name: 'Read', target: 'a.ts' });
  });

  test('a bad time, a time over a day back and a bad zone are refused', async () => {
    expect((await hub.api('/api/map?at=yesterday-ish')).status).toBe(400);
    expect((await hub.api(`/api/map?at=${Date.now() - 30 * 3_600_000}`)).status).toBe(400);
    expect((await hub.api('/api/map?tz=9999')).status).toBe(400);
  });
});

describe('map.delta on the socket', () => {
  test('only a socket that asked gets them, and they stop when it says off', async () => {
    const watcher = await openWs(`${wsUrl}?token=${OWNER}`);
    const other = await openWs(`${wsUrl}?token=${OWNER}`);
    await watcher.next((f) => f.type === 'hello');
    await other.next((f) => f.type === 'hello');
    expect(hub.running.conclave.ctx.clients.mapWatchers).toBe(0);
    watcher.ws.send(JSON.stringify({ type: 'map', on: true }));
    // the frame arrives before the next event is sent
    await Bun.sleep(50);
    expect(hub.running.conclave.ctx.clients.mapWatchers).toBe(1);

    const bus = hub.engine.bus;
    bus.emit({ type: 'tool.started', sessionId: 'ses_run', messageId: 'm2', toolUseId: 'tu_2', name: 'Bash', input: { command: 'bun test' } });
    bus.emit({ type: 'message.delta', sessionId: 'ses_run', messageId: 'm2', index: 0, kind: 'text', text: 'x'.repeat(400) });
    const delta = await watcher.next((f) => f.type === 'map.delta', 3_000);
    const patch = delta.delta.nodes.find((p: { id: string }) => p.id === 'ses_run');
    expect(patch.tool).toMatchObject({ name: 'Bash', target: 'bun test' });
    expect(typeof delta.seq).toBe('number');
    await Bun.sleep(700);
    expect(other.frames.some((f) => f.type === 'map.delta')).toBe(false);

    watcher.ws.send(JSON.stringify({ type: 'map', on: false }));
    await Bun.sleep(50);
    expect(hub.running.conclave.ctx.clients.mapWatchers).toBe(0);
    watcher.close();
    other.close();
  });

  test('a closed watcher no longer counts', async () => {
    const w = await openWs(`${wsUrl}?token=${OWNER}`);
    w.ws.send(JSON.stringify({ type: 'map', on: true }));
    await Bun.sleep(50);
    expect(hub.running.conclave.ctx.clients.mapWatchers).toBe(1);
    w.close();
    await Bun.sleep(100);
    expect(hub.running.conclave.ctx.clients.mapWatchers).toBe(0);
  });
});
