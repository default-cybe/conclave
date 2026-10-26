import { afterEach, describe, expect, test } from 'bun:test';
import { RemoteMachine } from '../../src/machine/remote';
import { MAX_READ_BYTES, encodeBase64, type HubMessage } from '../../src/machine/protocol';
import { OfflineMachine, RECONNECT_WAIT, waitForReturn } from '../../src/projects/offline';
import { EventBus } from '../../src/util/bus';
import type { Machine } from '../../src/machine/types';
import type { Device } from '../../src/types';

const INFO = { hostname: 'pc', platform: 'linux', arch: 'x64', home: '/home/u', shell: '/bin/sh' } as any;

/** A RemoteMachine whose daemon holds one file of `size` bytes and answers in a microtask. */
function remote(size: number, protocol: number) {
  const data = new Uint8Array(size).map((_, i) => i % 251);
  const asked: Array<{ method: string; length?: number }> = [];
  const m: RemoteMachine = new RemoteMachine({
    id: 'pc',
    name: 'PC',
    info: INFO,
    protocol,
    send: (msg: HubMessage) => {
      if (msg.type !== 'rpc') return;
      const p = msg.params as { offset?: number; length?: number };
      asked.push({ method: msg.method, length: p.length });
      const result =
        msg.method === 'stat' ? { type: 'file', size, mtimeMs: 1 } : msg.method === 'readRange' ? encodeBase64(data.subarray(p.offset!, p.offset! + p.length!)) : encodeBase64(data);
      queueMicrotask(() => m.handleMessage({ type: 'result', id: msg.id, result } as any));
    },
  });
  return { m, asked, data };
}

describe('RemoteMachine reads in replies the hub socket takes', () => {
  test('a file over the reply limit comes in pieces and arrives whole', async () => {
    const { m, asked, data } = remote(2 * MAX_READ_BYTES + 10, 2);
    const got = await m.readFile('/big');
    expect(got.byteLength).toBe(data.byteLength);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(data))).toBe(0);
    expect(asked.map((a) => a.method)).toEqual(['readRange', 'readRange', 'readRange']);
    expect(Math.max(...asked.map((a) => a.length!))).toBeLessThanOrEqual(MAX_READ_BYTES);
  });

  test('a file of exactly two replies ends on one empty read', async () => {
    const { m, asked, data } = remote(2 * MAX_READ_BYTES, 2);
    const got = await m.readFile('/even');
    expect(Buffer.compare(Buffer.from(got), Buffer.from(data))).toBe(0);
    expect(asked.map((a) => a.method)).toEqual(['readRange', 'readRange', 'readRange']);
  });

  test('a small file is one round trip', async () => {
    const { m, asked } = remote(5, 2);
    expect((await m.readText('/small')).length).toBe(5);
    expect(asked).toHaveLength(1);
  });

  test('a daemon without readRange is not asked for a file over the limit', async () => {
    const { m, asked } = remote(MAX_READ_BYTES + 1, 1);
    await expect(m.readFile('/big')).rejects.toMatchObject({ code: 'E2BIG' });
    expect(asked.map((a) => a.method)).toEqual(['stat']);
  });
});

describe('a call on a device that just dropped', () => {
  const saved = { ...RECONNECT_WAIT };
  afterEach(() => Object.assign(RECONNECT_WAIT, saved));

  function hub(lastSeenAt: number) {
    const bus = new EventBus();
    const live = new Map<string, Machine>();
    const row = { id: 'pc', name: 'PC', lastSeenAt, roots: [], createdAt: 0 } as unknown as Device;
    const devices = { get: (id: string) => live.get(id), list: () => [row] };
    const waits = { n: 0 };
    const ran: string[] = [];
    const offline = new OfflineMachine('pc', 'PC', INFO, () => (waits.n++, waitForReturn(devices, bus, 'pc')));
    const back = () => {
      live.set('pc', {
        stat: async () => ({ type: 'file', size: 3, mtimeMs: 1 }),
        exec: async (cmd: string) => (ran.push(cmd), { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
      } as unknown as Machine);
      bus.emit({ type: 'device.updated', device: { ...row, online: true } } as any);
    };
    return { offline, back, waits, ran };
  }

  test('runs once the device is back within the wait', async () => {
    const { offline, back } = hub(Date.now() - 2_000);
    const call = offline.stat('/f');
    setTimeout(back, 30);
    expect(await call).toMatchObject({ size: 3 });
  });

  test('fails with the offline message when the device stays away', async () => {
    RECONNECT_WAIT.ms = 50;
    const { offline } = hub(Date.now() - 2_000);
    await expect(offline.stat('/f')).rejects.toThrow('PC is offline. Wait, or run on another device.');
  });

  test('waits once: later calls after a failed wait fail at once', async () => {
    RECONNECT_WAIT.ms = 50;
    const { offline, waits } = hub(Date.now() - 2_000);
    await expect(offline.stat('/f')).rejects.toThrow('PC is offline');
    const t0 = Date.now();
    await expect(offline.readText('/f')).rejects.toThrow('PC is offline');
    expect(Date.now() - t0).toBeLessThan(40);
    expect(waits.n).toBe(1);
  });

  test('stop during the wait ends exec, and it does not run when the device comes back', async () => {
    const { offline, back, ran } = hub(Date.now() - 2_000);
    const ac = new AbortController();
    const call = offline.exec('rm -rf build', { cwd: '/', signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await call).toMatchObject({ aborted: true, exitCode: null });
    back();
    await new Promise((r) => setTimeout(r, 10));
    expect(ran).toEqual([]);
  });

  test('a device away longer than a minute fails at once', async () => {
    const { offline } = hub(Date.now() - 5 * 60_000);
    const t0 = Date.now();
    await expect(offline.stat('/f')).rejects.toThrow('PC is offline. Wait, or run on another device.');
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
