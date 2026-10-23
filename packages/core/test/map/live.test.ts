/**
 * Map deltas (src/map/live.ts): the token rate from streamed text, the tool
 * running now and the ones that finished, usage, whole nodes when one starts
 * or changes state, and nothing while nobody watches.
 *
 *   bun test packages/core/test/map
 */
import { describe, expect, test } from 'bun:test';
import { EventBus } from '../../src/util/bus';
import { MapLive } from '../../src/map/live';
import type { MapDelta, MapNode, MapSnapshot } from '../../src/client/map';
import type { EngineEvent, EngineEventEnvelope, Session } from '../../src/types';

function rig(opts: { wanted?: boolean; snapshot?: () => MapSnapshot } = {}) {
  const bus = new EventBus();
  let now = 1_000_000;
  let wanted = opts.wanted ?? true;
  const sent: MapDelta[] = [];
  bus.on((e) => {
    if (e.type === 'map.delta') sent.push(e.delta);
  });
  const live = new MapLive({
    bus,
    now: () => now,
    // the timer never fires in a test: flush() is called by hand
    intervalMs: 3_600_000,
    wanted: () => wanted,
    usage: (id) => (id === 'ses_a' ? { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd: 0.01 } : undefined),
    snapshot: opts.snapshot,
  });
  const emit = (e: EngineEvent) => live.onEvent({ ...e, seq: 0, ts: now } as EngineEventEnvelope);
  const text = (sessionId: string, chars: number) => emit({ type: 'message.delta', sessionId, messageId: 'm', index: 0, kind: 'text', text: 'x'.repeat(chars) });
  return {
    bus,
    live,
    sent,
    emit,
    text,
    tick: (ms: number) => (now += ms),
    now: () => now,
    watch: (on: boolean) => (wanted = on),
  };
}

const node = (id: string, extra: Partial<MapNode> = {}): MapNode => ({
  id,
  kind: 'session',
  title: id,
  state: 'running',
  device: 'local',
  group: 'f:local:/w',
  startedAt: 0,
  lastActivityAt: 0,
  tools: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  tokensPerMin: 0,
  rate: 0,
  ...extra,
});

describe('the token rate', () => {
  test('rises with the stream, then decays to zero and says so once', () => {
    const r = rig();
    // 40 tokens a second for 3 seconds, a delta every 100 ms
    for (let i = 0; i < 30; i++) {
      r.text('ses_a', 16);
      r.tick(100);
      if (i % 5 === 4) r.live.flush();
    }
    const up = r.sent.flatMap((d) => d.nodes).filter((p) => p.id === 'ses_a' && p.rate !== undefined);
    expect(up.length).toBeGreaterThan(1);
    // smoothed: it climbs toward 40 without passing it
    const rates = up.map((p) => p.rate!);
    expect(rates[rates.length - 1]).toBeGreaterThan(20);
    expect(Math.max(...rates)).toBeLessThanOrEqual(41);
    expect(up[up.length - 1].tokensPerMin).toBeGreaterThan(80);
    // the stream stops: the rate falls and ends on a zero
    r.sent.length = 0;
    for (let i = 0; i < 40; i++) {
      r.tick(500);
      r.live.flush();
    }
    const down = r.sent.flatMap((d) => d.nodes).filter((p) => p.rate !== undefined);
    expect(down.length).toBeGreaterThan(1);
    expect(down[down.length - 1].rate).toBe(0);
    expect(down.filter((p) => p.rate === 0).length).toBe(1);
    expect(r.live.rate('ses_a')?.rate).toBe(0);
  });

  test('small changes in the rate send nothing', () => {
    const r = rig();
    r.text('ses_a', 400);
    r.tick(1_000);
    r.live.flush();
    const before = r.sent.length;
    r.text('ses_a', 4);
    r.tick(10);
    expect(r.live.flush()).toBeUndefined();
    expect(r.sent.length).toBe(before);
  });
});

describe('tools', () => {
  test('a tool that starts is the one running now; when it ends it moves to the finished list', () => {
    const r = rig();
    r.emit({ type: 'tool.started', sessionId: 'ses_a', messageId: 'm', toolUseId: 'tu_1', name: 'Bash', input: { command: 'bun test src/auth' } });
    const d1 = r.live.flush()!;
    expect(d1.nodes[0]).toMatchObject({ id: 'ses_a', tool: { id: 'tu_1', name: 'Bash', target: 'bun test src/auth', startedAt: r.now() } });
    expect(r.live.current('ses_a')?.id).toBe('tu_1');
    r.tick(1_900);
    r.emit({ type: 'tool.completed', sessionId: 'ses_a', toolUseId: 'tu_1', result: { type: 'tool_result', toolUseId: 'tu_1', content: '3 pass', meta: { durationMs: 1_850 } } });
    const d2 = r.live.flush()!;
    expect(d2.nodes[0].tool).toBeNull();
    expect(d2.nodes[0].done).toEqual([{ id: 'tu_1', name: 'Bash', target: 'bun test src/auth', startedAt: r.now() - 1_900, durationMs: 1_850 }]);
    expect(r.live.recent('ses_a').map((t) => t.id)).toEqual(['tu_1']);
  });

  test('tools that run side by side: the newest is the current one', () => {
    const r = rig();
    r.emit({ type: 'tool.started', sessionId: 'ses_a', messageId: 'm', toolUseId: 'tu_1', name: 'Read', input: { file_path: '/w/a.ts' } });
    r.tick(5);
    r.emit({ type: 'tool.started', sessionId: 'ses_a', messageId: 'm', toolUseId: 'tu_2', name: 'Read', input: { file_path: '/w/b.ts' } });
    expect(r.live.current('ses_a')?.target).toBe('b.ts');
    r.emit({ type: 'tool.completed', sessionId: 'ses_a', toolUseId: 'tu_2', result: { type: 'tool_result', toolUseId: 'tu_2', content: '', isError: true } });
    expect(r.live.current('ses_a')?.target).toBe('a.ts');
    expect(r.live.recent('ses_a')[0]).toMatchObject({ id: 'tu_2', error: true, durationMs: 0 });
  });

  test('a turn that ends clears a tool the stream never closed', () => {
    const r = rig();
    r.emit({ type: 'tool.started', sessionId: 'ses_a', messageId: 'm', toolUseId: 'tu_1', name: 'Bash', input: {} });
    r.live.flush();
    r.emit({ type: 'session.updated', session: { id: 'ses_a', status: 'idle', title: 't', model: 'm', agent: 'a', device: 'local', cwd: '/w' } as Session });
    expect(r.live.current('ses_a')).toBeUndefined();
    expect(r.live.flush()!.nodes[0].tool).toBeNull();
  });
});

