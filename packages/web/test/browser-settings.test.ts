/**
 * Settings > Browser: its words (features/settings/browserWords.ts) and the
 * mock (src/mock/browser.ts) the screenshots use: a bare hub, Install on the
 * hub with the exact steps core plans, the engine choice, and the proxy that
 * says only whether its login is saved.
 *
 *   cd packages/web && bun test test/browser-settings.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { BrowserProxySettingsDto, BrowserStatusDto } from '@conclave/core/client';
import { browserSetupOffer, CLOAK_VERSION } from '@conclave/core/browser/setup-plan';
import { registerBrowser, type MockBrowserOptions } from '../src/mock/browser';
import { engineStatus, libsWords, PROXY_HELP, providerWords, setupConfirmWords, setupResultWords, testWords } from '../src/features/settings/browserWords';

type Handler = (p: { params: string[]; query: URLSearchParams; body: any }) => unknown;

function mock(fresh = false, opts: MockBrowserOptions = {}) {
  const routes: Array<[string, RegExp, Handler]> = [];
  const ctx = {
    on: (m: string, path: string, h: Handler) => routes.push([m, new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h]),
    fail: (status: number, msg: string): never => {
      throw Object.assign(new Error(msg), { status });
    },
    sleep: async () => undefined,
    FRESH: fresh,
  };
  registerBrowser(ctx as never, opts);
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    for (const [m, re, h] of routes) {
      const hit = m === method && re.exec(path);
      if (hit) return (await h({ params: hit.slice(1), query: new URLSearchParams(), body })) as T;
    }
    throw new Error(`no route ${method} ${path}`);
  };
}

describe('words', () => {
  test('engines', () => {
    expect(engineStatus({ engine: 'cloak', label: 'CloakBrowser', installed: false, setup: browserSetupOffer('cloak', { platform: 'linux', arch: 'x64', user: 'conclave', dir: '/d', runtime: '/b' }) })).toEqual({ word: 'Not installed', tone: 'dim' });
    expect(engineStatus({ engine: 'cloak', label: 'CloakBrowser', installed: true, version: CLOAK_VERSION, where: 'hub', setup: {} as never }).detail).toBe(`${CLOAK_VERSION}, in the hub's browser folder`);
  });

  test('the install confirm says who, where, how much, and no root', () => {
    const o = browserSetupOffer('cloak', { platform: 'linux', arch: 'x64', user: 'conclave', dir: '/var/lib/conclave/browser', runtime: '/b' });
    expect(setupConfirmWords(o)).toBe('These run on the hub as conclave, in /var/lib/conclave/browser, without root. It needs about 990 MB free while it runs.');
    expect(setupResultWords({ ok: false, target: 'cloak', ran: [], tail: '', durationMs: 1, failed: 'tar -xzf x' }, 'CloakBrowser').text).toBe('The install stopped at: tar -xzf x. Nothing after that step ran. The output is below.');
  });

  test('libraries: the root command, or the Docker rebuild', () => {
    expect(libsWords({ missing: [], noFonts: false, packages: [] })).toBeUndefined();
    expect(libsWords({ missing: ['libnss3.so'], noFonts: false, packages: ['libnss3'], command: 'apt-get install -y libnss3' })).toBe('The browser needs a system library it cannot find (libnss3.so). Adding them takes root, once. Pick one:');
    expect(libsWords({ missing: ['libnss3.so'], noFonts: true, packages: [], docker: true })).toContain('--build-arg BROWSER=1');
  });

  test('the proxy rule and the provider line never name a login', () => {
    expect(PROXY_HELP).toContain('retries that request once through this proxy, in the hub\'s own country');
    expect(PROXY_HELP).toContain('You can also ask for it in a chat');
    expect(PROXY_HELP).toContain("never another person's");
    const di: BrowserProxySettingsDto = { provider: 'dataimpulse', dataimpulse: { host: 'gw.dataimpulse.com', port: 823, login: true, password: true, country: 'JP' }, custom: { password: false } };
    expect(providerWords(di)).toBe('DataImpulse at gw.dataimpulse.com:823, Japan (JP) by default. Login and password saved as secrets.');
    expect(providerWords({ ...di, provider: 'none' })).toContain('No proxy');
    expect(testWords({ ok: true, proxy: 'DataImpulse, Japan', ip: '126.209.14.83', country: 'JP', ms: 812 })).toBe('Sites see 126.209.14.83 in Japan (JP) through DataImpulse, Japan. It took 812 ms.');
    expect(testWords({ ok: false, proxy: 'DataImpulse', ms: 3, error: 'the proxy refused the user name or password' })).toBe('DataImpulse did not work: the proxy refused the user name or password.');
  });
});

describe('the mock', () => {
  test('a member sees only their browser, without owner logins, setup or proxy', async () => {
    const api = mock(false, { member: true, installed: true });
    const status = await api<BrowserStatusDto>('GET', '/api/browser');
    expect(status.available).toBe(true);
    expect(status.profiles).toHaveLength(1);
    expect(status.profiles[0]).toMatchObject({ name: 'default', sites: [], logins: [] });
    for (const key of ['engines', 'proxy', 'dir', 'libs']) expect(status).not.toHaveProperty(key);
  });

  test('a bare hub installs CloakBrowser with the exact steps, and new profiles then get it', async () => {
    const api = mock();
    const before = await api<BrowserStatusDto>('GET', '/api/browser');
    expect(before.available).toBe(false);
    const cloak = before.engines!.find((e) => e.engine === 'cloak')!;
    await expect(api('POST', '/api/browser/setup', { target: 'cloak', steps: ['rm -rf /'] })).rejects.toThrow('changed since you looked');
    const r = await api<{ ok: boolean }>('POST', '/api/browser/setup', { target: 'cloak', steps: cloak.setup.lines });
    expect(r.ok).toBe(true);
    const after = await api<BrowserStatusDto>('GET', '/api/browser');
    expect(after.engines!.find((e) => e.engine === 'cloak')!.installed).toBe(true);
    expect(after.newProfileEngine).toBe('cloak');
    // what a fresh Debian CT missed: libraries and fonts, the Debian 12 names
    expect(after.libs?.command).toMatch(/^apt-get install -y --no-install-recommends .*libgbm1 .*libnss3 .*libx11-6/);
    expect(after.libs?.command).toContain('fonts-liberation');
    // Chromium then needs no playwright-core step
    expect(after.engines!.find((e) => e.engine === 'chromium')!.setup.steps).toHaveLength(1);
  });

  test('the proxy saves DataImpulse and tests a country; a fresh hub has none', async () => {
    const api = mock(true);
    expect((await api<BrowserStatusDto>('GET', '/api/browser')).proxy?.provider).toBe('none');
    await expect(api('POST', '/api/browser/proxy/test', {})).rejects.toThrow('No proxy is set up');
    const s = await api<BrowserStatusDto>('PUT', '/api/browser/proxy', { provider: 'dataimpulse', dataimpulse: { login: 'x', password: 'y', country: 'Japan' } });
    expect(s.proxy).toMatchObject({ provider: 'dataimpulse', dataimpulse: { login: true, password: true, country: 'JP' } });
    expect(JSON.stringify(s)).not.toMatch(/"x"|"y"/);
    const t = await api<{ ok: boolean; country: string; proxy: string }>('POST', '/api/browser/proxy/test', { country: 'Germany' });
    expect(t).toMatchObject({ ok: true, country: 'DE', proxy: 'DataImpulse, Germany' });
  });
});
