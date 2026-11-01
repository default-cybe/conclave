/**
 * A member's own keys (docs/design/ACCOUNTS.md 2): maps key, home and daily
 * cap, web search keys and proxy. A real engine and server with the owner
 * and two members, alice and bob. Alice's land in accounts/<alice>/ or
 * acct:<alice>: kv, never in config.json, never visible to bob or the
 * owner's routes; the owner's maps key is never used for alice.
 *
 *   bun test packages/server/test/people-keys.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@conclave/core/engine/index.ts';
import { mapsOf, MEMBER_NO_KEY } from '@conclave/core/maps/index.ts';
import { runAs } from '@conclave/core/people/context.ts';
import { retryProxy } from '@conclave/core/tools/blocked.ts';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-keys-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const OWNER_MAPS = 'AIzaOWNER-maps-key-000000';
const ALICE_MAPS = 'AIzaALICE-maps-key-111111';
const ALICE_SEARCH = 'tvly-alice-search-key-2222';
const ALICE_PROXY_PW = 'alice-proxy-password-3333';

let root: string;
let home: string;
let engine: Engine;
let running: RunningServer;
const tok: Record<'alice' | 'bob', { token: string; id: string }> = {} as never;

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
  delete process.env.GOOGLE_MAPS_API_KEY;
  root = mkdtempSync(join(tmpdir(), 'conclave-people-keys-'));
  home = join(root, 'home');
  engine = await createEngine({ home, noBackground: true, version: 'test' });
  engine.config.update({ server: { ...engine.config.get().server, token: OWNER } });
  running = startServer(engine, { host: '127.0.0.1', port: 0 });
  for (const name of ['alice', 'bob'] as const) {
    const made = await call(OWNER, 'POST', '/api/people', { name, password: PASSWORD });
    const login = await fetch(running.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: name, password: PASSWORD, name: `${name} laptop`, platform: 'web' }) }).then((r) => r.json());
    tok[name] = { token: login.token, id: made.body.person.id };
  }
  expect((await call(OWNER, 'PUT', '/api/maps/key', { key: OWNER_MAPS })).status).toBe(200);
  expect((await call(OWNER, 'PATCH', '/api/maps', { home: '52.5,13.4', dailyCap: 300 })).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await running?.stop();
  await engine?.shutdown();
  if (root) rmSync(root, { recursive: true, force: true });
});

const configText = () => (existsSync(join(home, 'config.json')) ? readFileSync(join(home, 'config.json'), 'utf8') : '');

describe("a member's own maps", () => {
  test("alice with no key gets the refusal even though the owner has one; the owner's home never shows", async () => {
    const s = await call(tok.alice.token, 'GET', '/api/maps');
    expect(s.status).toBe(200);
    expect(s.body.google).toEqual({ keySet: false });
    expect(s.body.home).toBeUndefined();
    expect(s.text).not.toContain('52.5');
    await expect(runAs(tok.alice.id, () => mapsOf(engine)!.searchPlaces({ query: 'coffee' } as never))).rejects.toThrow(MEMBER_NO_KEY);
    expect((await call(tok.alice.token, 'PATCH', '/api/maps', { provider: 'osm' })).status).toBe(400);
  });

  test("alice's key, home and cap are hers: stored under her account, unseen by bob and the owner", async () => {
    const before = configText();
    expect((await call(tok.alice.token, 'PUT', '/api/maps/key', { key: ALICE_MAPS })).status).toBe(200);
    const s = await call(tok.alice.token, 'PATCH', '/api/maps', { home: '40.7,-74.0', dailyCap: 7 });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ dailyCap: 7, google: { keySet: true, keyFrom: 'own' }, home: { lat: 40.7, lng: -74 } });
    expect(s.text).not.toContain(ALICE_MAPS);
    expect(configText()).toBe(before);
    expect(engine.accountSecrets.value(tok.alice.id, 'google-maps')).toBe(ALICE_MAPS);
    expect(readFileSync(join(home, 'accounts', tok.alice.id, 'secrets.json'), 'utf8')).toContain(ALICE_MAPS);
    expect(engine.repos.kv.get<any>(`acct:${tok.alice.id}:maps.home`, undefined)).toMatchObject({ lat: 40.7 });

    const bob = await call(tok.bob.token, 'GET', '/api/maps');
    expect(bob.body).toMatchObject({ google: { keySet: false }, dailyCap: 300 });
    expect(bob.text).not.toContain('40.7');
    const owner = await call(OWNER, 'GET', '/api/maps');
    expect(owner.body).toMatchObject({ dailyCap: 300, google: { keySet: true, keyFrom: 'hub' }, home: { lat: 52.5 } });
    expect(owner.text).not.toContain('40.7');
    // the key each account's calls use
    const svc = mapsOf(engine) as any;
    expect(runAs(tok.alice.id, () => svc.keyNow().key)).toBe(ALICE_MAPS);
    expect(runAs(tok.bob.id, () => svc.keyNow().key)).toBeUndefined();
    expect(runAs('owner', () => svc.keyNow().key)).toBe(OWNER_MAPS);
  });

  test('the daily count is per account', async () => {
    const svc = mapsOf(engine) as any;
    const count = async (t: string) => (await call(t, 'GET', '/api/maps')).body.today.calls as number;
    const [a0, o0] = [await count(tok.alice.token), await count(OWNER)];
    runAs(tok.alice.id, () => svc.cap().take('places'));
    runAs(tok.alice.id, () => svc.cap().take('places'));
    expect(await count(tok.alice.token)).toBe(a0 + 2);
    expect(await count(tok.bob.token)).toBe(0);
    expect(await count(OWNER)).toBe(o0);
  });
});

describe("a member's own web search and proxy", () => {
  test("alice's search key is in her secrets; bob and the owner never see it; the hub's search only when the owner allows", async () => {
    const before = configText();
    const put = await call(tok.alice.token, 'PUT', '/api/websearch/key', { provider: 'tavily', key: ALICE_SEARCH });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(ALICE_SEARCH);
    expect(put.body.providers.find((p: any) => p.id === 'tavily')).toMatchObject({ keySet: true, keyFrom: 'own' });
    expect(engine.accountSecrets.value(tok.alice.id, 'search.tavily')).toBe(ALICE_SEARCH);
    expect(engine.config.secretValue('search.tavily')).toBeUndefined();
    expect(configText()).toBe(before);
    expect((await call(tok.bob.token, 'GET', '/api/websearch')).body.providers.find((p: any) => p.id === 'tavily').keySet).toBe(false);
    expect((await call(OWNER, 'GET', '/api/websearch')).body.providers.find((p: any) => p.id === 'tavily').keySet).toBe(false);
    expect((await call(tok.bob.token, 'GET', '/api/websearch')).body.hubAllowed).toBe(false);
    expect((await call(OWNER, 'PATCH', `/api/people/${tok.bob.id}`, { webSearch: true })).status).toBe(200);
    expect((await call(tok.bob.token, 'GET', '/api/websearch')).body.hubAllowed).toBe(true);
    expect((await call(tok.bob.token, 'PATCH', `/api/people/${tok.bob.id}`, { webSearch: true })).status).toBe(403);
  });

  test("alice's proxy is hers alone; bob has none and never gets the owner's", async () => {
    engine.config.setSecret('values', 'browser.proxy.password', 'owner-proxy-pw');
    const bad = await call(tok.alice.token, 'PUT', '/api/websearch/proxy', { provider: 'custom', url: 'http://127.0.0.1:3128' });
    expect(bad.status).toBe(400);
    const set = await call(tok.alice.token, 'PUT', '/api/websearch/proxy', { provider: 'custom', url: 'http://al@8.8.8.8:3128', password: ALICE_PROXY_PW });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ provider: 'custom', passwordSet: true });
    expect(set.text).not.toContain(ALICE_PROXY_PW);
    expect(engine.accountSecrets.value(tok.alice.id, 'browser.proxy.password')).toBe(ALICE_PROXY_PW);
    expect(engine.config.secretValue('browser.proxy.password')).toBe('owner-proxy-pw');
    expect((await call(tok.bob.token, 'GET', '/api/websearch/proxy')).body).toMatchObject({ provider: 'none', passwordSet: false });
    expect((await call(OWNER, 'GET', '/api/websearch/proxy')).status).toBe(400);
    const a = await retryProxy(tok.alice.id);
    expect('url' in a && a.url).toBe(`http://al:${ALICE_PROXY_PW}@8.8.8.8:3128`);
    const b = await retryProxy(tok.bob.id);
    expect('skip' in b).toBe(true);
  });
});
