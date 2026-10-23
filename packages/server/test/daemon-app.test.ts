/**
 * The daemon inside the desktop app: the app asks for a device code with its
 * own token, the daemon registers with it and can remove itself later.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runDaemon } from '@conclave/core/machine/daemon.ts';
import { FakeMachine, waitFor } from '../../core/test/machine/fake-machine';
import { NOT_PAIRED } from '../src/routes-daemon';
import { startHub, type TestHub } from './helpers';

// a hub per test: pairing is limited to 10 a minute per address
let hub: TestHub;
beforeEach(() => {
  hub = startHub({ heartbeatMs: 1000 });
});
afterEach(() => hub.stop());

/** Pair a desktop app the normal way and return its client token and id. */
async function pairApp(name = 'Desktop (arch)'): Promise<{ token: string; clientId: string }> {
  const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
  return hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name, platform: 'desktop' } }).then((r) => r.json());
}

async function deviceCode(token: string | null) {
  return hub.api('/api/daemon/pairing', { method: 'POST', token });
}

async function register(code: string, name = 'arch'): Promise<{ deviceId: string; token: string }> {
  const res = await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code, name } });
  expect(res.status).toBe(200);
  return res.json();
}

function unpair(deviceId: string, token: string) {
  return fetch(`${hub.url}/api/daemon/unpair`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-conclave-device': deviceId } });
}

describe('POST /api/daemon/pairing', () => {
  test('needs a token', async () => {
    expect((await deviceCode(null)).status).toBe(401);
    expect((await deviceCode('ccl_not-a-real-token')).status).toBe(401);
  });

  test('a paired app gets a short device code; pairing again keeps the same device with a new token', async () => {
    const app = await pairApp();
    const res = await deviceCode(app.token);
    expect(res.status).toBe(200);
    const first = await res.json();
    expect(first.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(first.expiresAt - Date.now()).toBeLessThanOrEqual(2 * 60_000);
    expect(first.addresses.length).toBeGreaterThan(0);
    // it is a plain device code: a client cannot pair with it
    expect((await hub.api('/api/pair', { method: 'POST', token: null, json: { code: first.code, name: 'x' } })).status).toBe(400);

    const second = await deviceCode(app.token).then((r) => r.json());
    const a = await register(second.code, 'arch');
    expect(hub.engine.repos.devices.get(a.deviceId)?.name).toBe('arch');

    // the switch off and on again (or the app lost its copy): same device, new token
    const third = await deviceCode(app.token).then((r) => r.json());
    const b = await register(third.code, 'arch-desktop');
    expect(b.deviceId).toBe(a.deviceId);
    expect(b.token).not.toBe(a.token);
    // the name stays as the hub has it (the owner may have renamed it)
    expect(hub.engine.repos.devices.get(a.deviceId)?.name).toBe('arch');
    expect(hub.engine.repos.devices.list().filter((d) => d.id === a.deviceId)).toHaveLength(1);
    expect(hub.running.conclave.ctx.auth.checkDevice(a.deviceId, a.token)).toBeUndefined();
    expect(hub.running.conclave.ctx.auth.checkDevice(a.deviceId, b.token)).toBe(a.deviceId);

    const audit = hub.engine.repos.audit.list({ limit: 50 }).map((r) => `${r.action} ${r.detail}`);
    expect(audit.some((l) => l.startsWith('pairing.create device for Desktop (arch)'))).toBe(true);
    expect(audit.some((l) => l.includes('paired again from its app'))).toBe(true);
  });

  test('a device removed on the Devices page is not brought back; the app gets a new one', async () => {
    const app = await pairApp();
    const a = await register((await deviceCode(app.token).then((r) => r.json())).code);
    expect((await hub.api(`/api/devices/${a.deviceId}`, { method: 'DELETE' })).status).toBe(200);
    const b = await register((await deviceCode(app.token).then((r) => r.json())).code);
    expect(b.deviceId).not.toBe(a.deviceId);
    expect(hub.engine.repos.devices.get(a.deviceId)).toBeUndefined();
  });

  test('the owner token gets a code too, but no link (it can sit in several apps)', async () => {
    const a = await register((await hub.api('/api/daemon/pairing', { method: 'POST' }).then((r) => r.json())).code);
    const b = await register((await hub.api('/api/daemon/pairing', { method: 'POST' }).then((r) => r.json())).code);
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  test('revoking the app removes the computer it shared', async () => {
    const app = await pairApp('Desktop (mac)');
    const d = await register((await deviceCode(app.token).then((r) => r.json())).code, 'macbook');
    expect((await hub.api(`/api/clients/${app.clientId}`, { method: 'DELETE' })).status).toBe(200);
    expect(hub.engine.repos.devices.get(d.deviceId)).toBeUndefined();
    expect(hub.running.conclave.ctx.auth.checkDevice(d.deviceId, d.token)).toBeUndefined();
  });
});

describe('POST /api/daemon/unpair', () => {
  test('a daemon removes itself with its own token; the hub kicks it and forgets it', async () => {
    const app = await pairApp();
    const d = await register((await deviceCode(app.token).then((r) => r.json())).code, 'arch');
    const daemon = runDaemon({ hubUrl: hub.url, deviceId: d.deviceId, token: d.token, machine: new FakeMachine('arch', 'arch'), maxBackoffMs: 10_000 });
    try {
      await waitFor(() => hub.engine.devices.isOnline(d.deviceId), 3000, 'online');

      // wrong token or no id: refused, and nothing changes
      expect((await unpair(d.deviceId, `${d.token}x`)).status).toBe(401);
      expect((await fetch(`${hub.url}/api/daemon/unpair`, { method: 'POST', headers: { authorization: `Bearer ${d.token}` } })).status).toBe(401);
      // a client or owner token is not a device token
      expect((await unpair(d.deviceId, app.token)).status).toBe(401);
      expect(hub.engine.repos.devices.get(d.deviceId)).toBeDefined();

      const res = await unpair(d.deviceId, d.token);
      expect(res.status).toBe(200);
      await waitFor(() => !hub.engine.devices.isOnline(d.deviceId), 3000, 'kicked');
      expect(hub.engine.repos.devices.get(d.deviceId)).toBeUndefined();
      expect(hub.engine.repos.audit.list({ limit: 20 }).some((r) => r.action === 'device.unpair' && r.device === d.deviceId)).toBe(true);

      // again: the hub does not know it, and says so in words the CLI looks for
      const again = await unpair(d.deviceId, d.token);
      expect(again.status).toBe(401);
      expect((await again.json()).error).toBe(NOT_PAIRED);

      // the app's next pairing makes a new device, since this one is gone
      const next = await register((await deviceCode(app.token).then((r) => r.json())).code);
      expect(next.deviceId).not.toBe(d.deviceId);
    } finally {
      daemon.stop();
    }
  });
});
