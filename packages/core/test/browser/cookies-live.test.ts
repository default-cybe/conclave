/**
 * Import cookies against a real Chromium (BrowserManager.importCookies):
 * a Cookie-Editor export with two hosts, a __Host- cookie and a
 * SameSite=None; Secure one lands in the profile's context and survives the
 * browser closing; two imports at once both land; Forget (the same
 * withProfile helper) takes one site out. Also pins what Chromium does with
 * a cookie on a public suffix, which cookies.ts refuses before it gets there.
 * Skipped when there is no Chromium, like the other live browser tests.
 *
 *   bun test packages/core/test/browser/cookies-live.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { BrowserManager, findBrowserExecutable } from '../../src/browser';

const exe = findBrowserExecutable({ headless: true });
let hasPlaywright = true;
try {
  await import('playwright-core');
} catch {
  hasPlaywright = false;
}
const live = exe && hasPlaywright ? describe : describe.skip;

const LATER = Math.floor(Date.now() / 1000) + 30 * 86_400;
const home = mkdtempSync(join(tmpdir(), 'conclave-cookies-live-'));
let manager: BrowserManager | undefined;

afterAll(async () => {
  await manager?.close();
  rmSync(home, { recursive: true, force: true });
});

live('Import cookies (live Chromium)', () => {
  const config = new ConfigStore(home, { browser: { headless: true, executablePath: exe } } as never);
  manager = new BrowserManager({ config });
  const m = manager;

  /** The profile's cookies, read in a session that is closed again after. */
  async function jar(profile: string) {
    const page = await m.page('reader', profile);
    const all = await page.context().cookies();
    await m.closeSession('reader');
    await m.closeProfileBrowser(profile);
    return all;
  }

  test('a Cookie-Editor export lands in the profile and stays after the browser closes', async () => {
    const file = JSON.stringify([
      { name: '__Host-sid', value: 'host-secret', domain: 'shop.example.com', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: LATER },
      { name: 'xsite', value: 'none-secret', domain: '.shop.example.com', hostOnly: false, path: '/', secure: true, sameSite: 'no_restriction', expirationDate: LATER },
      { name: 'lang', value: 'en', domain: 'news.example.org', hostOnly: true, path: '/', secure: false, sameSite: 'unspecified', session: true },
    ]);
    const r = await m.importCookies('imp', file);
    expect(r).toMatchObject({ format: 'json', added: 3, expired: 0, invalid: 0 });
    expect(r.sites.map((s) => s.domain).sort()).toEqual(['news.example.org', 'shop.example.com']);
    expect(m.isOpen('imp')).toBe(false);
    const got = await jar('imp');
    const by = (n: string) => got.find((c) => c.name === n);
    expect(by('__Host-sid')).toMatchObject({ domain: 'shop.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    expect(by('xsite')).toMatchObject({ domain: '.shop.example.com', secure: true, sameSite: 'None' });
    // a session cookie does not outlive the browser that got it
    expect(by('lang')).toBeUndefined();
  }, 60_000);

  let two = 0;
  test('two imports at once both land, and the browser closes after; cookies Chromium evicts are not counted as added', async () => {
    const a = JSON.stringify([{ name: 'a', value: '1', domain: '.one.example', expirationDate: LATER }]);
    const b = JSON.stringify(Array.from({ length: 600 }, (_, i) => ({ name: `b${i}`, value: '1', domain: '.two.example', expirationDate: LATER })));
    const [ra, rb] = await Promise.all([m.importCookies('imp', a), m.importCookies('imp', b)]);
    expect(ra.added).toBe(1);
    // Chromium keeps at most about 180 cookies a domain and evicts the rest with no error
    expect(rb.added).toBeGreaterThan(100);
    expect(rb.added).toBeLessThan(600);
    expect(rb.added + rb.invalid).toBe(600);
    expect(rb.sites).toEqual([{ domain: 'two.example', cookies: rb.added }]);
    two = rb.added;
    expect(m.isOpen('imp')).toBe(false);
    const got = await jar('imp');
    expect(got.filter((c) => c.domain === '.one.example')).toHaveLength(1);
    expect(got.filter((c) => c.domain === '.two.example')).toHaveLength(two);
  }, 60_000);

  test('Forget takes one site out and leaves the rest', async () => {
    const r = await m.forgetSite('imp', 'two.example');
    expect(r.cookies).toBe(two);
    expect(m.isOpen('imp')).toBe(false);
    const got = await jar('imp');
    expect(got.some((c) => c.domain === '.two.example')).toBe(false);
    expect(got.some((c) => c.domain === '.one.example')).toBe(true);
    expect(got.some((c) => c.name === '__Host-sid')).toBe(true);
  }, 60_000);

  test('Chromium and a cookie on a public suffix', async () => {
    const page = await m.page('probe', 'probe');
    const ctx = page.context();
    const out: Record<string, string> = {};
    for (const domain of ['.com', 'com', '.co.uk', '.github.io']) {
      try {
        await ctx.addCookies([{ name: 'psl', value: '1', domain, path: '/', expires: LATER, secure: true, sameSite: 'Lax' }]);
        out[domain] = (await ctx.cookies()).some((c) => c.domain.replace(/^\./, '') === domain.replace(/^\./, '')) ? 'stored' : 'dropped';
      } catch (err) {
        out[domain] = `error: ${(err as Error).message.split('\n')[0]}`;
      }
    }
    await m.closeSession('probe');
    // stored with no error: that is why cookies.ts refuses these before addCookies
    expect(out).toEqual({ '.com': 'stored', com: 'stored', '.co.uk': 'stored', '.github.io': 'stored' });
    await expect(m.importCookies('probe', JSON.stringify([{ name: 'psl', value: '1', domain: '.com' }]))).rejects.toThrow('no cookies the hub can use');
  }, 60_000);
});
