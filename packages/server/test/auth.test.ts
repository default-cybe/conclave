import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;

beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

describe('auth', () => {
  test('health is public', async () => {
    const res = await hub.api('/api/health', { token: null });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test('owner token works, missing and bad tokens get 401', async () => {
    expect((await hub.api('/api/info')).status).toBe(200);
    const none = await hub.api('/api/info', { token: null });
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'unauthorized' });
    expect((await hub.api('/api/info', { token: 'nope' })).status).toBe(401);
    expect((await hub.api('/api/info', { token: 'owner-token-0123456789abcdeX' })).status).toBe(401);
    // ?token= is only for the websocket
    expect((await fetch(`${hub.url}/api/info?token=owner-token-0123456789abcdef`)).status).toBe(401);
  });

  test('pairing flow gives a working client token that can be revoked', async () => {
    const res = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } });
    expect(res.status).toBe(200);
    const pairing = await res.json();
    expect(pairing.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(pairing.url).toBe(hub.url);
    expect(pairing.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(pairing.deepLink).toBe(`conclave://pair?url=${encodeURIComponent(hub.url)}&code=${pairing.code}&fp=${pairing.fingerprint}`);
    expect(pairing.qrSvg).toStartWith('<svg');
    expect(pairing.expiresAt).toBeGreaterThan(Date.now());

    const client = new ConclaveClient({ baseUrl: hub.url });
    const paired = await client.pair(pairing.code.toLowerCase(), 'Pixel', 'android');
    expect(paired.token).toStartWith('ccl_');
    expect(paired.hub.name).toBe('test hub');
    expect(paired.identity?.fingerprint).toBe(pairing.fingerprint);
    expect(paired.hub.fingerprint).toBe(pairing.fingerprint);
    // the code is single use
    await expect(client.pair(pairing.code, 'again', 'android')).rejects.toThrow('That pairing code is wrong or has expired');

    client.token = paired.token;
    expect((await client.info()).version).toBe('0.0.0-test');
    // only a hash is stored
    const row = hub.engine.repos.db.query('SELECT token_hash FROM clients WHERE id = ?').get(paired.clientId) as { token_hash: string };
    expect(row.token_hash).not.toContain(paired.token);
    expect(row.token_hash).toHaveLength(64);

    // clients do not see the owner token in config
    const cfg = await client.config();
    expect((cfg.config as any).server.token).toBeUndefined();
    const ownerCfg = await hub.api('/api/config').then((r) => r.json());
    expect(ownerCfg.config.server.token).toBe('owner-token-0123456789abcdef');

    // the owner's apps sign each other out (Settings, Your account, Signed in), an app signs itself out, and so does the hub token
    const pairApp = async (name: string) => new ConclaveClient({ baseUrl: hub.url }).pair((await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json())).code, name, 'web');
    const other = await pairApp('Laptop');
    const lost = await pairApp('Old tablet');
    expect((await hub.api(`/api/clients/${lost.clientId}`, { method: 'DELETE', token: other.token })).status).toBe(200);
    expect((await hub.api('/api/info', { token: lost.token })).status).toBe(401);
    expect((await hub.api(`/api/clients/${other.clientId}`, { method: 'DELETE', token: other.token })).status).toBe(200);
    expect((await hub.api('/api/info', { token: other.token })).status).toBe(401);
    expect((await hub.api(`/api/clients/${paired.clientId}`, { method: 'DELETE' })).status).toBe(200);
    await expect(client.info()).rejects.toThrow('unauthorized');
  });

  test('a device code cannot be used to pair a client and vice versa', async () => {
    const dev = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
    const res = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: dev.code, name: 'x', platform: 'web' } });
    expect(res.status).toBe(400);
    const cli = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const reg = await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: cli.code, name: 'pc' } });
    expect(reg.status).toBe(400);
  });

  test('device tokens only work on /api/daemon', async () => {
    const dev = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
    const reg = await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: dev.code, name: 'pc' } });
    expect(reg.status).toBe(200);
    const { deviceId, token } = await reg.json();
    expect(token).toStartWith('cdv_');
    expect((await hub.api('/api/info', { token })).status).toBe(401);
    expect(hub.engine.repos.devices.tokenHash(deviceId)).toHaveLength(64);
    // the daemon endpoint refuses bad device credentials before upgrading
    const bad = await fetch(`${hub.url}/api/daemon`, { headers: { authorization: `Bearer ${token}x`, 'x-conclave-device': deviceId, upgrade: 'websocket' } });
    expect(bad.status).toBe(401);
    const owner = await fetch(`${hub.url}/api/daemon`, { headers: { authorization: `Bearer owner-token-0123456789abcdef`, 'x-conclave-device': deviceId } });
    expect(owner.status).toBe(401);
  });

  test('gateway keys do not unlock the API', async () => {
    const key = await hub.api('/api/gateway/keys', { method: 'POST', json: { name: 'claude code' } }).then((r) => r.json());
    expect(key.key).toStartWith('cgw_');
    expect((await hub.api('/api/info', { token: key.key })).status).toBe(401);
  });

  test('/api/pair is rate limited per IP', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: 'AAAA-BBBB', name: 'x' }, headers: { 'x-forwarded-for': '203.0.113.9' } });
      last = r.status;
      if (i < 10) expect(r.status).toBe(400);
    }
    expect(last).toBe(429);
    // another IP is unaffected
    const other = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: 'AAAA-BBBB', name: 'x' }, headers: { 'x-forwarded-for': '203.0.113.10' } });
    expect(other.status).toBe(400);
  });

  test('CORS allows local app origins and not random sites', async () => {
    const pre = await fetch(`${hub.url}/api/info`, { method: 'OPTIONS', headers: { origin: 'tauri://localhost', 'access-control-request-method': 'GET' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    const evil = await fetch(`${hub.url}/api/info`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});
