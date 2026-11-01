import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { DeviceRegistry } from '../../src/machine/registry';
import type { Device, EngineEventEnvelope } from '../../src/types';
import { FakeMachine, waitFor } from './fake-machine';

function setup() {
  const repos = new Repos(openDb(':memory:'));
  const bus = new EventBus();
  const events: EngineEventEnvelope[] = [];
  bus.on((e) => events.push(e));
  const local = new FakeMachine('local', 'hub box');
  const reg = new DeviceRegistry({ local, repos, bus });
  return { repos, bus, events, local, reg };
}

describe('DeviceRegistry', () => {
  test('local is always there and online', async () => {
    const { reg, local } = setup();
    // the registry hands out the machine behind the account guard (people/guard.ts): the same machine, wrapped
    expect(reg.get('local')?.id).toBe(local.id);
    expect(await reg.get('local')!.info()).toEqual(await local.info());
    expect(reg.isOnline('local')).toBe(true);
    const [hub] = reg.list();
    expect(hub.id).toBe('local');
    expect(hub.online).toBe(true);
    await waitFor(() => !!reg.list()[0].info, 1000, 'local info');
    expect(reg.list()[0].info?.hostname).toBe('fakebox');
  });

  test("the owner's name for the hub device wins over the host name, and outlives a restart", () => {
    const { reg, repos, bus, events, local } = setup();
    expect(reg.list()[0].name).toBe('hub box');
    const hub = reg.renameHub('Home server');
    expect(hub).toMatchObject({ id: 'local', name: 'Home server' });
    expect(events.some((e) => e.type === 'device.updated' && e.device.id === 'local' && e.device.name === 'Home server')).toBe(true);
    // a new registry on the same database (the hub restarted) keeps it
    expect(new DeviceRegistry({ local, repos, bus }).list()[0].name).toBe('Home server');
  });

  test('attach and detach merge db rows with online state and emit events', async () => {
    const { reg, repos, events } = setup();
    repos.devices.insert({ id: 'dev_a', name: 'Laptop', tokenHash: 'x' });
    repos.devices.insert({ id: 'dev_b', name: 'Desktop', tokenHash: 'y' });
    expect(reg.list().map((d) => [d.id, d.online])).toEqual([
      ['local', true],
      ['dev_b', false],
      ['dev_a', false],
    ]);
    const remote = new FakeMachine('dev_a', 'Laptop');
    const info = { hostname: 'laptop', platform: 'darwin', arch: 'arm64', home: '/Users/me', shell: '/bin/zsh', clis: {}, capabilities: [] };
    const device: Device = { ...repos.devices.get('dev_a')!, online: true, info };
    reg.attach(device, remote);
    expect(reg.get('dev_a')?.id).toBe(remote.id);
    expect(await reg.get('dev_a')!.info()).toEqual(await remote.info());
    expect(reg.isOnline('dev_a')).toBe(true);
    const listed = reg.list();
    expect(listed[1].id).toBe('dev_a');
    expect(listed[1].online).toBe(true);
    expect(repos.devices.get('dev_a')?.info?.hostname).toBe('laptop');
    expect(repos.devices.get('dev_a')?.lastSeenAt).toBeGreaterThan(0);
    const up = events.filter((e) => e.type === 'device.updated');
    expect(up.length).toBe(1);
    expect(up[0].type === 'device.updated' && up[0].device.online).toBe(true);

    reg.detach('dev_a');
    expect(reg.get('dev_a')).toBeUndefined();
    expect(reg.isOnline('dev_a')).toBe(false);
    const last = events.at(-1)!;
    expect(last.type === 'device.updated' && last.device.id === 'dev_a' && last.device.online === false).toBe(true);
    // detaching twice is a no-op
    const n = events.length;
    reg.detach('dev_a');
    expect(events.length).toBe(n);
  });

  test('"local" cannot be attached', () => {
    const { reg } = setup();
    expect(() => reg.attach({ id: 'local', name: 'x', online: true, roots: [], createdAt: 0 }, new FakeMachine())).toThrow();
  });
});
