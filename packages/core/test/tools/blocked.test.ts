/**
 * A site that blocks the hub (tools/blocked.ts): looksBlocked, and the one
 * retry through the owner's proxy in the hub's country for WebFetch and
 * WebSearch. fetch is faked: no proxy and no network is ever reached.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { hubCountry, looksBlocked, setHubCountryLookup, setProxySource } from '../../src/tools/blocked';
import { WebFetchTool, clearWebFetchCache, setWebFetchBrowser, setWebFetchLookup } from '../../src/tools/webfetch';
import { webSearch } from '../../src/tools/websearch';
import { runAs } from '../../src/people/context';
import type { BrowserProxyConfig } from '../../src/browser/proxy-provider';
import { makeCtx, text } from './helpers';

const html = (body: string, status = 200, headers: Record<string, string> = {}) => ({ status, body, headers: new Headers({ 'content-type': 'text/html', ...headers }) });

describe('looksBlocked', () => {
  test('block pages', () => {
    expect(looksBlocked({ url: 'https://www.reddit.com/r/x.json', ...html('<html>You have been blocked by network security.</html>', 403) })).toBe('blocked by network security');
    expect(looksBlocked({ url: 'https://www.reddit.com/r/x.json', ...html('', 403) })).toBe('HTTP 403 with a block page');
    expect(looksBlocked({ status: 302, url: 'https://old.reddit.com/r/x/', location: 'https://old.reddit.com/login/?dest=x&reason=lor2' })).toBe('sent to the login page');
    expect(looksBlocked({ url: 'https://html.duckduckgo.com/html/?q=a', ...html('<div class="anomaly-modal__modal"></div>', 202) })).toBe('a bot check');
    expect(looksBlocked({ url: 'https://shop.example/', ...html('<title>Attention Required! | Cloudflare</title> Error 1020', 403) })).toBe('a Cloudflare challenge');
    expect(looksBlocked({ url: 'https://shop.example/', ...html('<title>Just a moment...</title>', 503) })).toBe('a Cloudflare challenge');
    expect(looksBlocked({ url: 'https://shop.example/', ...html('', 403, { 'cf-mitigated': 'challenge' }) })).toBe('a Cloudflare challenge');
    expect(looksBlocked({ url: 'https://shop.example/', ...html('Please solve the captcha to continue', 429) })).toBe('HTTP 429 with a block page');
  });

  test('not blocks: a 404, a normal page, an API 401, a plain 403, a login redirect elsewhere', () => {
    expect(looksBlocked({ url: 'https://shop.example/x', ...html('<p>Not found</p>', 404) })).toBeUndefined();
    expect(looksBlocked({ url: 'https://shop.example/', ...html('<h1>Welcome</h1><p>access denied is a band name</p>') })).toBeUndefined();
    expect(looksBlocked({ url: 'https://api.github.com/user', status: 401, body: '{"message":"Requires authentication"}' })).toBeUndefined();
    expect(looksBlocked({ url: 'https://files.example/private', ...html('<h1>403 Forbidden</h1>', 403) })).toBeUndefined();
    expect(looksBlocked({ status: 302, url: 'https://app.example/', location: 'https://app.example/login' })).toBeUndefined();
  });
});

const DI: BrowserProxyConfig = { provider: 'dataimpulse', dataimpulse: { login: '${secret:di.login}', password: '${secret:di.password}', country: 'JP' } };
const SECRETS: Record<string, string> = { 'di.login': 'kai8f2', 'di.password': 'pw/42@x' };
const THREAD = [{ kind: 'Listing', data: { children: [{ kind: 't3', data: { title: 'macOS VM on Proxmox', permalink: '/r/Proxmox/comments/abc/x/', is_self: true, selftext: 'hi' } }] } }, { kind: 'Listing', data: { children: [] } }];

type Call = { url: string; proxy?: string };
/** fetch replaced: the handler sees whether the call went through a proxy. */
function fakeFetch(handler: (url: string, proxy?: string) => Response): { calls: Call[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit & { proxy?: string } = {}) => {
    calls.push({ url: String(input), proxy: init.proxy });
    return handler(String(input), init.proxy);
  }) as typeof fetch;
  setWebFetchLookup(async () => ['151.101.1.140']);
  return { calls, restore: () => ((globalThis.fetch = real), setWebFetchLookup()) };
}

const redditBlock = (_u: string, proxy?: string) => (proxy ? Response.json(THREAD) : new Response('<html>blocked by network security</html>', { status: 403, headers: { 'content-type': 'text/html' } }));

let f: ReturnType<typeof fakeFetch> | undefined;
beforeEach(() => {
  clearWebFetchCache();
  setHubCountryLookup(async () => 'US');
  // an engine made by an earlier file in the same process leaves its real browser here (engine/create.ts);
  // a Reddit page still blocked after the proxy would then launch Chrome and outlast the test's 5 s
  setWebFetchBrowser();
});
afterEach(() => {
  f?.restore();
  f = undefined;
  setProxySource();
  setHubCountryLookup();
});
const withProxy = (cfg: BrowserProxyConfig | undefined) => setProxySource({ cfg: () => cfg, read: (n) => SECRETS[n] });
const reddit = 'https://www.reddit.com/r/Proxmox/comments/abc/x/';

