/**
 * Hubs for the friends tests: a fake engine (temp home, real sqlite and
 * config) served on its own port, with a running job scheduler for the
 * outbox and short waits, so two of them can become friends in a test.
 */
import { JobScheduler } from '@conclave/core/scheduler/scheduler.ts';
import type { ConclaveConfig } from '@conclave/core/config/index.ts';
import type { EngineEvent } from '@conclave/core/types.ts';
import { startServer, type RunningServer } from '../src/app';
import type { PeerOptions } from '../src/peer/service';
import { createFakeEngine, type FakeEngine } from './fake-engine';
import { OWNER } from './helpers';

export interface PeerHub {
  name: string;
  engine: FakeEngine;
  scheduler: JobScheduler;
  running?: RunningServer;
  url: string;
  port: number;
  events: EngineEvent[];
  api<T = any>(path: string, init?: { method?: string; json?: unknown }): Promise<{ status: number; body: T }>;
  /** Serve again (on the same port unless given). */
  start(port?: number): void;
  /** Stop serving; the engine, database and keys stay. */
  stop(): Promise<void>;
  /** The address friends get: server.publicUrl. */
  setPublicUrl(url: string): void;
  close(): Promise<void>;
}

/** Short waits, and loopback addresses taken: these hubs all listen on 127.0.0.1. */
export const FAST: PeerOptions = { backoff: () => 120, addressDelayMs: 0, firstPullMs: 0, pullEveryMs: 60_000, timeoutMs: 3_000, loopback: true };

export function makePeerHub(name: string, opts: PeerOptions = {}): PeerHub {
  const engine = createFakeEngine();
  const scheduler = new JobScheduler({ repos: engine.repos, maxSleepMs: 100 });
  scheduler.start();
  const events: EngineEvent[] = [];
  engine.bus.on((e) => void events.push(e));
  const hub: PeerHub = {
    name,
    engine,
    scheduler,
    url: '',
    port: 0,
    events,
    async api(path, init = {}) {
      const res = await fetch(hub.url + path, {
        method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
        headers: { authorization: `Bearer ${OWNER}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      });
      const text = await res.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, body };
    },
    start(port = hub.port) {
      hub.running = startServer(engine, { host: '127.0.0.1', port, peer: { ...FAST, scheduler, ...opts } });
      hub.url = hub.running.url;
      hub.port = hub.running.server.port ?? port;
    },
    async stop() {
      await hub.running?.stop();
      hub.running = undefined;
    },
    setPublicUrl(url: string) {
      engine.config.update({ server: { publicUrl: url } } as Partial<ConclaveConfig>);
    },
    async close() {
      await hub.stop();
      scheduler.stop();
      engine.cleanup();
    },
  };
  hub.start(0);
  hub.setPublicUrl(hub.url);
  return hub;
}

/** Poll until `fn` returns something truthy. */
export async function waitFor<T>(what: string, fn: () => T | Promise<T>, ms = 8_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** Make two hubs friends: an invite on `a`, used on `b`, accepted on `a`. Returns each side's friend id for the other. */
export async function befriend(a: PeerHub, b: PeerHub): Promise<{ bOnA: string; aOnB: string }> {
  const invite = await a.api('/api/friends/invites', { json: { name: a.name } });
  if (invite.status !== 200) throw new Error(`invite: ${JSON.stringify(invite.body)}`);
  const accepted = await b.api('/api/friends/accept', { json: { link: invite.body.link, name: b.name } });
  if (accepted.status !== 200) throw new Error(`accept: ${JSON.stringify(accepted.body)}`);
  const pending = await waitFor('the request on a', async () => (await a.api('/api/friends')).body.find((f: any) => f.status === 'pending' && f.name === b.name));
  const ok = await a.api(`/api/friends/${pending.id}/accept`, { method: 'POST' });
  if (ok.status !== 200) throw new Error(`accept request: ${JSON.stringify(ok.body)}`);
  await waitFor('b to see the accept', async () => (await b.api(`/api/friends/${accepted.body.id}`)).body.status === 'active');
  return { bOnA: pending.id, aOnB: accepted.body.id };
}
