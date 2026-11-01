/**
 * The proxy when the owner asks or a site blocks (browser/manager.ts useProxy,
 * the proxy input of browser_navigate and browser_tabs), with a fake launcher
 * and fake pages, so no browser runs:
 *
 * - a call without the proxy input never touches the proxy settings, its
 *   secrets or the network check, and goes out from the profile's browser;
 * - a block page is loaded again once through the proxy, in the hub's country;
 * - with it, the session gets a throwaway browser through the proxy, in a
 *   fresh folder, with the country in the DataImpulse user name; later calls
 *   stay on it; another country is another browser; false goes back;
 * - nothing the agent or the log sees has the login or password.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright-core';
import { ConfigStore } from '../../src/config';
import type { ConclaveConfig } from '../../src/config/schema';
import { setLogTap } from '../../src/util/log';
import { BrowserManager, WEBRTC_PROXY_FLAG } from '../../src/browser/manager';
import { browserTools, PROXY_INPUT_RULE, proxyWant } from '../../src/browser/tools';
import type { ProxyEntry } from '../../src/browser/proxy-list';
import type { ToolContext, ToolOutput } from '../../src/tools/types';
import { setHubCountryLookup, setProxySource } from '../../src/tools/blocked';

const CLOUDFLARE_BLOCK = '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';

const LOGIN = 'kai8f2login';
const PASSWORD = 'Pw-di-0042-secret';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const logs: string[] = [];
let prevTap: ReturnType<typeof setLogTap>;
beforeAll(() => {
  prevTap = setLogTap((level, scope, msg, extra) => logs.push(`${level} ${scope} ${msg} ${extra === undefined ? '' : JSON.stringify(extra)}`));
});
afterAll(() => setLogTap(prevTap));

type LaunchOpts = NonNullable<Parameters<BrowserType['launchPersistentContext']>[1]>;

/** Contexts whose pages answer goto and url, enough for browser_navigate. */
function fakeLauncher() {
  const calls: Array<{ dir: string; opts: LaunchOpts; closed: boolean }> = [];
  const launcher = {
    async launchPersistentContext(dir: string, opts: LaunchOpts = {}) {
      const call = { dir, opts, closed: false };
      calls.push(call);
      const listeners: Array<() => void> = [];
      const page = () => {
        let url = 'about:blank';
        // blocked.example blocks every address but the proxy's; wall.example blocks the proxy too
        const blocks = () => url.includes('wall.example') || (url.includes('blocked.example') && !opts.proxy);
        return {
          on: () => {},
          isClosed: () => call.closed,
          goto: async (u: string) => {
            url = u;
            return { status: () => (blocks() ? 403 : 200) };
          },
          url: () => url,
          content: async () => (blocks() ? CLOUDFLARE_BLOCK : '<html><body>ok</body></html>'),
          waitForLoadState: async () => {},
          close: async () => {},
        };
      };
      return {
        pages: () => [],
        newPage: async () => page(),
        on: (ev: string, fn: () => void) => void (ev === 'close' && listeners.push(fn)),
        setDefaultTimeout: () => {},
        setDefaultNavigationTimeout: () => {},
        close: async () => {
          call.closed = true;
          listeners.forEach((fn) => fn());
        },
      } as unknown as BrowserContext;
    },
  };
  return { launcher, calls };
}