describe('usage and whole nodes', () => {
  test('usage goes out as the totals, read when the delta is made', () => {
    const r = rig();
    r.emit({ type: 'usage.recorded', record: { id: 'u', ts: r.now(), sessionId: 'ses_a', source: 'api', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 } });
    expect(r.live.flush()!.nodes[0].usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd: 0.01 });
  });

  test('a new session, an approval and a workflow agent send whole nodes with their groups', () => {
    let calls = 0;
    const snap = (): MapSnapshot => {
      calls++;
      return {
        at: 0,
        live: true,
        from: 0,
        hub: { name: 'hub', state: 'waiting' },
        devices: [{ id: 'local', name: 'hub', online: true }, { id: 'mac', name: 'MacBook', online: true }],
        groups: [{ id: 'f:local:/w', kind: 'folder', name: 'w', device: 'local', path: '/w' }, { id: 'chats', kind: 'chats', name: 'Chats', device: 'local' }],
        nodes: [node('ses_new'), node('ses_push', { state: 'waiting', waitingOn: 'approval' }), node('wf:r1', { kind: 'workflow' }), node('ses_ag', { kind: 'agent', parentId: 'wf:r1', runId: 'r1' })],
        totals: { running: 2, waiting: 1, today: { from: 0, tokens: 0, costUsd: 0 } },
      };
    };
    const r = rig({ snapshot: snap });
    r.emit({ type: 'session.created', session: { id: 'ses_new', status: 'running', title: 'n', model: 'm', agent: 'a', device: 'local', cwd: '/w' } as Session });
    r.emit({ type: 'approval.requested', approval: { id: 'ap', sessionId: 'ses_push', toolUseId: 't', tool: 'Bash', input: {}, summary: '', createdAt: 0 } });
    r.emit({ type: 'workflow.agent', runId: 'r1', call: { seq: 1, kind: 'agent', state: 'running', attempt: 1, childSessionId: 'ses_ag', inputTokens: 0, outputTokens: 0, costUsd: 0 } });
    // a session the map does not show (a workflow's host): nothing for it
    r.emit({ type: 'session.created', session: { id: 'ses_host', status: 'idle', title: 'h', model: 'm', agent: 'a', device: 'local', cwd: '/w' } as Session });
    const d = r.live.flush()!;
    expect(calls).toBe(1);
    expect(d.nodes.map((p) => p.id).sort()).toEqual(['ses_ag', 'ses_new', 'ses_push', 'wf:r1']);
    expect(d.nodes.find((p) => p.id === 'ses_push')?.node?.waitingOn).toBe('approval');
    expect(d.groups?.map((g) => g.id)).toEqual(['f:local:/w']);
    expect(d.devices?.map((x) => x.id)).toEqual(['local']);
    expect(d.hub).toEqual({ state: 'waiting' });
  });

  test('an update that changes nothing the map shows sends nothing', () => {
    const r = rig({ snapshot: () => ({ at: 0, live: true, from: 0, hub: { name: 'h', state: 'idle' }, devices: [], groups: [], nodes: [node('ses_a')], totals: { running: 0, waiting: 0, today: { from: 0, tokens: 0, costUsd: 0 } } }) });
    const s = { id: 'ses_a', status: 'running', title: 't', model: 'm', agent: 'a', device: 'local', cwd: '/w', stats: { messages: 1 } } as Session;
    r.emit({ type: 'session.updated', session: s });
    expect(r.live.flush()?.nodes.length).toBe(1);
    r.emit({ type: 'session.updated', session: { ...s, stats: { ...s.stats, messages: 2 } } });
    expect(r.live.flush()).toBeUndefined();
  });

  test('a deleted session is removed', () => {
    const r = rig();
    r.text('ses_a', 40);
    r.emit({ type: 'session.deleted', sessionId: 'ses_a' });
    const d = r.live.flush()!;
    expect(d.nodes).toEqual([{ id: 'ses_a', removed: true }]);
  });
});

describe('only for watchers, never replayed', () => {
  test('nothing goes out while no client shows the map, and the tracking goes on', () => {
    const r = rig({ wanted: false });
    r.emit({ type: 'tool.started', sessionId: 'ses_a', messageId: 'm', toolUseId: 'tu_1', name: 'Bash', input: {} });
    expect(r.live.flush()).toBeUndefined();
    expect(r.sent).toEqual([]);
    expect(r.live.current('ses_a')?.id).toBe('tu_1');
  });

  test('map deltas stay out of the replay buffer', () => {
    const r = rig();
    r.bus.emit({ type: 'config.updated' });
    const seq = r.bus.currentSeq;
    r.text('ses_a', 400);
    r.tick(1_000);
    r.live.flush();
    expect(r.sent.length).toBe(1);
    expect(r.bus.since(seq)).toEqual([]);
  });
});
