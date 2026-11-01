import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import type { EngineEventEnvelope } from '@conclave/core/types.ts';
import { OWNER, openWs, startHub, type TestHub } from './helpers';

let hub: TestHub;
let wsUrl: string;

beforeAll(() => {
  hub = startHub();
  wsUrl = hub.url.replace(/^http/, 'ws') + '/api/ws';
});
afterAll(() => hub.stop());

const delta = (sessionId: string, text: string) =>
  hub.engine.bus.emit({ type: 'message.delta', sessionId, messageId: 'm1', index: 0, kind: 'text', text });

describe('/api/ws', () => {
  test('rejects missing or bad tokens', async () => {
    await expect(openWs(wsUrl)).rejects.toThrow();
    await expect(openWs(`${wsUrl}?token=bad`)).rejects.toThrow();
    const res = await fetch(`${hub.url}/api/ws`, { headers: { authorization: `Bearer ${OWNER}` } });
    expect(res.status).toBe(426);
  });

  test('hello, event fan-out to every socket, ping/pong, touch', async () => {
    hub.engine.bus.emit({ type: 'config.updated' });
    const a = await openWs(`${wsUrl}?token=${OWNER}`);
    const b = await openWs(`${wsUrl}?token=${OWNER}`);
    const hello = await a.next((f) => f.type === 'hello');
    expect(hello).toEqual({ type: 'hello', seq: hub.engine.bus.currentSeq, version: '0.0.0-test' });
    await b.next((f) => f.type === 'hello');

    hub.engine.bus.emit({ type: 'task.deleted', taskId: 't1' });
    const ea = await a.next((f) => f.type === 'task.deleted');
    const eb = await b.next((f) => f.type === 'task.deleted');
    expect(ea.taskId).toBe('t1');
    expect(ea.seq).toBe(hello.seq + 1);
    expect(eb.seq).toBe(ea.seq);
    expect(typeof ea.ts).toBe('number');

    a.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await a.next((f) => f.type === 'pong')).type).toBe('pong');
    expect(hub.engine.touches.filter((t) => t === 'owner').length).toBeGreaterThanOrEqual(3);
    a.close();
    b.close();
  });

  test('since replays missed events, or asks for a resync when too old', async () => {
    const start = hub.engine.bus.currentSeq;
    hub.engine.bus.emit({ type: 'task.deleted', taskId: 'r1' });
    hub.engine.bus.emit({ type: 'routine.deleted', routineId: 'r2' });
    delta('s1', 'not replayed');
    const c = await openWs(`${wsUrl}?token=${OWNER}`);
    await c.next((f) => f.type === 'hello');
    c.ws.send(JSON.stringify({ type: 'since', seq: start }));
    const r1 = await c.next((f) => f.type === 'task.deleted');
    const r2 = await c.next((f) => f.type === 'routine.deleted');
    expect([r1.seq, r2.seq]).toEqual([start + 1, start + 2]);
    expect(c.frames.some((f) => f.type === 'message.delta')).toBe(false);

    c.close();
    // overflow the replay ring (2000 events), then ask for a seq it no longer holds
    for (let i = 0; i < 2005; i++) hub.engine.bus.emit({ type: 'task.deleted', taskId: `x${i}` });
    const d = await openWs(`${wsUrl}?token=${OWNER}`);
    await d.next((f) => f.type === 'hello');
    d.ws.send(JSON.stringify({ type: 'since', seq: start }));
    const resync = await d.next((f) => f.type === 'resync');
    expect(resync.seq).toBe(hub.engine.bus.currentSeq);
    d.close();
  });

  test('subscribe filters live deltas by session, other events still flow', async () => {
    const c = await openWs(`${wsUrl}?token=${OWNER}`);
    await c.next((f) => f.type === 'hello');
    c.ws.send(JSON.stringify({ type: 'subscribe', sessions: ['s-mine'] }));
    await Bun.sleep(20);
    delta('s-other', 'skip me');
    delta('s-mine', 'keep me');
    hub.engine.bus.emit({ type: 'session.deleted', sessionId: 's-other' });
    const d = await c.next((f) => f.type === 'message.delta');
    expect(d.text).toBe('keep me');
    await c.next((f) => f.type === 'session.deleted');
    expect(c.frames.filter((f) => f.type === 'message.delta')).toHaveLength(1);
    // back to everything
    c.ws.send(JSON.stringify({ type: 'subscribe', sessions: null }));
    await Bun.sleep(20);
    delta('s-other', 'now visible');
    expect((await c.next((f) => f.type === 'message.delta')).text).toBe('now visible');
    c.close();
  });

  test('workflow run events reach the socket whatever its session filter; a reconnect replays all but progress', async () => {
    const start = hub.engine.bus.currentSeq;
    const c = await openWs(`${wsUrl}?token=${OWNER}`);
    await c.next((f) => f.type === 'hello');
    c.ws.send(JSON.stringify({ type: 'subscribe', sessions: ['s-mine'] }));
    await Bun.sleep(20);
    const counts = { agents: 1, queued: 0, running: 1, done: 0, cached: 0, failed: 0, skipped: 0, parked: 0 };
    const run = { id: 'wfr_live', name: 'review-changes', source: 'builtin' as const, status: 'running' as const, sessionId: 's-other', toolUseId: 'toolu_1', device: 'local', cwd: '/p', phases: [{ title: 'Find' }], phaseIndex: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, counts, portable: true, createdAt: 1 };
    const call = { seq: 1, kind: 'agent' as const, label: 'finder', phase: 'Find', state: 'running' as const, attempt: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 2 };
    hub.engine.bus.emit({ type: 'workflow.run', run });
    hub.engine.bus.emit({ type: 'workflow.phase', runId: 'wfr_live', index: 0, title: 'Find' });
    hub.engine.bus.emit({ type: 'workflow.agent', runId: 'wfr_live', call });
    hub.engine.bus.emit({ type: 'workflow.progress', runId: 'wfr_live', callSeq: 1, lastTool: 'Grep TODO' });
    hub.engine.bus.emit({ type: 'workflow.log', runId: 'wfr_live', ts: 3, text: 'found 2' });
    hub.engine.bus.emit({ type: 'workflow.agent', runId: 'wfr_live', call: { ...call, state: 'done', finishedAt: 4 } });
    hub.engine.bus.emit({ type: 'workflow.run', run: { ...run, status: 'done', counts: { ...counts, running: 0, done: 1 }, finishedAt: 5 } });
    // the run's session is not the one the socket shows: workflow events still come, in order
    const ended = await c.next((f) => f.type === 'workflow.run' && f.run.status === 'done');
    expect(ended.run).toMatchObject({ id: 'wfr_live', toolUseId: 'toolu_1', counts: { done: 1 }, finishedAt: 5 });
    const seen = c.frames.filter((f) => String(f.type).startsWith('workflow.'));
    expect(seen.map((f) => f.type)).toEqual(['workflow.run', 'workflow.phase', 'workflow.agent', 'workflow.progress', 'workflow.log', 'workflow.agent', 'workflow.run']);
    expect(seen[3]).toMatchObject({ runId: 'wfr_live', callSeq: 1, lastTool: 'Grep TODO' });
    expect(seen[5].call).toMatchObject({ seq: 1, label: 'finder', state: 'done', startedAt: 2, finishedAt: 4 });
    c.close();

    const d = await openWs(`${wsUrl}?token=${OWNER}`);
    await d.next((f) => f.type === 'hello');
    d.ws.send(JSON.stringify({ type: 'since', seq: start }));
    await d.next((f) => f.type === 'workflow.run' && f.run.status === 'done');
    expect(d.frames.filter((f) => String(f.type).startsWith('workflow.')).map((f) => f.type)).toEqual(['workflow.run', 'workflow.phase', 'workflow.agent', 'workflow.log', 'workflow.agent', 'workflow.run']);
    d.close();
  });

  test('presence: an app in the background does not count as someone using Conclave', async () => {
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const { token, clientId } = await new ConclaveClient({ baseUrl: hub.url }).pair(pairing.code, 'Pixel', 'android');
    const mine = () => hub.engine.touches.filter((t) => t === clientId).length;
    const released = () => hub.engine.releases.filter((t) => t === clientId).length;

    const bg = await openWs(`${wsUrl}?token=${token}&active=0`);
    await bg.next((f) => f.type === 'hello');
    bg.ws.send(JSON.stringify({ type: 'ping' }));
    await bg.next((f) => f.type === 'pong');
    expect(mine()).toBe(0);

    // in the foreground each presence frame is use; pings are not
    bg.ws.send(JSON.stringify({ type: 'presence', active: true }));
    bg.ws.send(JSON.stringify({ type: 'ping' }));
    await bg.next((f) => f.type === 'pong');
    expect(mine()).toBe(1);
    bg.ws.send(JSON.stringify({ type: 'presence', active: true }));
    bg.ws.send(JSON.stringify({ type: 'ping' }));
    await bg.next((f) => f.type === 'pong');
    expect(mine()).toBe(2);

    // to the background: the hold ends at once
    bg.ws.send(JSON.stringify({ type: 'presence', active: false }));
    bg.ws.send(JSON.stringify({ type: 'ping' }));
    await bg.next((f) => f.type === 'pong');
    expect(mine()).toBe(2);
    expect(released()).toBe(1);

    // the same client in the foreground on another socket keeps the hold
    const fg = await openWs(`${wsUrl}?token=${token}`);
    await fg.next((f) => f.type === 'hello');
    fg.ws.send(JSON.stringify({ type: 'presence', active: true }));
    fg.ws.send(JSON.stringify({ type: 'ping' }));
    await fg.next((f) => f.type === 'pong');
    bg.ws.send(JSON.stringify({ type: 'presence', active: false }));
    bg.ws.send(JSON.stringify({ type: 'ping' }));
    await bg.next((f) => f.type === 'pong');
    expect(released()).toBe(1);
    bg.close();
    // closing the last foreground socket ends the hold
    fg.close();
    const until0 = Date.now() + 2000;
    while (released() < 2 && Date.now() < until0) await Bun.sleep(10);
    expect(released()).toBe(2);

    // the typed client sends the same frames; setActive(true) again is a heartbeat
    const before = mine();
    const client = new ConclaveClient({ baseUrl: hub.url, token });
    const statuses: string[] = [];
    const stop = client.connect(() => {}, { active: false, onStatus: (s) => statuses.push(s) });
    const until = Date.now() + 2000;
    while (!statuses.includes('open') && Date.now() < until) await Bun.sleep(10);
    await Bun.sleep(30);
    expect(mine()).toBe(before);
    stop.setActive(true);
    while (mine() < before + 1 && Date.now() < until) await Bun.sleep(10);
    stop.setActive(true);
    while (mine() < before + 2 && Date.now() < until) await Bun.sleep(10);
    expect(mine()).toBe(before + 2);
    stop();
  });

  test('the typed client connects and receives events; paired clients touch with their id', async () => {
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const anon = new ConclaveClient({ baseUrl: hub.url });
    const { token, clientId } = await anon.pair(pairing.code, 'Phone', 'android');
    const client = new ConclaveClient({ baseUrl: hub.url, token });
    const got: EngineEventEnvelope[] = [];
    const statuses: string[] = [];
    const stop = client.connect((e) => got.push(e), { onStatus: (s) => statuses.push(s) });
    const until = Date.now() + 2000;
    while (!statuses.includes('open') && Date.now() < until) await Bun.sleep(10);
    await Bun.sleep(30);
    hub.engine.bus.emit({ type: 'memory.deleted', id: 'm9' });
    // the app's own connect comes first as app.updated (online)
    while (!got.some((e) => e.type === 'memory.deleted') && Date.now() < until) await Bun.sleep(10);
    stop();
    expect(got.find((e) => e.type === 'memory.deleted')).toMatchObject({ type: 'memory.deleted', id: 'm9' });
    expect(hub.engine.touches).toContain(clientId);
  });

  test('revoking an app, or changing the hub token, closes the sockets it opened', async () => {
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const { token, clientId } = await new ConclaveClient({ baseUrl: hub.url }).pair(pairing.code, 'Lost phone', 'android');
    const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    const app = await openWs(`${wsUrl}?token=${token}`);
    const owner = await openWs(`${wsUrl}?token=${OWNER}`);
    await app.next((f) => f.type === 'hello');
    await owner.next((f) => f.type === 'hello');

    const appGone = closed(app.ws);
    expect((await hub.api(`/api/clients/${clientId}`, { method: 'DELETE' })).status).toBe(200);
    expect(await appGone).toBe(4001);
    // the owner's socket is not touched
    hub.engine.bus.emit({ type: 'task.deleted', taskId: 'after-revoke' });
    await owner.next((f) => f.type === 'task.deleted' && f.taskId === 'after-revoke');

    const ownerGone = closed(owner.ws);
    const server = hub.engine.config.get().server;
    hub.engine.config.update({ server: { ...server, token: 'a-new-owner-token-0123456789' } });
    try {
      expect(await ownerGone).toBe(4001);
    } finally {
      hub.engine.config.update({ server: { ...server, token: OWNER } });
    }
  });
});
