/**
 * GET /api/sessions/:id/shells: the background shells the hub holds for a
 * session, the source of truth for the Background tasks card (a hub restart
 * ends them all, and the transcript cannot say so). Same rule as the other
 * session routes: the session's own account only; anyone else gets 404.
 * shells.updated reaches the account live when one starts or ends.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import { shellRegistry } from '@conclave/core/tools/shells.ts';
import { startServer, type RunningServer } from '../src/app';
import { openWs } from './helpers';

const OWNER = 'owner-token-session-shells-0123456789';
const PASSWORD = 'correct horse battery staple';

let t: TestEngine;
let running: RunningServer;
let aliceToken: string;

async function call(token: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ tool: 'Bash', input: { command: 'sleep 60', run_in_background: true, description: 'Wait a minute' } }], [{ text: 'started' }]],
    approve: 'allow',
  });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  const made = await fetch(`${running.url}/api/people`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alice', password: PASSWORD, providers: { mock: { monthlyUsd: 5 } } }) });
  expect(made.status).toBe(200);
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  aliceToken = login.token;
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

describe('the session shells route', () => {
  test('lists the hub-held shells with the call that started them; another account gets 404; shells.updated goes out', async () => {
    const s = await t.engine.createSession({ cwd: t.cwd });
    const ws = await openWs(`${running.url.replace(/^http/, 'ws')}/api/ws?token=${OWNER}`);
    try {
      await t.run(s.id, 'start it');
      const frame = await ws.next((f) => f.type === 'shells.updated' && f.sessionId === s.id);
      expect(frame.shells[0]).toMatchObject({ status: 'running', description: 'Wait a minute' });

      const listed = await call(OWNER, `/api/sessions/${s.id}/shells`);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({ id: 'bash_' + listed.body[0].id.slice(5), command: 'sleep 60', status: 'running' });
      expect(typeof listed.body[0].toolUseId).toBe('string');

      expect((await call(aliceToken, `/api/sessions/${s.id}/shells`)).status).toBe(404);

      await shellRegistry.kill(s.id, listed.body[0].id);
      expect((await call(OWNER, `/api/sessions/${s.id}/shells`)).body[0].status).toBe('killed');
      // a session the hub holds no shells for: an empty list (after a restart, every session)
      const other = await t.engine.createSession({ cwd: t.cwd });
      expect((await call(OWNER, `/api/sessions/${other.id}/shells`)).body).toEqual([]);
    } finally {
      ws.close();
    }
  }, 30_000);
});
