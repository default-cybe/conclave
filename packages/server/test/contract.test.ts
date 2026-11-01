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
  hub = startHub();
});
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
    const res = await hub.api(path, { method, json: method === 'GET' || method === 'DELETE' ? undefined : {} });
    const body = await res.text();
    if (res.status === 404 && body === JSON.stringify({ error: 'not found' })) missing.push(r);
    expect(res.status).not.toBe(401);
  }
  expect(missing).toEqual([]);
});
