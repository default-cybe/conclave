/**
 * Messages sent while a session is busy, over HTTP and the socket
 * (docs/design/CHAT-AND-MOTION.md 2.11): the send answers with the pending
 * id, GET /queue lists what waits, session.queue reaches the session's
 * account live, DELETE takes one off, and only the session's own account
 * may do either, as for sending.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestEngine, until, type TestEngine } from '../../core/test/engine/harness';
import { startServer, type RunningServer } from '../src/app';
import { openWs } from './helpers';

const OWNER = 'owner-token-session-queue-0123456789';
const PASSWORD = 'correct horse battery staple';

let t: TestEngine;
let running: RunningServer;
let alice: { id: string; token: string };

async function call(token: string, method: string, path: string, json?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  // each turn's reply takes a while, so the next message waits behind it
  t = await startTestEngine({ script: [{ blocks: [{ text: 'one' }], delayMs: 900 }] });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  const made = await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD, providers: { mock: { monthlyUsd: 5 } } });
  expect(made.status).toBe(200);
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  alice = { id: made.body.person.id, token: login.token };
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

describe('the queue over HTTP and the socket', () => {
  test('send while busy, list, remove, and the message that takes the place of one', async () => {
    const s = await call(OWNER, 'POST', '/api/sessions', { kind: 'chat', title: 'queue' });
    expect(s.status).toBe(200);
    const id = s.body.id as string;
    const ws = await openWs(`${running.url.replace(/^http/, 'ws')}/api/ws?token=${OWNER}`);
    try {
      // idle: it runs at once, as before
      expect((await call(OWNER, 'POST', `/api/sessions/${id}/messages`, { text: 'first' })).body).toEqual({ queued: false });
      expect(await until(() => t.engine.getSession(id)?.status === 'running')).toBe(true);

      const keep = await call(OWNER, 'POST', `/api/sessions/${id}/messages`, { text: 'second', pendingId: 'web_keep01' });
      expect(keep.body).toEqual({ queued: true, pendingId: 'web_keep01' });
      const drop = await call(OWNER, 'POST', `/api/sessions/${id}/messages`, { text: 'third', whenBusy: 'queue' });
      expect(drop.body.queued).toBe(true);
      const frame = await ws.next((f) => f.type === 'session.queue' && f.sessionId === id && f.queue.length === 2);
      expect(frame.queue.map((q: { text: string }) => q.text)).toEqual(['second', 'third']);

      const listed = await call(OWNER, 'GET', `/api/sessions/${id}/queue`);
      expect(listed.status).toBe(200);
      expect(listed.body.map((q: { id: string }) => q.id)).toEqual(['web_keep01', drop.body.pendingId]);

      // another account: the session is not theirs, the same 404 as for sending
      expect((await call(alice.token, 'POST', `/api/sessions/${id}/messages`, { text: 'hi' })).status).toBe(404);
      expect((await call(alice.token, 'GET', `/api/sessions/${id}/queue`)).status).toBe(404);
      expect((await call(alice.token, 'DELETE', `/api/sessions/${id}/queue/${drop.body.pendingId}`)).status).toBe(404);

      expect((await call(OWNER, 'DELETE', `/api/sessions/${id}/queue/${drop.body.pendingId}`)).body).toEqual({ ok: true });
      expect((await ws.next((f) => f.type === 'session.queue' && f.sessionId === id)).queue.map((q: { id: string }) => q.id)).toEqual(['web_keep01']);
      const again = await call(OWNER, 'DELETE', `/api/sessions/${id}/queue/${drop.body.pendingId}`);
      expect(again.status).toBe(404);
      expect(again.body.error).toBe('That message is not waiting any more.');

      // its turn starts: the message comes with its id, then the list without it
      const created = await ws.next((f) => f.type === 'message.created' && f.message.sessionId === id && f.message.meta?.pendingIds, 5_000);
      expect(created.message.meta).toEqual({ pendingIds: ['web_keep01'], whenBusy: 'queue' });
      expect((await ws.next((f) => f.type === 'session.queue' && f.sessionId === id)).queue).toEqual([]);
      await t.engine.runnerFor(id).waitIdle();
      expect((await call(OWNER, 'GET', `/api/sessions/${id}/queue`)).body).toEqual([]);
    } finally {
      ws.close();
    }
  });

  test('/btw answers apart from the transcript, for the session\'s own account only', async () => {
    const s = await call(OWNER, 'POST', '/api/sessions', { kind: 'chat', title: 'btw' });
    const id = s.body.id as string;
    expect((await call(OWNER, 'POST', `/api/sessions/${id}/btw`, {})).status).toBe(400);
    expect((await call(alice.token, 'POST', `/api/sessions/${id}/btw`, { text: 'hi?' })).status).toBe(404);
    const r = await call(OWNER, 'POST', `/api/sessions/${id}/btw`, { text: 'hi?' });
    expect(r.status).toBe(200);
    expect(typeof r.body.answer).toBe('string');
    expect(t.engine.getMessages(id)).toEqual([]);
  });

  test('Stop holds what waits, Send runs it (its own account only), and a bad pendingId is refused', async () => {
    const s = await call(OWNER, 'POST', '/api/sessions', { kind: 'chat', title: 'stop' });
    const id = s.body.id as string;
    expect((await call(OWNER, 'POST', `/api/sessions/${id}/messages`, { text: 'first', pendingId: 42 })).status).toBe(400);
    await call(OWNER, 'POST', `/api/sessions/${id}/messages`, { text: 'first' });
    expect(await until(() => t.engine.getSession(id)?.status === 'running')).toBe(true);
    const later = await call(OWNER, 'POST', `/api/sessions/${id}/messages`, { text: 'later' });
    expect((await call(OWNER, 'GET', `/api/sessions/${id}/queue`)).body).toHaveLength(1);
    await call(OWNER, 'POST', `/api/sessions/${id}/abort`);
    await t.engine.runnerFor(id).waitIdle();
    const held = await call(OWNER, 'GET', `/api/sessions/${id}/queue`);
    expect(held.body.map((q: { id: string; held?: boolean }) => [q.id, q.held])).toEqual([[later.body.pendingId, true]]);
    expect((await call(alice.token, 'POST', `/api/sessions/${id}/queue/${later.body.pendingId}/send`)).status).toBe(404);
    expect((await call(OWNER, 'POST', `/api/sessions/${id}/queue/q_nothing00/send`)).status).toBe(404);
    expect((await call(OWNER, 'POST', `/api/sessions/${id}/queue/${later.body.pendingId}/send`)).body).toEqual({ ok: true });
    expect(await until(() => t.engine.getMessages(id).some((m) => (m.meta?.pendingIds as string[] | undefined)?.includes(later.body.pendingId)), 5_000)).toBe(true);
    await t.engine.runnerFor(id).waitIdle();
    expect((await call(OWNER, 'GET', `/api/sessions/${id}/queue`)).body).toEqual([]);
  });
});