function hubWith(proxy: ConclaveConfig['browser']['proxy'] | undefined, secrets: Record<string, string> = { 'browser.dataimpulse.login': LOGIN, 'browser.dataimpulse.password': PASSWORD }) {
  const home = mkdtempSync(join(tmpdir(), 'conclave-proxy-session-'));
  dirs.push(home);
  const config = new ConfigStore(home, { browser: { headless: true, ...(proxy ? { proxy } : {}) } as ConclaveConfig['browser'] });
  for (const [k, v] of Object.entries(secrets)) config.setSecret('values', k, v);
  const { launcher, calls } = fakeLauncher();
  const probed: ProxyEntry[] = [];
  const manager = new BrowserManager({
    config,
    launcher,
    proxyProbe: async (p) => {
      probed.push(p);
      return { ok: true, proxy: 'x', ip: '203.0.113.77', country: p.username?.match(/cr\.(\w\w)/)?.[1]?.toUpperCase(), ms: 5 };
    },
  });
  // a snapshot needs a real page: the tools here only need its text
  (manager as unknown as { snapshot: BrowserManager['snapshot'] }).snapshot = async (sid: string) => {
    const page = await manager.page(sid);
    return { url: page.url(), title: 'T', tree: '', text: `Title: T\nURL: ${page.url()}`, truncated: false, refCount: 0, tabCount: 1, activeTab: 0 };
  };
  const tools = new Map(browserTools(manager).map((t) => [t.name, t]));
  const run = (name: string, input: Record<string, unknown>, sid = 'chat-1') => tools.get(name)!.run(input, { sessionId: sid, signal: new AbortController().signal } as unknown as ToolContext);
  return { home, config, manager, calls, probed, run };
}

const text = (o: ToolOutput) => (typeof o.content === 'string' ? o.content : o.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
const DI = { provider: 'dataimpulse' as const, dataimpulse: { login: '${secret:browser.dataimpulse.login}', password: '${secret:browser.dataimpulse.password}' } };

describe('without the proxy input', () => {
  test('a call never touches the proxy settings, their secrets or the check, and goes out from the profile', async () => {
    const h = hubWith(DI);
    // count every read of browser.proxy and of a secret
    let proxyReads = 0;
    const browser = h.config.get().browser as Record<string, unknown>;
    const proxyValue = browser.proxy;
    Object.defineProperty(browser, 'proxy', {
      get: () => {
        proxyReads++;
        return proxyValue;
      },
      configurable: true,
    });
    const secretReads: string[] = [];
    const realSecret = h.config.secretValue.bind(h.config);
    h.config.secretValue = (n: string) => {
      secretReads.push(n);
      return realSecret(n);
    };
    const out = await h.run('browser_navigate', { url: 'https://example.com/' });
    expect(out.isError).toBeUndefined();
    await h.run('browser_tabs', { action: 'new', url: 'https://example.org/' });
    await h.run('browser_navigate', { url: 'https://example.net/', proxy: undefined });
    expect(proxyReads).toBe(0);
    expect(secretReads).toEqual([]);
    expect(h.probed).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].dir).toBe(join(h.home, 'browser-profile', 'default'));
    expect(h.calls[0].opts.proxy).toBeUndefined();
    expect(h.calls[0].opts.args ?? []).not.toContain(WEBRTC_PROXY_FLAG);
    expect(text(out)).not.toContain('proxy');
    expect(h.manager.proxied('chat-1')).toBe(false);
    await h.manager.close();
  });

  test('a normal page reads no proxy settings', async () => {
    const h = hubWith(DI);
    const out = await h.run('browser_navigate', { url: 'https://example.com/' });
    expect(text(out)).not.toContain('proxy');
    expect(h.probed).toEqual([]);
    await h.manager.close();
  });
});

