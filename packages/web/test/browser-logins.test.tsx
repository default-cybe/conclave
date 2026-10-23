/**
 * Settings > Browser, Sites and logins (features/settings/sitesLogins.tsx,
 * browserLoginWords.ts) and its mock (src/mock/browserLogins.ts): one row
 * per site with the account, signed in and login saved, last used, and
 * Edit login, Forget and Delete login; Delete profile on every profile but
 * the default; a password sent is never in an answer. No em or en dashes.
 *
 *   cd packages/web && bun test test/browser-logins.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowserProfileDto, BrowserStatusDto } from '@conclave/core/client';
import { registerBrowser } from '../src/mock/browser';
import { deleteProfileWords, forgetWords, LOGINS_HELP, profileLine, siteRows, siteRowWords } from '../src/features/settings/browserLoginWords';
import { SitesAndLogins } from '../src/features/settings/sitesLogins';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 20, 9);

type Handler = (p: { params: string[]; query: URLSearchParams; body: any }) => unknown;

function mock(fresh = false) {
  const routes: Array<[string, RegExp, Handler]> = [];
  const ctx = {
    on: (m: string, path: string, h: Handler) => routes.push([m, new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h]),
    fail: (status: number, msg: string): never => {
      throw Object.assign(new Error(msg), { status });
    },
    sleep: async () => undefined,
    FRESH: fresh,
  };
  registerBrowser(ctx as never);
  return async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const [path, q = ''] = url.split('?');
    for (const [m, re, h] of routes) {
      const hit = m === method && re.exec(path);
      if (hit) return (await h({ params: hit.slice(1).map(decodeURIComponent), query: new URLSearchParams(q), body })) as T;
    }
    throw new Error(`no route ${method} ${path}`);
  };
}

const profile = (s: BrowserStatusDto, name: string) => s.profiles.find((p) => p.name === name)!;

const fb = { id: 'lg_1', profile: 'marketplace', origin: 'https://www.facebook.com', host: 'facebook.com', username: 'kai@example.com', subdomains: true, password: true, totp: true, createdAt: T0 - 9 * DAY, updatedAt: T0 - 9 * DAY, lastUsed: T0 - 3 * HOUR };

describe('rows and words', () => {
  test('a site with a login and cookies is one row; a login alone and cookies alone are rows too, newest first', () => {
    const p: Pick<BrowserProfileDto, 'sites' | 'logins'> = {
      sites: [
        { host: 'facebook.com', at: T0 - 2 * DAY },
        { host: 'gumtree.com.au', at: T0 - 5 * DAY },
      ],
      logins: [fb, { ...fb, id: 'lg_2', origin: 'https://github.com', host: 'github.com', username: 'kai', totp: false, lastUsed: undefined, updatedAt: T0 - DAY }],
    };
    const rows = siteRows(p);
    expect(rows.map((r) => [r.host, !!r.login, r.signedIn !== undefined])).toEqual([
      ['facebook.com', true, true],
      ['gumtree.com.au', false, true],
      ['github.com', true, false],
    ]);
    expect(siteRowWords(rows[0], T0)).toEqual({ account: 'kai@example.com', state: 'Signed in, login saved with a 2FA key', used: 'last used 3h ago' });
    expect(siteRowWords(rows[1], T0)).toEqual({ account: 'Account not saved', state: 'Signed in', used: 'last used 5d ago' });
    expect(siteRowWords(rows[2], T0)).toEqual({ account: 'kai', state: 'Login saved', used: 'not used yet' });
    expect(siteRowWords({ key: 'x', host: 'x.test', login: { ...fb, password: false, problem: 'Save it again.' } }, T0).problem).toBe('Save it again.');
  });

  test('the confirms say what goes and who used the profile', () => {
    expect(deleteProfileWords({ name: 'marketplace', logins: [fb], usedBy: [{ id: 'r1', name: 'Cars under $8k', watch: true }], open: true })).toBe(
      'Its folder goes, with every cookie in it, so its sites are signed out. Its saved login goes too. Used by watch Cars under $8k. It runs in a new, empty profile of this name until you pick another one. Its browser is open now and closes first.',
    );
    expect(deleteProfileWords({ name: 'oops', logins: [], usedBy: [] })).toBe('Its folder goes, with every cookie in it, so its sites are signed out.');
    expect(forgetWords({ host: 'facebook.com', login: fb }, 'marketplace')).toContain('The saved login stays');
    expect(profileLine({ label: 'Chromium', open: false, isDefault: true })).toBe('Chromium profile, used when a chat picks none');
  });

  test('the page says plainly that saved logins are kept on the hub, encrypted', () => {
    expect(LOGINS_HELP).toContain('Saved logins are kept on the hub, encrypted');
    expect(LOGINS_HELP).toContain('the assistant never sees it');
  });

  test('no em or en dashes in the new screens and words', () => {
    const root = join(import.meta.dir, '../src');
    for (const f of ['features/settings/sitesLogins.tsx', 'features/settings/browserLoginWords.ts', 'mock/browserLogins.ts']) {
      expect({ f, dash: /[–—]/.test(readFileSync(join(root, f), 'utf8')) }).toEqual({ f, dash: false });
    }
  });
});

describe('the mock', () => {
  test('two profiles, three sites; saving a login answers that it is saved, never the password', async () => {
    const api = mock();
    const s = await api<BrowserStatusDto>('GET', '/api/browser');
    expect(s.profiles.map((p) => p.name)).toEqual(['default', 'marketplace']);
    expect(s.profiles.reduce((n, p) => n + siteRows(p).length, 0)).toBe(3);
    expect(profile(s, 'default').isDefault).toBe(true);
    expect(profile(s, 'marketplace').usedBy?.[0]).toMatchObject({ name: 'Cars under $8k', watch: true });

    const next = await api<BrowserStatusDto>('POST', '/api/browser/logins', { profile: 'marketplace', site: 'gumtree.com.au', username: 'kai', password: 'mock-secret-pw', totp: 'JBSWY3DPEHPK3PXP' });
    expect(JSON.stringify(next)).not.toContain('mock-secret-pw');
    expect(JSON.stringify(next)).not.toContain('JBSWY3DPEHPK3PXP');
    const l = profile(next, 'marketplace').logins!.find((x) => x.host === 'gumtree.com.au')!;
    expect(l).toMatchObject({ origin: 'https://gumtree.com.au', password: true, totp: true });
    await expect(api('POST', '/api/browser/logins', { profile: 'marketplace', site: 'gumtree.com.au', username: 'kai', password: 'x' })).rejects.toThrow('already has a login');
    await expect(api('POST', '/api/browser/logins', { site: 'ftp://x', username: 'kai', password: 'x' })).rejects.toThrow('not a web address');

    const edited = await api<BrowserStatusDto>('PUT', `/api/browser/logins/${l.id}`, { totp: null });
    expect(profile(edited, 'marketplace').logins!.find((x) => x.id === l.id)!.totp).toBe(false);
    const gone = await api<BrowserStatusDto>('DELETE', `/api/browser/logins/${l.id}`);
    expect(profile(gone, 'marketplace').logins!.some((x) => x.id === l.id)).toBe(false);
  });

  test('Forget takes the site off; Delete profile refuses the default and removes the rest', async () => {
    const api = mock();
    const f = await api<BrowserStatusDto>('POST', '/api/browser/profiles/default/forget', { host: 'gumtree.com.au' });
    expect(profile(f, 'default').sites.map((x) => x.host)).not.toContain('gumtree.com.au');
    await expect(api('DELETE', '/api/browser/profiles/default')).rejects.toThrow('cannot be deleted');
    const d = await api<BrowserStatusDto>('DELETE', '/api/browser/profiles/marketplace');
    expect(d.profiles.map((p) => p.name)).toEqual(['default']);
  });
});

describe('the section', () => {
  test('rows with their buttons, Delete profile on all but the default, and no password', async () => {
    const s = await mock()<BrowserStatusDto>('GET', '/api/browser');
    const html = renderToStaticMarkup(<SitesAndLogins s={s} onStatus={() => {}} />);
    expect(html).toContain('Sites and logins');
    expect(html).toContain('Add a login');
    for (const host of ['facebook.com', 'github.com', 'gumtree.com.au']) expect(html).toContain(host);
    expect(html).toContain('kai.ahir@example.com');
    expect(html).toContain('Signed in, login saved');
    expect(html.match(/Edit login/g)?.length).toBe(2);
    expect(html.match(/Delete login/g)?.length).toBe(2);
    expect(html.match(/>Forget</g)?.length).toBe(3);
    expect(html).toContain('Save login');
    expect(html.match(/Delete profile/g)?.length).toBe(1);
  });
});