describe('WebFetch retries a blocked page through the proxy', () => {
  test("once, with the hub's country in the DataImpulse user name, and says so", async () => {
    withProxy(DI);
    f = fakeFetch(redditBlock);
    const out = await WebFetchTool.run({ url: reddit }, makeCtx({ cwd: '/' }));
    expect(out.isError).toBeFalsy();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].proxy).toBeUndefined();
    expect(f.calls[1].proxy).toBe('http://kai8f2__cr.us:pw%2F42%40x@gw.dataimpulse.com:823');
    expect(text(out)).toContain("Reddit blocked the hub's address; fetched through the proxy (US).");
    expect(text(out)).toContain('macOS VM on Proxmox');
    expect(text(out)).not.toContain('kai8f2');
    expect(text(out)).not.toContain('pw/42');
  });

  test("the proxy's own country when the hub's is unknown; blocked again is said, no third try", async () => {
    withProxy(DI);
    setHubCountryLookup(async () => undefined);
    f = fakeFetch(() => new Response('<html>blocked by network security</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    const out = await WebFetchTool.run({ url: reddit }, makeCtx({ cwd: '/' }));
    expect(out.isError).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].proxy).toContain('kai8f2__cr.jp:');
    expect(text(out)).toContain('It was blocked through the proxy (JP) too.');
  });

  test('a custom HTTP proxy is used as configured, with no country', async () => {
    withProxy({ provider: 'custom', custom: { url: 'http://bob@10.0.0.5:3128', password: '${secret:di.password}' } });
    f = fakeFetch(redditBlock);
    const out = await WebFetchTool.run({ url: reddit }, makeCtx({ cwd: '/' }));
    expect(f.calls[1].proxy).toBe('http://bob:pw%2F42%40x@10.0.0.5:3128');
    expect(text(out)).toContain("Reddit blocked the hub's address; fetched through the proxy.");
  });

  test('no proxy set: the clear blocked message, plus where to set one', async () => {
    withProxy(undefined);
    f = fakeFetch(redditBlock);
    const out = await WebFetchTool.run({ url: reddit }, makeCtx({ cwd: '/' }));
    expect(out.isError).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(text(out)).toContain("Reddit blocked this hub's address");
    expect(text(out)).toContain('Set a proxy in Settings > Browser to retry these through it.');
  });

  test("a member's call never goes through the owner's proxy", async () => {
    withProxy(DI);
    f = fakeFetch(redditBlock);
    const out = await runAs('alice', () => WebFetchTool.run({ url: reddit }, makeCtx({ cwd: '/' })));
    expect(f.calls).toHaveLength(1);
    expect(f.calls.every((c) => !c.proxy)).toBe(true);
    expect(text(out)).toContain("a member's request does not retry through it");
  });

  test('a page that is not blocked never reads the proxy settings', async () => {
    let reads = 0;
    setProxySource({ cfg: () => (reads++, DI), read: (n) => SECRETS[n] });
    f = fakeFetch(() => new Response('<p>missing</p>', { status: 404, headers: { 'content-type': 'text/html' } }));
    await WebFetchTool.run({ url: 'https://shop.example/x' }, makeCtx({ cwd: '/' }));
    expect(reads).toBe(0);
    expect(f.calls).toHaveLength(1);
  });
});

describe('WebSearch retries a DuckDuckGo bot check through the proxy', () => {
  const signal = () => new AbortController().signal;
  const ddg = (_u: string, proxy?: string) =>
    proxy
      ? new Response('<div class="result"><a class="result__a" href="https://pve.example/macos">macOS on Proxmox</a></div>', { headers: { 'content-type': 'text/html' } })
      : new Response('<div class="anomaly-modal__modal"></div>', { status: 202, headers: { 'content-type': 'text/html' } });

  test('results through the proxy, with the line', async () => {
    withProxy(DI);
    f = fakeFetch(ddg);
    const out = await webSearch({ provider: 'duckduckgo' }, 'proxmox macos', { signal: signal() });
    expect(out.results.map((r) => r.url)).toEqual(['https://pve.example/macos']);
    expect(out.note).toBe("DuckDuckGo blocked the hub's address; fetched through the proxy (US).");
    expect(f.calls[1].proxy).toContain('__cr.us:');
  });

  test('no proxy: the bot check error says where to set one', async () => {
    withProxy(undefined);
    f = fakeFetch(ddg);
    await expect(webSearch({ provider: 'duckduckgo' }, 'proxmox macos', { signal: signal() })).rejects.toThrow('Set a proxy in Settings > Browser to retry these through it.');
    expect(f.calls).toHaveLength(1);
  });
});

test("the hub's country is asked once per process", async () => {
  let asks = 0;
  setHubCountryLookup(async () => (asks++, 'us'));
  expect(await hubCountry()).toBe('US');
  expect(await hubCountry()).toBe('US');
  expect(asks).toBe(1);
});
