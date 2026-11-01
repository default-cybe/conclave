/**
 * POST /api/sessions/:id/main-list (Move to main list, docs/DESIGN.md 43):
 * delegated work becomes a normal session of its kind. The route has the
 * same rule as editing a session: the caller's own sessions only, someone
 * else's answers 404.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import type { Session } from '@conclave/core/types.ts';
import { startServer, type RunningServer } from '../src/app';
import { ROUTE_POLICY } from '../src/route-policy';

const OWNER = 'owner-token-delegated-routes-0123456789';
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

/** A delegated job of a chat of the owner's, as Delegate leaves it once it answered. */
async function delegated(status: Session['status'] = 'idle'): Promise<{ chat: Session; child: Session }> {
  const chat = await t.engine.createSession({ kind: 'chat', title: 'Capstone' });
  const child = await t.engine.createSession({ agent: 'explore', parentId: chat.id, title: 'Find names', tags: ['subagent', 'delegated'] });
  t.engine.patchMeta(child.id, { subagent: true, delegate: { to: 'code', device: 'local', deviceName: 'hub', folder: '/tmp', readOnly: true, permissionMode: 'plan', toolUseId: 'tu_1' } });
  if (status !== 'idle') t.engine.setStatus(child.id, status);
  return { chat, child: t.engine.getSession(child.id)! };
}

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
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

describe('Move to main list', () => {
  test('has the same access rule as editing a session', () => {
    expect(ROUTE_POLICY['POST /api/sessions/:id/main-list']).toEqual(ROUTE_POLICY['PATCH /api/sessions/:id']);
  });

  test('the owner moves delegated work: the marks go, parentId stays', async () => {
    const { chat, child } = await delegated();
    const r = await call(OWNER, 'POST', `/api/sessions/${child.id}/main-list`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(child.id);
    expect(r.body.parentId).toBe(chat.id);
    expect(r.body.tags).toEqual([]);
    expect(r.body.meta.subagent).toBeUndefined();
    expect(r.body.meta.delegate).toBeUndefined();
    expect(r.body.meta.movedFrom).toMatchObject({ to: 'code', deviceName: 'hub', toolUseId: 'tu_1' });
    // the top-level list has it now
    const top = await call(OWNER, 'GET', '/api/sessions?parentId=none');
    expect(top.body.map((s: Session) => s.id)).toContain(child.id);
  });

  test("someone else's session answers 404, as editing it does, and stays as it was", async () => {
    const { child } = await delegated();
    const moved = await call(alice.token, 'POST', `/api/sessions/${child.id}/main-list`);
    const edited = await call(alice.token, 'PATCH', `/api/sessions/${child.id}`, { title: 'mine now' });
    expect(moved.status).toBe(404);
    expect(edited.status).toBe(404);
    expect(t.engine.getSession(child.id)?.tags).toEqual(['subagent', 'delegated']);
  });

  test('a session that is not delegated work, or one still at work, is refused with words', async () => {
    const chat = await t.engine.createSession({ kind: 'chat' });
    const plain = await call(OWNER, 'POST', `/api/sessions/${chat.id}/main-list`);
    expect(plain.status).toBe(400);
    expect(plain.body.error).toBe('Only delegated work moves to the main list.');
    const { child } = await delegated('running');
    const busy = await call(OWNER, 'POST', `/api/sessions/${child.id}/main-list`);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toContain('still working on the job');
    expect((await call(OWNER, 'POST', '/api/sessions/ses_nope/main-list')).status).toBe(404);
  });
});
