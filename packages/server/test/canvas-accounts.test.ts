/**
 * Canvas mode, PR 3, across accounts: a member cannot remove a node from,
 * run, stop or re-run the owner's workflow and runs, nor send Ask the agent
 * into the owner's session; each gets the same 404 as a missing one, and the
 * owner's file stays as it was. The run queue lives in the browser per
 * account (web/test/canvas-run.test.ts).
 *
 *   bun test packages/server/test/canvas-accounts.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import { noHarnesses, svcOf } from '../../core/test/workflows/helpers';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-canvas-accounts-0123456789';
const PASSWORD = 'correct horse battery staple';

let t: TestEngine;
let running: RunningServer;
let alice: string;

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
  t = await startTestEngine({ script: [[{ text: 'ok' }]], route: (body) => (/say (\w+)/.exec(firstUserText(body)) ? [{ text: 'said' }] : undefined), approve: 'allow' });
  noHarnesses(t.engine);
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  expect((await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD })).status).toBe(200);
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  alice = login.token;
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

describe('another account', () => {
  test("a member cannot remove, run, stop, re-run or ask the agent on the owner's files and runs", async () => {
    const svc = svcOf(t.engine);
    const path = join(svc.registry.userDir, 'owner-flow.js');
    const script = `export const meta = { name: 'owner-flow', description: 'o' }\nconst a = await agent('say a')\nawait agent('say b')\nreturn a\n`;
    mkdirSync(svc.registry.userDir, { recursive: true });
    writeFileSync(path, script);
    const g = await call(OWNER, 'GET', '/api/workflows/owner-flow/graph');
    expect(g.status).toBe(200);
    const s = await t.engine.createSession({ title: 'owner code', cwd: t.cwd });
    const started = await call(OWNER, 'POST', '/api/workflows/runs', { name: 'owner-flow', sessionId: s.id });
    expect(started.status).toBe(201);
    await svc.wait(started.body.id);

    const denied = [
      ['POST', '/api/workflows/owner-flow/graph/remove', { nodeId: 'agent-2', baseSha: g.body.sha }],
      ['POST', '/api/workflows/runs', { name: 'owner-flow' }],
      ['POST', `/api/workflows/runs/${started.body.id}/stop`, {}],
      ['POST', `/api/workflows/runs/${started.body.id}/rerun`, { seqs: [1] }],
      ['GET', `/api/workflows/runs/${started.body.id}`, undefined],
      ['GET', '/api/workflows/owner-flow', undefined],
      ['POST', `/api/sessions/${s.id}/messages`, { text: 'Canvas: I am editing owner-flow.js' }],
    ] as const;
    for (const [method, url, json] of denied) expect([url, (await call(alice, method, url, json)).status]).toEqual([url, 404]);
    expect(readFileSync(path, 'utf8')).toBe(script);
    // the owner can, on the same file
    const rm = await call(OWNER, 'POST', '/api/workflows/owner-flow/graph/remove', { nodeId: 'agent-2', baseSha: g.body.sha });
    expect(rm.status).toBe(200);
    expect(readFileSync(path, 'utf8')).toBe(script.replace("await agent('say b')\n", ''));
  });

  test("the member's own Ask the agent session is hers: the owner's session list does not change, hers has it", async () => {
    const before = (await call(OWNER, 'GET', '/api/sessions')).body.length;
    const made = await call(alice, 'POST', '/api/sessions', { title: 'Canvas: mine.js' });
    expect(made.status).toBe(200);
    expect((await call(alice, 'GET', `/api/sessions/${made.body.id}`)).status).toBe(200);
    expect((await call(OWNER, 'GET', '/api/sessions')).body.length).toBe(before);
  });
});
