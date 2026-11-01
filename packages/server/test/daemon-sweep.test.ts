import { afterAll, describe, expect, test } from 'bun:test';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import { PROTOCOL_VERSION } from '@conclave/core/machine/protocol.ts';
import { DaemonHub, type DaemonSocketData } from '../src/ws/daemons';

/**
 * The sweep's stall guard (optimisation review 2026-11-01, fix 2): when the
 * hub's own event loop stalls, every device's lastHeard is stale and the sweep
 * would close healthy sockets. A tick that fired more than 2 heartbeats late
 * pings instead of closing; the next on-time round decides.
 */
const HB = 20_000;

const engine = {
  version: 'test',
  repos: { devices: { get: (id: string) => ({ id, name: 'Box' }), seen: () => {} } },
  devices: { attach: () => {}, detach: () => {} },
} as unknown as EngineApi;

interface FakeWs {
  data: DaemonSocketData;
  send(raw: string): number;
  close(code?: number, reason?: string): void;
}

function connectedHub(now: () => number): { hub: DaemonHub; ws: FakeWs; closed: Array<{ code?: number; reason?: string }>; pings: string[] } {
  const closed: Array<{ code?: number; reason?: string }> = [];
  const pings: string[] = [];
  const ws: FakeWs = {
    data: { kind: 'daemon', deviceId: 'dev1' },
    send: (raw) => {
      if (raw.includes('"ping"')) pings.push(raw);
      return 1;
    },
    close: (code, reason) => closed.push({ code, reason }),
  };
  const hub = new DaemonHub(engine, { heartbeatMs: HB, now });
  hub.open(ws as never);
  hub.message(ws as never, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, deviceId: 'dev1', info: { hostname: 'box', platform: 'linux', arch: 'x64' } }));
  return { hub, ws, closed, pings };
}

const sweep = (hub: DaemonHub) => (hub as unknown as { sweep(hb: number): void }).sweep(HB);

const hubs: DaemonHub[] = [];
afterAll(() => {
  for (const h of hubs) h.dispose();
});

describe('the daemon sweep stall guard', () => {
  test('a late tick sends no 4008; the next on-time tick closes a still-silent device', () => {
    let t = 0;
    const { hub, closed, pings } = connectedHub(() => t);
    hubs.push(hub);
    // the hub stalled: this tick fires 10 heartbeats late, so lastHeard (t 0) is stale for every device
    t += HB * 10;
    sweep(hub);
    expect(closed).toEqual([]);
    expect(pings.length).toBeGreaterThan(0);
    // on time again and still silent: closed
    t += HB;
    sweep(hub);
    expect(closed).toEqual([{ code: 4008, reason: 'heartbeat timeout' }]);
  });

  test('a queued reply after a stall keeps the device connected', () => {
    let t = 0;
    const { hub, ws, closed } = connectedHub(() => t);
    hubs.push(hub);
    t += HB * 10;
    sweep(hub);
    hub.message(ws as never, JSON.stringify({ type: 'pong', ts: t }));
    t += HB;
    sweep(hub);
    expect(closed).toEqual([]);
  });

  test('on-time ticks still close a really silent device', () => {
    let t = 0;
    const { hub, closed } = connectedHub(() => t);
    hubs.push(hub);
    for (let i = 1; i <= 4; i++) {
      t += HB;
      sweep(hub);
    }
    expect(closed).toEqual([{ code: 4008, reason: 'heartbeat timeout' }]);
  });
});
