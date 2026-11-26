/**
 * Settings > Secrets (issue #266): GET /api/secrets lists named secrets
 * with names and metadata only, never a value, and only to the owner; a
 * member gets 403 on list, set and delete; a new name must follow
 * SECRET_NAME.
 *
 *   bun test packages/server/test/secrets-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@conclave/core/engine/index.ts';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-secrets-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const VALUE = 'caido-SECRET-value-9f8e7d6c5b4a';
const MANAGED_VALUE = 'tvly-managed-search-key-1234567';

let root: string;
let engine: Engine;
let running: RunningServer;
let member: string;

async function call(token: string, method: string, path: string, json?: unknown): Promise<{ status: number; text: string; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(running.url + path, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {}
  return { status: res.status, text, body };
}

beforeAll(async () => {
  process.env.CONCLAVE_CATALOG_OFFLINE ??= '1';
  root = mkdtempSync(join(tmpdir(), 'conclave-secrets-routes-'));
  engine = await createEngine({ home: join(root, 'home'), noBackground: true, version: 'test' });
  engine.config.update({ server: { ...engine.config.get().server, token: OWNER } });
  running = startServer(engine, { host: '127.0.0.1', port: 0 });
  expect((await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD })).status).toBe(200);
  const login = await fetch(running.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice laptop', platform: 'web' }) }).then((r) => r.json());
  member = login.token;
}, 60_000);

afterAll(async () => {
  await running?.stop();
  await engine?.shutdown();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('GET /api/secrets', () => {
  test('lists names, a prefix and when set, never the value', async () => {
    const before = Date.now();
    expect((await call(OWNER, 'PUT', '/api/secrets', { kind: 'values', key: 'caido-token', value: VALUE })).status).toBe(200);
    engine.config.setSecret('values', 'search.tavily', MANAGED_VALUE);
    const r = await call(OWNER, 'GET', '/api/secrets');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(VALUE);
    expect(r.text).not.toContain(MANAGED_VALUE);
    const own = r.body.values.find((s: any) => s.name === 'caido-token');
    expect(own.prefix).toBe('caid');
    expect(own.setAt).toBeGreaterThanOrEqual(before);
    expect(own.managedBy).toBeUndefined();
    // a name another page manages: read-only, with where, and no prefix
    const managed = r.body.values.find((s: any) => s.name === 'search.tavily');
    expect(managed.managedBy).toBe('Settings > Web search');
    expect(managed.prefix).toBeUndefined();
    // the Discover GitHub token box saves catalog.github-token: read-only too
    engine.config.setSecret('values', 'catalog.github-token', 'ghp_discoverTokenValue123456');
    const gh = (await call(OWNER, 'GET', '/api/secrets')).body.values.find((s: any) => s.name === 'catalog.github-token');
    expect(gh).toEqual({ name: 'catalog.github-token', setAt: expect.any(Number), managedBy: 'Extensions > Discover' });
    // a short value gets no prefix: 4 characters would nearly give it away
    expect((await call(OWNER, 'PUT', '/api/secrets', { kind: 'values', key: 'pin', value: 'abcd1' })).status).toBe(200);
    const pin = (await call(OWNER, 'GET', '/api/secrets')).body.values.find((s: any) => s.name === 'pin');
    expect(pin.prefix).toBeUndefined();
    // ${secret:name} reads it
    expect(engine.config.expand('${secret:caido-token}')).toBe(VALUE);
  });

  test('deleting removes the name and its time', async () => {
    expect((await call(OWNER, 'PUT', '/api/secrets', { kind: 'values', key: 'caido-token', value: null })).status).toBe(200);
    const r = await call(OWNER, 'GET', '/api/secrets');
    expect(r.body.values.some((s: any) => s.name === 'caido-token')).toBe(false);
  });
});

describe('a member', () => {
  test('gets 403 on list, set and delete of a hub secret', async () => {
    engine.config.setSecret('values', 'homelab-token', VALUE);
    const list = await call(member, 'GET', '/api/secrets');
    expect(list.status).toBe(403);
    expect(list.text).not.toContain(VALUE);
    expect((await call(member, 'PUT', '/api/secrets', { kind: 'values', key: 'homelab-token', value: 'mine' })).status).toBe(403);
    expect((await call(member, 'PUT', '/api/secrets', { kind: 'values', key: 'homelab-token', value: null })).status).toBe(403);
    expect(engine.config.secretValue('homelab-token')).toBe(VALUE);
  });
});

describe("a member's own secrets (GET/PUT /api/me/secrets)", () => {
  test('saved in their own file, read by ${secret:name} in their config only; the hub and the hub part untouched', async () => {
    engine.config.setSecret('values', 'shared-name', VALUE);
    const alice = engine.people.list().find((a) => a.name === 'alice')!.id;
    engine.accountSecrets.setHubValue(alice, 'cliproxy.key', 'hub-part-value-1234567');
    expect((await call(member, 'PUT', '/api/me/secrets', { key: 'shared-name', value: 'alice-own-value-123456' })).status).toBe(200);
    const list = await call(member, 'GET', '/api/me/secrets');
    expect(list.status).toBe(200);
    expect(list.body.values).toEqual([{ name: 'shared-name', prefix: 'alic' }]);
    expect(list.text).not.toContain('alice-own-value-123456');
    expect(list.text).not.toContain('hub-part');
    // the hub's value is the owner's and stays
    expect(engine.config.secretValue('shared-name')).toBe(VALUE);
    expect(engine.accountSecrets.value(alice, 'shared-name')).toBe('alice-own-value-123456');
    expect(engine.accountSecrets.hubValue(alice, 'cliproxy.key')).toBe('hub-part-value-1234567');
    // bad names and names other pages keep are refused
    for (const key of ['Bad Name', '__proto__', 'search.tavily', 'stt.deepgram', 'cliproxy.key']) expect((await call(member, 'PUT', '/api/me/secrets', { key, value: 'x' })).status).toBe(400);
    expect((await call(member, 'PUT', '/api/me/secrets', { key: 'shared-name', value: null })).status).toBe(200);
    expect(engine.accountSecrets.value(alice, 'shared-name')).toBeUndefined();
    // the owner's are the hub's, on GET /api/secrets
    expect((await call(OWNER, 'GET', '/api/me/secrets')).status).toBe(400);
  });

  test("a member's PATCH /api/me defaults never reach the hub config; PATCH /api/config stays the owner's", async () => {
    const before = JSON.stringify(engine.config.get());
    expect((await call(member, 'PATCH', '/api/me', { memory: { enabled: false }, hiddenModels: ['zai/*'] })).status).toBe(200);
    expect((await call(member, 'PATCH', '/api/me', { defaultModel: 'nope/not-a-model' })).status).toBe(400);
    expect((await call(member, 'PATCH', '/api/config', { defaultModel: 'nope/x', memory: { enabled: false } })).status).toBe(403);
    expect(JSON.stringify(engine.config.get())).toBe(before);
    const me = await call(member, 'GET', '/api/me');
    expect(me.body.preferences).toMatchObject({ memory: { enabled: false }, hiddenModels: ['zai/*'] });
    // their own memory switch shows in their config; the owner's stays the hub's
    expect((await call(member, 'GET', '/api/config')).body.config.memory.enabled).toBe(false);
    expect((await call(OWNER, 'GET', '/api/config')).body.config.memory.enabled).toBe(engine.config.get().memory.enabled);
    // the owner's own defaults are the hub's: these keys are not theirs on /api/me
    expect((await call(OWNER, 'PATCH', '/api/me', { memory: { enabled: false } })).status).toBe(400);
  });
});

describe('names', () => {
  test('a new name must be lowercase letters, digits, dots, dashes and underscores', async () => {
    for (const bad of ['Caido', 'has space', 'a/b', '../../etc/passwd', 'x'.repeat(65), '${x}', '__proto__', 'constructor']) {
      const r = await call(OWNER, 'PUT', '/api/secrets', { kind: 'values', key: bad, value: 'v' });
      expect(r.status).toBe(400);
      expect(engine.config.secretNames().values).not.toContain(bad);
    }
    for (const good of ['a', 'pve-token', 'my.server_key-2', 'x'.repeat(64)]) {
      expect((await call(OWNER, 'PUT', '/api/secrets', { kind: 'values', key: good, value: 'v' })).status).toBe(200);
    }
  });

  test("the hub's own names that do not follow it can still be replaced", async () => {
    engine.config.setSecret('values', 'cliproxy.managementKey', 'old');
    expect((await call(OWNER, 'PUT', '/api/secrets', { kind: 'values', key: 'cliproxy.managementKey', value: 'new' })).status).toBe(200);
    expect(engine.config.secretValue('cliproxy.managementKey')).toBe('new');
  });
});