describe('a page that blocks the hub', () => {
  afterEach(() => {
    setProxySource();
    setHubCountryLookup();
  });
  const source = (h: ReturnType<typeof hubWith>) => setProxySource({ cfg: () => h.config.get().browser?.proxy, read: (n) => h.config.secretValue(n) });

  test("is loaded once more through the proxy, in the hub's country", async () => {
    const h = hubWith(DI);
    source(h);
    setHubCountryLookup(async () => 'US');
    const out = await h.run('browser_navigate', { url: 'https://blocked.example/' });
    const t = text(out);
    expect(t).toContain("blocked.example blocked the hub's address; loaded through the proxy (US).");
    expect(t).not.toContain('HTTP 403');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].opts.proxy).toBeUndefined();
    expect(h.calls[1].opts.proxy).toMatchObject({ username: `${LOGIN}__cr.us` });
    expect(t).not.toContain(LOGIN);
    expect(t).not.toContain(PASSWORD);
    await h.manager.close();
  });

  test('blocked through the proxy too: said, and only one retry', async () => {
    const h = hubWith(DI);
    source(h);
    setHubCountryLookup(async () => 'US');
    const out = await h.run('browser_navigate', { url: 'https://wall.example/' });
    expect(text(out)).toContain('blocked through the proxy (US) too');
    expect(h.calls).toHaveLength(2);
    await h.manager.close();
  });

  test('no proxy set: the block is said with where to set one', async () => {
    const h = hubWith(undefined);
    source(h);
    const out = await h.run('browser_navigate', { url: 'https://blocked.example/' });
    expect(text(out)).toContain("blocked.example blocked the hub's address (a Cloudflare challenge). Set a proxy in Settings > Browser to retry these through it.");
    expect(h.calls).toHaveLength(1);
    await h.manager.close();
  });

  test("a member's session never uses the owner's proxy", async () => {
    const h = hubWith(DI);
    source(h);
    const nav = browserTools(h.manager).find((t) => t.name === 'browser_navigate')!;
    const out = await nav.run({ url: 'https://blocked.example/' }, { sessionId: 'm-1', session: { accountId: 'alice' }, signal: new AbortController().signal } as unknown as ToolContext);
    expect(text(out)).toContain("belongs to the owner, so a member's request does not retry through it");
    expect(h.calls.every((c) => !c.opts.proxy)).toBe(true);
    await h.manager.close();
  });
});

