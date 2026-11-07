/**
 * Notes (the to-do strip at the top of Chat and Code) are tasks with the
 * "note" label, kept per account (docs/design/ACCOUNTS.md). A member sees and
 * changes only their own notes; the owner's stay out of their list.
 *
 *   bun test packages/server/test/notes-isolation.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-notes-isolation-0123456789';
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
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
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

describe('notes per account', () => {
  test("a member's notes are their own", async () => {
    const mine = await call(OWNER, 'POST', '/api/tasks', { title: 'Call the bank', labels: ['note'], meta: { noteOrder: 1 } });
    const hers = await call(alice, 'POST', '/api/tasks', { title: 'Buy milk', labels: ['note'], meta: { noteOrder: 1 } });
    expect(hers.body.labels).toEqual(['note']);
    expect(hers.body.meta).toEqual({ noteOrder: 1 });

    const titles = async (token: string) => ((await call(token, 'GET', '/api/tasks')).body as any[]).filter((x) => x.labels.includes('note')).map((x) => x.title);
    expect(await titles(alice)).toEqual(['Buy milk']);
    expect(await titles(OWNER)).toContain('Call the bank');
    expect(await titles(OWNER)).not.toContain('Buy milk');

    // checking off, editing or deleting the owner's note is refused for her
    expect((await call(alice, 'PATCH', `/api/tasks/${mine.body.id}`, { status: 'done' })).status).toBe(404);
    expect((await call(alice, 'DELETE', `/api/tasks/${mine.body.id}`)).status).toBe(404);
    expect(t.engine.repos.tasks.get(mine.body.id)?.status).toBe('todo');

    // her own checks off
    expect((await call(alice, 'PATCH', `/api/tasks/${hers.body.id}`, { status: 'done' })).body.status).toBe('done');
  });
});
