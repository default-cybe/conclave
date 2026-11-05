import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startHub, type TestHub } from './helpers';

/**
 * Every route the typed client calls must exist on the server. A missing
 * route falls through to the generic {error:'not found'}; handler 404s carry
 * a specific message, so they count as present.
 */
let hub: TestHub;
beforeAll(() => {
  // two routes reach the internet with an empty body (a GitHub release manifest, a DuckDuckGo search):
  // on a busy hub they took seconds and the test passed its 5 s timeout about 1 in 6 runs
  hub = startHub({ update: { fetch: (async () => { throw new Error('offline in tests'); }) as unknown as typeof fetch } });
});

/** Bodies that keep a route off the network: it still answers from its own handler, so it counts as present. */
const OFFLINE_BODY: Record<string, unknown> = { 'POST /api/websearch/test': { provider: 'offline-in-tests' } };
afterAll(() => hub.stop());

test('server implements every route in client/index.ts', async () => {
  const src = readFileSync(fileURLToPath(new URL('../../core/src/client/index.ts', import.meta.url)), 'utf8');
  const routes = new Set<string>();
  for (const m of src.matchAll(/(?:request|call)<.*?>\('(GET|POST|PUT|PATCH|DELETE)',\s*[`'](\/api[^`']*)[`']/g)) {
    routes.add(`${m[1]} ${m[2].replace(/\$\{[^}]+\}/g, 'x')}`);
  }
  expect(routes.size).toBeGreaterThan(80);
  const missing: string[] = [];
  for (const r of routes) {
    const [method, path] = r.split(' ');
    const res = await hub.api(path, { method, json: method === 'GET' || method === 'DELETE' ? undefined : (OFFLINE_BODY[r] ?? {}) });
    const body = await res.text();
    if (res.status === 404 && body === JSON.stringify({ error: 'not found' })) missing.push(r);
    expect(res.status).not.toBe(401);
  }
  expect(missing).toEqual([]);
});
