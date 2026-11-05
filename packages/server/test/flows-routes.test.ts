/**
 * Flow routes (routes-flows.ts) on a scripted engine: the owner creates,
 * reads and edits a flow in a Code session; a member gets 404 on another
 * account's session flows, the same as an unknown session, and the block
 * catalog leaves Call AI out for members.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-flow-routes-0123456789';
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
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  const made = await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD });
  expect(made.status).toBe(200);
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  alice = { id: made.body.person.id, token: login.token };
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

describe('flow routes', () => {
  test('the owner creates, reads and edits a flow', async () => {
    const s = await t.engine.createSession({ title: 'code', cwd: t.cwd });
    const made = await call(OWNER, 'POST', `/api/sessions/${s.id}/flows/hn`);
    expect(made.status).toBe(201);
    expect(existsSync(join(t.cwd, 'flows/hn.flow.ts'))).toBe(true);
    expect(existsSync(join(t.cwd, 'flows/lib/index.ts'))).toBe(true);
    expect((await call(OWNER, 'GET', `/api/sessions/${s.id}/flows`)).body).toEqual([{ name: 'hn', path: 'flows/hn.flow.ts' }]);
    const g = await call(OWNER, 'GET', `/api/sessions/${s.id}/flows/hn/graph`);
    expect(g.status).toBe(200);
    const op = await call(OWNER, 'POST', `/api/sessions/${s.id}/flows/hn/graph/op`, { op: 'set', nodeId: 'stars', input: 'field', value: 'forks', baseSha: g.body.sha });
    expect(op.status).toBe(200);
    expect(op.body.diff).toContain("field: 'forks'");
    // a stale canvas is refused, bad ops and names are 400
    expect((await call(OWNER, 'POST', `/api/sessions/${s.id}/flows/hn/graph/op`, { op: 'set', nodeId: 'stars', input: 'field', value: 'x', baseSha: g.body.sha })).status).toBe(409);
    expect((await call(OWNER, 'POST', `/api/sessions/${s.id}/flows/hn/graph/op`, { op: 'eval', baseSha: g.body.sha })).status).toBe(400);
    expect((await call(OWNER, 'GET', `/api/sessions/${s.id}/flows/Bad_Name/graph`)).status).toBe(400);
    expect((await call(OWNER, 'GET', `/api/sessions/${s.id}/flows/nope/graph`)).status).toBe(404);
  });

  test('a member gets 404 on another account session flows', async () => {
    const s = await t.engine.createSession({ title: 'owner code', cwd: t.cwd });
    for (const [method, path] of [
      ['GET', `/api/sessions/${s.id}/flows`],
      ['POST', `/api/sessions/${s.id}/flows/x`],
      ['GET', `/api/sessions/${s.id}/flows/hn/graph`],
      ['POST', `/api/sessions/${s.id}/flows/hn/graph/op`],
      ['POST', `/api/sessions/${s.id}/flows/hn/graph/restore`],
      ['PUT', `/api/sessions/${s.id}/flows/hn/graph/layout`],
      ['POST', `/api/sessions/${s.id}/flows/hn/run`],
      ['GET', `/api/sessions/${s.id}/flows/hn/run`],
      ['POST', `/api/sessions/${s.id}/flows/hn/stop`],
    ] as const) {
      expect((await call(alice.token, method, path, method === 'GET' ? undefined : {})).status).toBe(404);
    }
    expect(existsSync(join(t.cwd, 'flows/x.flow.ts'))).toBe(false);
  });

  test('the catalog hides Call AI from members', async () => {
    const owner = await call(OWNER, 'GET', '/api/graph/nodes?use=program');
    const member = await call(alice.token, 'GET', '/api/graph/nodes?use=program');
    expect(owner.body.map((b: { block: string }) => b.block)).toContain('ai');
    expect(member.status).toBe(200);
    expect(member.body.map((b: { block: string }) => b.block)).not.toContain('ai');
    expect(member.body.length).toBe(owner.body.length - 1);
  });
});
