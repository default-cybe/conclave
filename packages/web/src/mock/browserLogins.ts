/**
 * Mock routes for Settings > Browser, Sites and logins (routes-browser.ts):
 * saved logins, Forget a site and Delete profile, on top of the profiles of
 * mock/browser.ts. The hub as the owner has it: default with a GitHub login
 * (with a 2FA key) and gumtree.com.au signed in, marketplace signed in to
 * Facebook with a saved login and a watch on it. A password or 2FA key sent
 * here is dropped at once: the answer only says that one is saved. Import
 * cookies parses the file with the hub's own parser and answers counts per
 * site; the cookies themselves are dropped.
 */
import type { BrowserCookieImportResult, BrowserLoginDto, BrowserLoginInput, BrowserStatusDto } from '@conclave/core/client';
import { cookiesPerSite, CookieFileError, parseCookieFile } from '@conclave/core/browser/cookies';
import type { MockCtx } from './index';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function origin(site: string): string | undefined {
  const s = site.trim();
  if (!s) return undefined;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

const hostOf = (o: string) => new URL(o).hostname.replace(/^www\./, '');

/** The logins, extra sites and deletions, kept for the life of the page. */
export function browserLoginsState(fresh: boolean) {
  const now = Date.now();
  const logins = new Map<string, BrowserLoginDto>();
  const add = (l: Omit<BrowserLoginDto, 'host' | 'password' | 'createdAt' | 'updatedAt'> & { createdAt?: number }) =>
    logins.set(l.id, { ...l, host: hostOf(l.origin), password: true, createdAt: l.createdAt ?? now - 30 * DAY, updatedAt: l.createdAt ?? now - 30 * DAY });
  if (!fresh) {
    add({ id: 'lg_6f1c2a9e0b3d', profile: 'marketplace', origin: 'https://www.facebook.com', username: 'kai.ahir@example.com', subdomains: true, totp: false, lastUsed: now - 2 * DAY - 3 * HOUR });
    add({ id: 'lg_0a7d4e5c91b2', profile: 'default', origin: 'https://github.com', username: 'kaivalya-ahir', subdomains: false, totp: true, lastUsed: now - 3 * HOUR });
  }
  return {
    logins,
    /** Sites signed in to that mock/browser.ts does not list. */
    sites: new Map<string, Array<{ host: string; at: number }>>(fresh ? [] : [['default', [{ host: 'gumtree.com.au', at: now - 5 * DAY }]]]),
    forgotten: new Set<string>(),
    deleted: new Set<string>(),
    usedBy: new Map<string, BrowserStatusDto['profiles'][number]['usedBy']>(fresh ? [] : [['marketplace', [{ id: 'rtn_cars', name: 'Cars under $8k', watch: true }]]]),
  };
}

type State = ReturnType<typeof browserLoginsState>;

/** The status with the logins, sites and deletions put in. */
export function withLogins(st: BrowserStatusDto, s: State): BrowserStatusDto {
  const names = new Set(st.profiles.map((p) => p.name));
  const extra = [...new Set([...s.logins.values()].map((l) => l.profile))].filter((n) => !names.has(n));
  const base = [...st.profiles, ...extra.map((name) => ({ name, engine: st.newProfileEngine ?? 'chromium', label: st.newProfileEngine === 'cloak' ? 'CloakBrowser' : 'Chromium', open: false, sites: [] }))];
  return {
    ...st,
    profiles: base
      .filter((p) => !s.deleted.has(p.name))
      .map((p) => ({
        ...p,
        // an imported site may already be listed: the newer line wins
        sites: [...(s.sites.get(p.name) ?? []), ...p.sites].filter((x, i, all) => !s.forgotten.has(`${p.name}\0${x.host}`) && all.findIndex((y) => y.host === x.host) === i),
        logins: [...s.logins.values()].filter((l) => l.profile === p.name),
        isDefault: p.name === 'default',
        usedBy: s.usedBy.get(p.name) ?? [],
      })),
  };
}

export function registerBrowserLogins(ctx: MockCtx, status: () => BrowserStatusDto, s: State) {
  const { on, fail, sleep } = ctx;

  const check = (b: BrowserLoginInput | undefined, editing?: BrowserLoginDto): Required<Pick<BrowserLoginDto, 'profile' | 'origin' | 'username'>> => {
    const profile = (b?.profile ?? editing?.profile ?? 'default').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) fail(400, `Invalid profile name "${profile}". Use letters, digits, dot, dash or underscore (max 64).`);
    const o = b?.site !== undefined ? origin(b.site) : editing?.origin;
    if (!o) fail(400, 'Site is not a web address. Use one such as https://www.facebook.com.');
    const username = (b?.username ?? editing?.username ?? '').trim();
    if (!username) fail(400, 'Username is empty.');
    if (!editing && !b?.password) fail(400, 'Password is empty.');
    if (b?.totp && !/^(otpauth:\/\/totp\/|[A-Za-z2-7=\s-]{16,})/i.test(b.totp.trim())) fail(400, 'The 2FA key is not a base32 key (letters A to Z and digits 2 to 7), or an otpauth:// link.');
    return { profile, origin: o!, username };
  };

  on('POST', '/api/browser/logins', async ({ body }: { body?: BrowserLoginInput }) => {
    const v = check(body);
    if ([...s.logins.values()].some((l) => l.profile === v.profile && l.origin === v.origin && l.username.toLowerCase() === v.username.toLowerCase()))
      fail(400, `Profile ${v.profile} already has a login for ${hostOf(v.origin)} as ${v.username}. Edit that one.`);
    await sleep(300);
    const now = Date.now();
    const id = `lg_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
    s.logins.set(id, { id, ...v, host: hostOf(v.origin), subdomains: !!body?.subdomains, password: true, totp: !!body?.totp, createdAt: now, updatedAt: now });
    s.deleted.delete(v.profile);
    return status();
  });

  on('PUT', '/api/browser/logins/:id', async ({ params, body }: { params: string[]; body?: BrowserLoginInput }) => {
    const cur = s.logins.get(params[0]);
    if (!cur) fail(404, 'That saved login is gone.');
    const v = check(body, cur);
    await sleep(250);
    s.logins.set(cur!.id, {
      ...cur!,
      ...v,
      host: hostOf(v.origin),
      subdomains: body?.subdomains ?? cur!.subdomains,
      totp: body?.totp === null || body?.totp === '' ? false : body?.totp ? true : cur!.totp,
      password: true,
      updatedAt: Date.now(),
    });
    return status();
  });

  on('DELETE', '/api/browser/logins/:id', ({ params }: { params: string[] }) => {
    if (!s.logins.delete(params[0])) fail(404, 'That saved login is gone.');
    return status();
  });

  on('POST', '/api/browser/profiles/:name/forget', async ({ params, body }: { params: string[]; body?: { host?: string } }) => {
    const host = body?.host?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!host) fail(400, 'host must be the site, such as facebook.com');
    await sleep(900);
    s.forgotten.add(`${params[0]}\0${host}`);
    return status();
  });

  on('POST', '/api/browser/profiles/:name/cookies', async ({ params, body }: { params: string[]; body?: { file?: unknown } }): Promise<BrowserCookieImportResult> => {
    const name = params[0];
    if (!status().profiles.some((p) => p.name === name)) fail(404, `There is no browser profile ${name}.`);
    if (typeof body?.file !== 'string') fail(400, 'file must be the text of the cookie export');
    let r: ReturnType<typeof parseCookieFile>;
    try {
      r = parseCookieFile(body!.file as string);
    } catch (err) {
      if (err instanceof CookieFileError) fail(400, err.message);
      throw err;
    }
    await sleep(700);
    const sites = cookiesPerSite(r!.cookies);
    const now = Date.now();
    const list = (s.sites.get(name) ?? []).filter((x) => !sites.some((y) => y.domain === x.host));
    s.sites.set(name, [...sites.slice(0, 50).map((x) => ({ host: x.domain, at: now })), ...list]);
    for (const x of sites) s.forgotten.delete(`${name}\0${x.domain}`);
    return { format: r!.format, added: r!.cookies.length, expired: r!.expired, invalid: r!.invalid, sites };
  });

  on('DELETE', '/api/browser/profiles/:name', async ({ params, query }: { params: string[]; query: URLSearchParams }) => {
    const name = params[0];
    if (name === 'default') fail(400, 'The default profile cannot be deleted. Sessions use it when they pick no other.');
    const p = status().profiles.find((x) => x.name === name);
    if (!p) fail(404, `There is no browser profile ${name}.`);
    if (p!.open && query.get('close') !== '1') fail(409, `Profile ${name} is open in a session now. Close it first, or delete it with close.`);
    await sleep(500);
    s.deleted.add(name);
    for (const [id, l] of s.logins) if (l.profile === name) s.logins.delete(id);
    return status();
  });
}
