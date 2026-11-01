/** A calendar and mail service on an in-memory database with a secret map, and fetch locked to this machine. */
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { PimService, type PimEndpoints } from '../../src/pim';
import type { ShippedOAuthClients } from '../../src/mail/oauth-clients';

/** fetch that refuses anything but 127.0.0.1, so a test can never reach a real provider. */
export const localFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(`test tried to reach ${url.host}`);
    return fetch(input, init);
  },
  { preconnect: () => undefined },
) as typeof fetch;

export function makePim(opts: { zone?: string; now?: () => number; endpoints?: Partial<PimEndpoints>; shipped?: ShippedOAuthClients; publicUrl?: string } = {}) {
  const db = openDb(':memory:');
  const repos = new Repos(db);
  const secrets = new Map<string, string>();
  const told: Array<{ sessionId: string; text: string }> = [];
  const notices: Array<{ title: string; body: string }> = [];
  const pim = new PimService({
    db,
    kv: repos.kv,
    secret: (n) => secrets.get(n),
    setSecret: (n, v) => (v === undefined ? secrets.delete(n) : secrets.set(n, v)),
    zone: () => opts.zone ?? 'Europe/Berlin',
    ...(opts.now ? { now: opts.now } : {}),
    fetch: localFetch,
    ...(opts.endpoints ? { endpoints: opts.endpoints } : {}),
    ...(opts.shipped ? { shipped: opts.shipped } : {}),
    publicUrl: () => opts.publicUrl,
    loopbackUrl: () => 'http://127.0.0.1:7777',
    tellSession: (sessionId, text) => void told.push({ sessionId, text }),
    notify: (n) => void notices.push(n),
  });
  return { pim, db, repos, secrets, told, notices, cleanup: () => db.close() };
}
