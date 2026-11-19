/**
 * A session's folder must be on its device (core machine/folder-check.ts):
 * the pickers ask GET /api/devices/:device/folder, and POST /api/sessions
 * with a cwd that is not there is a 400 with the words the pickers show.
 *
 *   bun test packages/server/test/folder-check.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-folder-check-0123456789';

let t: TestEngine;
let running: RunningServer;
const root = mkdtempSync(join(tmpdir(), 'folder-check-'));

async function call(method: string, path: string, json?: unknown, token = OWNER): Promise<{ status: number; body: any }> {
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
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

describe('folder check', () => {
  test('a cwd that is not on the device is refused with a clear 400; no session is made', async () => {
    const gone = join(root, 'does-not-exist');
    const before = t.engine.listSessions({}).length;
    const r = await call('POST', '/api/sessions', { agent: 'coder', cwd: gone });
    expect(r.status).toBe(400);
    const name = t.engine.devices.list().find((d) => d.id === 'local')!.name;
    expect(r.body.error).toBe(`No folder at ${gone} on ${name}`);
    expect(t.engine.listSessions({}).length).toBe(before);
  });

  test('a cwd that is there starts the session', async () => {
    const r = await call('POST', '/api/sessions', { agent: 'coder', cwd: root });
    expect(r.status).toBe(200);
    expect(r.body.cwd).toBe(root);
  });

  test('GET says whether it is there; POST makes it', async () => {
    const want = join(root, 'new', 'project');
    expect((await call('GET', `/api/devices/local/folder?path=${encodeURIComponent(want)}`)).body).toEqual({ path: want, exists: false });
    const made = await call('POST', '/api/devices/local/folder', { path: want });
    expect(made.status).toBe(200);
    expect(made.body).toEqual({ path: want, exists: true });
    expect(existsSync(want)).toBe(true);
    expect((await call('GET', `/api/devices/local/folder?path=${encodeURIComponent(want)}`)).body.exists).toBe(true);
  });

  test('a path with a NUL or line break is refused before it reaches the device', async () => {
    for (const bad of [`${root}/a\nb`, `${root}/a\u0000b`]) {
      expect((await call('POST', '/api/devices/local/folder', { path: bad })).status).toBe(400);
      expect((await call('GET', `/api/devices/local/folder?path=${encodeURIComponent(bad)}`)).status).toBe(400);
      expect((await call('GET', `/api/devices/local/files?path=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
    expect(existsSync(join(root, 'a'))).toBe(false);
  });

  test("a member cannot browse, make a folder or add a project on another account's device", async () => {
    const made = await call('POST', '/api/people', { name: 'bob', password: 'correct horse battery staple', providers: { mock: { monthlyUsd: 5 } } });
    expect(made.status).toBe(200);
    const login = (await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'bob', password: 'correct horse battery staple', name: 'bob web', platform: 'web' }) }).then((r) => r.json())) as { token: string };
    const want = join(root, 'bob-made');
    expect((await call('GET', `/api/devices/local/files?path=${encodeURIComponent(root)}`, undefined, login.token)).status).toBe(404);
    expect((await call('GET', `/api/devices/local/folder?path=${encodeURIComponent(root)}`, undefined, login.token)).status).toBe(404);
    expect((await call('POST', '/api/devices/local/folder', { path: want }, login.token)).status).toBe(404);
    expect((await call('POST', '/api/projects', { device: 'local', path: root, name: 'x' }, login.token)).status).toBe(404);
    expect(existsSync(want)).toBe(false);
    // the owner still lists it, folders and files
    expect((await call('GET', `/api/devices/local/files?path=${encodeURIComponent(root)}`)).status).toBe(200);
  });

  test('an unknown device answers 404, not a guess', async () => {
    expect((await call('GET', '/api/devices/nope/folder?path=/tmp')).status).toBe(404);
  });
});