describe('with the proxy input', () => {
  test('a country: a throwaway browser through DataImpulse with cr.<country>; the result says where it went out', async () => {
    const h = hubWith(DI);
    logs.length = 0;
    const out = await h.run('browser_navigate', { url: 'https://example.com/', proxy: 'Japan' });
    const t = text(out);
    expect(t).toContain('Through the proxy (DataImpulse, Japan), exit IP 203.0.113.77 in Japan (JP) at the check.');
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call.opts.proxy).toEqual({ server: 'http://gw.dataimpulse.com:823', username: `${LOGIN}__cr.jp`, password: PASSWORD });
    expect(call.opts.args).toContain(WEBRTC_PROXY_FLAG);
    // full Chromium ignores the flag and reads the pref instead
    expect(JSON.parse(readFileSync(join(call.dir, 'Default', 'Preferences'), 'utf8'))).toEqual({ webrtc: { ip_handling_policy: 'disable_non_proxied_udp' } });
    // not the profile's folder: a fresh one under the cache
    expect(call.dir.startsWith(join(h.home, 'cache', 'browser-proxy'))).toBe(true);
    expect(existsSync(join(h.home, 'browser-profile', 'default'))).toBe(false);
    for (const s of [t, logs.join('\n')]) {
      expect(s).not.toContain(LOGIN);
      expect(s).not.toContain(PASSWORD);
    }

    // the next calls stay on it, with no input
    await h.run('browser_navigate', { url: 'https://example.com/two' });
    await h.run('browser_tabs', { action: 'new', url: 'https://example.com/three' });
    expect(h.calls).toHaveLength(1);
    expect(h.probed).toHaveLength(1);

    // another country is another browser; the old one closes and its folder goes
    await h.run('browser_navigate', { url: 'https://example.com/', proxy: 'de' });
    expect(h.calls).toHaveLength(2);
    expect(call.closed).toBe(true);
    expect(existsSync(call.dir)).toBe(false);
    expect(h.calls[1].opts.proxy).toMatchObject({ username: `${LOGIN}__cr.de` });

    // false goes back to the hub's own address, in the profile
    const back = await h.run('browser_navigate', { url: 'https://example.com/', proxy: false });
    expect(text(back)).toContain("The proxy is off: pages load from the hub's own address again.");
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].opts.proxy).toBeUndefined();
    expect(h.calls[2].dir).toBe(join(h.home, 'browser-profile', 'default'));
    expect(h.calls[1].closed).toBe(true);
    await h.manager.close();
  });

  test('true takes the default country; other sessions stay direct', async () => {
    const h = hubWith({ ...DI, dataimpulse: { ...DI.dataimpulse, country: 'VN' } });
    await h.run('browser_navigate', { url: 'https://example.com/', proxy: true }, 'chat-a');
    await h.run('browser_navigate', { url: 'https://example.com/' }, 'chat-b');
    expect(h.calls[0].opts.proxy).toMatchObject({ username: `${LOGIN}__cr.vn` });
    expect(h.calls[1].opts.proxy).toBeUndefined();
    await h.manager.close();
  });

  test('no proxy set up, an unknown country, a missing password: an error and no browser', async () => {
    const none = hubWith(undefined);
    const a = await none.run('browser_navigate', { url: 'https://example.com/', proxy: 'JP' });
    expect(a.isError).toBe(true);
    expect(text(a)).toContain('No proxy is set up on this hub');
    expect(none.calls).toHaveLength(0);
    const h = hubWith(DI);
    expect(text(await h.run('browser_navigate', { url: 'https://example.com/', proxy: 'Atlantis' }))).toContain('is not a country');
    const nopw = hubWith(DI, { 'browser.dataimpulse.login': LOGIN });
    expect(text(await nopw.run('browser_navigate', { url: 'https://example.com/', proxy: true }))).toContain('login or password is not saved');
    expect(h.calls.length + nopw.calls.length).toBe(0);
  });

  test('a custom SOCKS5 proxy with a login goes through the loopback relay', async () => {
    const h = hubWith({ provider: 'custom', custom: { url: 'socks5://alice@127.0.0.1:9', password: '${secret:browser.proxy.password}' } }, { 'browser.proxy.password': 'relay-pw-1' });
    const out = await h.run('browser_navigate', { url: 'https://example.com/', proxy: true });
    expect(text(out)).toContain('Through the proxy (socks5://alice@127.0.0.1:9)');
    expect(h.calls[0].opts.proxy?.server).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(h.calls[0].opts)).not.toContain('relay-pw-1');
    // a custom proxy has no country choice
    expect(text(await h.run('browser_navigate', { url: 'https://example.com/', proxy: 'JP' }))).toContain('no country choice');
    await h.manager.close();
  });

  test("the sign-in view's own session and an explicit other profile never go through it", async () => {
    const h = hubWith(DI);
    await h.manager.useProxy('chat-1', 'JP');
    await h.manager.page('chat-1', 'shop');
    expect(h.calls[0].opts.proxy).toBeUndefined();
    expect(h.calls[0].dir).toBe(join(h.home, 'browser-profile', 'shop'));
    h.manager.setProfile('signin-1', 'shop');
    await h.manager.page('signin-1');
    expect(h.calls.every((c) => !c.opts.proxy)).toBe(true);
    await h.manager.close();
  });

  test('closing the session closes its proxied browser and forgets the choice', async () => {
    const h = hubWith(DI);
    await h.run('browser_navigate', { url: 'https://example.com/', proxy: 'JP' });
    await h.manager.closeSession('chat-1');
    expect(h.calls[0].closed).toBe(true);
    expect(h.manager.proxied('chat-1')).toBe(false);
  });
});

describe('the rule in the tool description', () => {
  test('says when to use it, plainly', () => {
    expect(PROXY_INPUT_RULE).toContain('Leave this out unless the owner asked for a proxy');
    expect(PROXY_INPUT_RULE).toContain("Without it pages load from the hub's own IP address");
    expect(PROXY_INPUT_RULE).toContain('retries the page once through the hub\'s proxy in the hub\'s own country by itself');
    expect(PROXY_INPUT_RULE).toContain("watch's or routine's own instructions");
    const nav = browserTools({} as BrowserManager).find((t) => t.name === 'browser_navigate')!;
    expect(JSON.stringify(nav.inputSchema)).toContain('Leave this out unless');
  });

  test('proxyWant reads true, false and countries', () => {
    expect(proxyWant(undefined)).toBeUndefined();
    expect(proxyWant('')).toBeUndefined();
    expect(proxyWant(true)).toBe(true);
    expect(proxyWant('off')).toBe(false);
    expect(proxyWant('yes')).toBe(true);
    expect(proxyWant('Japan')).toBe('Japan');
  });
});
