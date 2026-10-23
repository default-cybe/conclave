/**
 * A member's code session on the hub (docs/design/ACCOUNTS.md 5). Every tool
 * is refused on the hub's own computer for a member, so a code session there
 * (a coding agent, a harness, a repo, a task) is refused when it is started,
 * with a line that says where to go. Chats and the assistant still start on
 * the hub, a code session on a device of their own starts, and the owner's
 * start as before.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CODE_NEEDS_DEVICE } from '@conclave/core/people/guard.ts';
import { startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-member-sessions-0123456789';
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
  const made = await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD, providers: { mock: { monthlyUsd: 5 } } });
  expect(made.status).toBe(200);
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  alice = { id: made.body.person.id, token: login.token };
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

const sessionsOf = (accountId: string) => t.engine.listSessions({ accountId }).length;

describe("a member's code session on the hub", () => {
  test('a coding agent, a harness, a task and a repo session are refused before they start, with the line', async () => {
    const before = sessionsOf(alice.id);
    for (const body of [{ agent: 'coder' }, { agent: 'coder', device: 'local', cwd: '~/code/app' }, { model: 'claude-code/default' }]) {
      const r = await call(alice.token, 'POST', '/api/sessions', body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(CODE_NEEDS_DEVICE);
    }
    const task = await call(alice.token, 'POST', '/api/tasks', { title: 'Fix the login page' });
    const started = await call(alice.token, 'POST', `/api/tasks/${task.body.id}/start`, { agent: 'coder' });
    expect(started.status).toBe(400);
    expect(started.body.error).toBe(CODE_NEEDS_DEVICE);
    const repo = await call(alice.token, 'POST', '/api/github/sessions', { repo: 'acme/widgets' });
    expect(repo.status).toBe(400);
    expect(repo.body.error).toBe(CODE_NEEDS_DEVICE);
    // nothing was made
    expect(sessionsOf(alice.id)).toBe(before);
  });

  test('a chat and the assistant start on the hub: they need no machine', async () => {
    const chat = await call(alice.token, 'POST', '/api/sessions', { kind: 'chat', title: 'hello' });
    expect(chat.status).toBe(200);
    expect(chat.body.device).toBe('local');
    // Today's "Plan my day" and a new goal start the assistant
    const assistant = await call(alice.token, 'POST', '/api/sessions', { agent: 'assistant', title: 'Plan my day' });
    expect(assistant.status).toBe(200);
    expect(assistant.body.accountId).toBe(alice.id);
  });

  test('on a device she paired, her code session starts', async () => {
    const code = (await call(alice.token, 'POST', '/api/pairing', { kind: 'device' })).body.code;
    const reg = await fetch(`${running.url}/api/daemon/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'alice-laptop' }) }).then((r) => r.json());
    const r = await call(alice.token, 'POST', '/api/sessions', { agent: 'coder', device: reg.deviceId, cwd: '/home/alice/app' });
    expect(r.status).toBe(200);
    expect(r.body.device).toBe(reg.deviceId);
  });

  test("the owner's code session on the hub starts as before", async () => {
    const r = await call(OWNER, 'POST', '/api/sessions', { agent: 'coder', cwd: t.cwd });
    expect(r.status).toBe(200);
    expect(r.body.device).toBe('local');
  });
});
