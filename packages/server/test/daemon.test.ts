import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runDaemon, type DaemonHandle } from '@conclave/core/machine/daemon.ts';
import type { EngineEventEnvelope } from '@conclave/core/types.ts';
import { FakeMachine, readAll, waitFor } from '../../core/test/machine/fake-machine';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
const daemons: DaemonHandle[] = [];

beforeAll(() => {
  hub = startHub({ heartbeatMs: 1000 });
});
afterAll(async () => {
  for (const d of daemons) d.stop();
  await hub.stop();
});

async function register(name: string): Promise<{ deviceId: string; token: string }> {
  const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
  const res = await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: pairing.code, name } });
  expect(res.status).toBe(200);
  return res.json();
}

describe('daemon through the real server', () => {
  test('register, connect, attach to the engine, run tools, detach on close', async () => {
    const events: EngineEventEnvelope[] = [];
    hub.engine.bus.on((e) => events.push(e));
    const { deviceId, token } = await register('Work PC');
    const machine = new FakeMachine('pc', 'pc');
    await machine.writeFile('/home/me/todo.txt', 'ship it');
    const d = runDaemon({ hubUrl: hub.url, deviceId, token, machine, name: 'pc', maxBackoffMs: 200 });
    daemons.push(d);
    await waitFor(() => hub.engine.devices.isOnline(deviceId), 3000, 'device online');
    await waitFor(() => d.state === 'online', 2000, 'daemon online');

    const listed = hub.engine.devices.list().find((x) => x.id === deviceId)!;
    expect(listed).toMatchObject({ name: 'Work PC', online: true });
    expect(listed.info?.hostname).toBe('fakebox');
    expect(events.some((e) => e.type === 'device.updated' && e.device.id === deviceId && e.device.online)).toBe(true);

    const remote = hub.engine.devices.get(deviceId)!;
    expect(remote.name).toBe('Work PC');
    expect(await remote.readText('/home/me/todo.txt')).toBe('ship it');
    const r = await remote.exec('echo from the hub', { cwd: '/home/me' });
    expect(r.stdout).toBe('from the hub\n');
    const p = remote.spawn('cat', [], { cwd: '/' });
    p.write('round trip');
    const out = readAll(p.stdout);
    await Bun.sleep(20);
    p.closeStdin();
    expect(await p.exited).toBe(0);
    expect(await out).toBe('round trip');

    // the REST file browser goes through the same machine
    const files = await hub.api(`/api/devices/${deviceId}/files?path=/home/me`).then((r) => r.json());
    expect(files.map((f: { name: string }) => f.name)).toEqual(['todo.txt']);

    d.stop();
    await waitFor(() => !hub.engine.devices.isOnline(deviceId), 3000, 'device offline');
    expect(events.some((e) => e.type === 'device.updated' && e.device.id === deviceId && !e.device.online)).toBe(true);
    expect(hub.engine.repos.devices.get(deviceId)?.lastSeenAt).toBeGreaterThan(0);
  });

  test('the computer a browser runs on: the one daemon from its address, else the hub for a browser on it', async () => {
    const here = () => hub.api('/api/devices/here').then((r) => r.json());
    expect(await here()).toEqual({ device: 'local' });
    const { deviceId, token } = await register('Desk');
    const d = runDaemon({ hubUrl: hub.url, deviceId, token, machine: new FakeMachine('desk', 'desk'), maxBackoffMs: 200 });
    daemons.push(d);
    await waitFor(() => hub.engine.devices.isOnline(deviceId), 3000, 'device online');
    // the daemon and this browser both come from 127.0.0.1
    expect(await here()).toEqual({ device: deviceId });
    d.stop();
    await waitFor(() => !hub.engine.devices.isOnline(deviceId), 3000, 'device offline');
    expect(await here()).toEqual({ device: 'local' });
  });

  test('a second connection replaces the first, and deleting the device kicks it', async () => {
    const { deviceId, token } = await register('Laptop');
    const m1 = new FakeMachine('a', 'a');
    const m2 = new FakeMachine('b', 'b');
    const d1 = runDaemon({ hubUrl: hub.url, deviceId, token, machine: m1, maxBackoffMs: 10_000 });
    daemons.push(d1);
    await waitFor(() => hub.engine.devices.isOnline(deviceId), 3000, 'first online');
    const first = hub.engine.devices.get(deviceId);
    const d2 = runDaemon({ hubUrl: hub.url, deviceId, token, machine: m2, maxBackoffMs: 10_000 });
    daemons.push(d2);
    await waitFor(() => hub.engine.devices.get(deviceId) !== first && !!hub.engine.devices.get(deviceId), 3000, 'replaced');
    // the replaced socket closing must not detach the new one
    await Bun.sleep(50);
    expect(hub.engine.devices.isOnline(deviceId)).toBe(true);
    await hub.engine.devices.get(deviceId)!.stat('/');
    expect(m2.calls.length).toBeGreaterThan(0);
    d1.stop();

    const del = await hub.api(`/api/devices/${deviceId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    await waitFor(() => !hub.engine.devices.isOnline(deviceId), 3000, 'kicked');
    expect(hub.engine.repos.devices.get(deviceId)).toBeUndefined();
    d2.stop();
  });

  test('a daemon with a wrong token never comes online', async () => {
    const { deviceId } = await register('Bad');
    const statuses: string[] = [];
    const d = runDaemon({ hubUrl: hub.url, deviceId, token: 'cdv_wrong', machine: new FakeMachine(), maxBackoffMs: 50, onStatus: (s) => statuses.push(s.state) });
    daemons.push(d);
    await waitFor(() => statuses.filter((s) => s === 'offline').length >= 2, 3000, 'retries');
    expect(hub.engine.devices.isOnline(deviceId)).toBe(false);
    d.stop();
  });
});
