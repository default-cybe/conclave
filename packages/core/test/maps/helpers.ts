/** A maps service on a real database and kv, pointed at the fake Google and OpenStreetMap servers. */
import { join } from 'node:path';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import type { MapsConfig } from '../../src/config/schema';
import { MapsService } from '../../src/maps/service';
import type { CalendarPort } from '../../src/maps/leave-by';
import { tempHome } from '../memory/helpers';
import { FAKE_KEY, HOME, startFakeGoogle, startFakeOsm, type FakeGoogle, type FakeOsm } from './fakes';

export interface MapsFixture {
  maps: MapsService;
  google: FakeGoogle;
  osm: FakeOsm;
  config(): MapsConfig;
  setConfig(c: MapsConfig): void;
  key(): string | undefined;
  repos: Repos;
  tileDir: string;
  /** Requests to both fakes, Google first. */
  all(): Array<{ path: string; query: Record<string, string>; headers: Record<string, string>; body?: unknown }>;
  cleanup(): void;
}

export function makeMaps(opts: { key?: string | null; config?: MapsConfig; now?: () => number; calendar?: CalendarPort; zone?: string } = {}): MapsFixture {
  const home = tempHome();
  const google = startFakeGoogle();
  const osm = startFakeOsm();
  const db = openDb(':memory:');
  const repos = new Repos(db);
  let cfg: MapsConfig = {
    home: { ...HOME },
    osm: { email: 'owner@example.org', nominatimUrl: osm.url, osrmUrl: osm.url, tileUrl: osm.tileUrl },
    ...(opts.config ?? {}),
  };
  let key: string | undefined = opts.key === null ? undefined : (opts.key ?? FAKE_KEY);
  const tileDir = join(home.dir, 'tiles');
  const maps = new MapsService({
    config: () => cfg,
    setConfig: (n) => {
      cfg = n;
    },
    key: () => (key ? { key, from: 'hub' } : {}),
    setKey: (k) => {
      key = k;
    },
    kv: repos.kv,
    db,
    zone: () => opts.zone ?? 'Europe/Berlin',
    tileDir,
    version: 'test',
    googleBase: () => google.url,
    // a safety net: a test that tries a real server fails instead of calling it
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      if (!u.startsWith('http://127.0.0.1:')) return Promise.reject(new Error(`a test tried to reach ${u.split('?')[0]}`));
      return fetch(url, init);
    }) as typeof fetch,
    osmSpacingMs: 30,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.calendar ? { calendar: () => opts.calendar! } : {}),
  });
  return {
    maps,
    google,
    osm,
    config: () => cfg,
    setConfig: (c) => {
      cfg = c;
    },
    key: () => key,
    repos,
    tileDir,
    all: () => [...google.requests, ...osm.requests],
    cleanup: () => {
      google.stop();
      osm.stop();
      db.close();
      home.cleanup();
    },
  };
}
