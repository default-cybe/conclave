/**
 * Settings > Web search over HTTP (routes-websearch.ts): the engine list,
 * the choice and SearXNG address, a key going in as a hub secret and never
 * coming back out, the Test button against a fake SearXNG, and a member's own keys.
 *
 *   bun test packages/server/test/websearch-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { WebSearchSettingsDto, WebSearchTestResult } from '@conclave/core/client';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
let searx: ReturnType<typeof Bun.serve>;
const KEY = 'tvly-route-test-key-123456';

beforeAll(() => {
  for (const k of ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'JINA_API_KEY', 'SEARXNG_URL']) delete process.env[k];
  searx = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => (new URL(req.url).pathname === '/search' ? Response.json({ results: [{ title: 'SearXNG', url: 'https://searxng.org/', content: 'A metasearch engine' }] }) : new Response('no', { status: 404 })),
  });
  hub = startHub();
});

afterAll(async () => {
  await hub.stop();
  searx.stop(true);
});

const json = async <T>(r: Response) => (await r.json()) as T;

describe('web search settings', () => {
  test('lists the engines with their free allowance; DuckDuckGo until something is set', async () => {
    const s = await json<WebSearchSettingsDto>(await hub.api('/api/websearch'));
    expect(s.chosen).toBe('auto');
    expect(s.active).toBe('duckduckgo');
    expect(s.providers.map((p) => p.id)).toEqual(['tavily', 'exa', 'langsearch', 'linkup', 'firecrawl', 'youcom', 'serper', 'serpapi', 'jina', 'brave', 'searxng', 'duckduckgo']);
    expect(s.providers.find((p) => p.id === 'brave')).toMatchObject({ card: true, keySet: false });
  });

  test('a key goes in as a hub secret and never comes back out', async () => {
    expect((await hub.api('/api/websearch/key', { method: 'PUT', json: { provider: 'duckduckgo', key: 'abcdefghij' } })).status).toBe(400);
    expect((await hub.api('/api/websearch/key', { method: 'PUT', json: { provider: 'tavily', key: 'has space' } })).status).toBe(400);
    const put = await hub.api('/api/websearch/key', { method: 'PUT', json: { provider: 'tavily', key: KEY } });
    const text = await put.text();
    expect(put.status).toBe(200);
    expect(text).not.toContain(KEY);
    const s = JSON.parse(text) as WebSearchSettingsDto;
    expect(s.providers.find((p) => p.id === 'tavily')).toMatchObject({ keySet: true, keyFrom: 'hub' });
    expect(s.active).toBe('tavily');
    expect(hub.engine.config.secretValue('search.tavily')).toBe(KEY);
    expect(JSON.stringify(hub.engine.config.getUser())).not.toContain(KEY);
    const cfg = await (await hub.api('/api/config')).text();
    expect(cfg).not.toContain(KEY);
    expect(JSON.stringify(hub.engine.repos.audit.list({ limit: 20 }))).not.toContain(KEY);
    const gone = await json<WebSearchSettingsDto>(await hub.api('/api/websearch/key', { method: 'PUT', json: { provider: 'tavily', key: null } }));
    expect(gone.providers.find((p) => p.id === 'tavily')?.keySet).toBe(false);
    expect(hub.engine.config.secretValue('search.tavily')).toBeUndefined();
  });

  test('choose SearXNG with an address, and Test runs one real query', async () => {
    expect((await hub.api('/api/websearch', { method: 'PATCH', json: { provider: 'bing' } })).status).toBe(400);
    expect((await hub.api('/api/websearch', { method: 'PATCH', json: { url: 'ftp://x' } })).status).toBe(400);
    const s = await json<WebSearchSettingsDto>(await hub.api('/api/websearch', { method: 'PATCH', json: { provider: 'searxng', url: `http://127.0.0.1:${searx.port}/` } }));
    expect(s).toMatchObject({ chosen: 'searxng', active: 'searxng', url: `http://127.0.0.1:${searx.port}`, urlFrom: 'config' });
    const t = await json<WebSearchTestResult>(await hub.api('/api/websearch/test', { method: 'POST', json: {} }));
    expect(t).toEqual({ provider: 'searxng', ok: true, message: 'Works. SearXNG answered with 1 result.' });
    const noKey = await json<WebSearchTestResult>(await hub.api('/api/websearch/test', { method: 'POST', json: { provider: 'exa' } }));
    expect(noKey).toMatchObject({ provider: 'exa', ok: false });
    expect(noKey.message).toContain('no Exa API key');
  });

  test("a member sees and sets only their own keys; the engine choice stays the owner's", async () => {
    await hub.api('/api/people', { method: 'POST', json: { name: 'riley', password: 'a long enough password' } });
    const login = await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'riley', password: 'a long enough password', name: 'Riley laptop', platform: 'web' } }).then((r) => r.json());
    const mine = await json<WebSearchSettingsDto>(await hub.api('/api/websearch', { token: login.token }));
    // the owner's SearXNG address and choice never show on a member's page
    expect(mine).toMatchObject({ chosen: 'auto', active: 'duckduckgo', hubAllowed: false });
    expect(mine.url).toBeUndefined();
    expect((await hub.api('/api/websearch', { method: 'PATCH', token: login.token, json: { provider: 'auto' } })).status).toBe(403);
    const set = await json<WebSearchSettingsDto>(await hub.api('/api/websearch/key', { method: 'PUT', token: login.token, json: { provider: 'brave', key: 'abcdefghijk' } }));
    expect(set.providers.find((p) => p.id === 'brave')).toMatchObject({ keySet: true, keyFrom: 'own' });
    expect(hub.engine.config.secretValue('search.brave')).toBeUndefined();
    expect((await hub.api('/api/websearch/test', { method: 'POST', token: login.token, json: { provider: 'searxng' } })).status).toBe(400);
  });
});
