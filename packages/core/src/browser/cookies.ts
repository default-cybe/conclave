/**
 * Cookie files the owner exports from his own browser, for Import cookies in
 * Settings > Browser (BrowserManager.importCookies). Three formats, told
 * apart by what is in the file, not its name:
 *
 *   - the JSON list that Cookie-Editor and EditThisCookie write
 *     (name, value, domain, path, expirationDate, hostOnly, session, sameSite...)
 *   - Playwright's storageState JSON ({ cookies: [...] })
 *   - Netscape cookies.txt (seven tab-separated fields a line)
 *
 * Cookies are session secrets: no error here quotes the file, a name or a
 * value. Expired cookies and broken entries are counted and left out.
 */
import type { BrowserContext } from 'playwright-core';

export type PlaywrightCookie = Parameters<BrowserContext['addCookies']>[0][number];

/** The largest cookie file the hub takes. */
export const COOKIE_FILE_MAX = 5 * 1024 * 1024;
/** The most cookies in one file. */
export const COOKIE_COUNT_MAX = 10_000;

export class CookieFileError extends Error {}

export interface ParsedCookies {
  format: 'json' | 'storage-state' | 'netscape';
  cookies: PlaywrightCookie[];
  /** Left out: already expired. */
  expired: number;
  /** Left out: missing or broken fields. */
  invalid: number;
}

const DOMAIN = /^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i;
const DOMAIN_MAX = 253;
const PATH_MAX = 1024;
/**
 * Public suffixes a cookie cannot be set on. A single label (com, au) is
 * refused always; these are common two-label ones. shortcut: not the full
 * Public Suffix List, add it if exports with other suffixes show up.
 */
const PUBLIC_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.in', 'co.nz', 'com.br', 'com.cn', 'com.mx', 'co.za', 'github.io', 'herokuapp.com', 'vercel.app', 'pages.dev']);

/**
 * A cookie domain to refuse: too long, one label, or a public suffix.
 * Observed live (Chromium 1248 via Playwright addCookies): .com, com, .co.uk and .github.io are stored with no error, so these would go to every site under the suffix.
 */
function unsettableDomain(domain: string): boolean {
  const d = domain.replace(/^\./, '');
  return domain.length > DOMAIN_MAX || !d.includes('.') || PUBLIC_SUFFIXES.has(d);
}

// what a browser refuses in a cookie name or value
const BAD_CHARS = /[\x00-\x1f\x7f;]/;

function sameSiteOf(raw: unknown): 'Strict' | 'Lax' | 'None' {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  // lax, unspecified, missing: Chromium's own default
  return 'Lax';
}

type Entry = { cookie?: PlaywrightCookie; expired?: boolean };

/** One exported cookie (extension or storageState shape) as Playwright takes it. */
function fromObject(x: unknown, nowSec: number): Entry {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  const o = x as Record<string, unknown>;
  const { name, value } = o;
  let domain = typeof o.domain === 'string' ? o.domain.trim().toLowerCase() : '';
  if (typeof name !== 'string' || typeof value !== 'string' || !name || BAD_CHARS.test(name) || BAD_CHARS.test(value) || name.length + value.length > 4096) return {};
  if (unsettableDomain(domain) || !DOMAIN.test(domain)) return {};
  if (typeof o.path === 'string' && o.path.length > PATH_MAX) return {};
  // hostOnly: only that host gets it; Playwright says that with no leading dot
  if (o.hostOnly === true) domain = domain.replace(/^\./, '');
  else if (o.hostOnly === false && !domain.startsWith('.')) domain = `.${domain}`;
  const path = typeof o.path === 'string' && o.path.startsWith('/') ? o.path : '/';
  const rawExp = o.expirationDate ?? o.expires;
  let expires = -1;
  if (o.session !== true && typeof rawExp === 'number' && Number.isFinite(rawExp) && rawExp > 0) {
    if (rawExp <= nowSec) return { expired: true };
    expires = Math.floor(rawExp);
  }
  const secure = o.secure === true;
  // SameSite=None without Secure is refused by Chromium: Lax is what it would get
  let sameSite = sameSiteOf(o.sameSite);
  if (sameSite === 'None' && !secure) sameSite = 'Lax';
  return { cookie: { name, value, domain, path, expires, httpOnly: o.httpOnly === true, secure, sameSite } };
}

/** One cookies.txt line, or undefined for a comment or blank line. */
function fromNetscapeLine(line: string, nowSec: number): Entry | undefined {
  let l = line.replace(/\r$/, '');
  let httpOnly = false;
  if (l.startsWith('#HttpOnly_')) {
    httpOnly = true;
    l = l.slice('#HttpOnly_'.length);
  } else if (!l.trim() || l.startsWith('#')) return undefined;
  const f = l.split('\t');
  if (f.length !== 7) return {};
  const [domainRaw, sub, path, secureRaw, expRaw, name, value] = f;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return {};
  const domain = domainRaw.trim();
  return fromObject(
    {
      name,
      value,
      domain,
      path,
      secure: secureRaw.toUpperCase() === 'TRUE',
      httpOnly,
      hostOnly: sub.toUpperCase() !== 'TRUE',
      ...(exp > 0 ? { expires: exp } : { session: true }),
      // cookies.txt has no SameSite; Lax is the browser's default
    },
    nowSec,
  );
}

/** Parse a cookie export. Throws CookieFileError with a plain sentence. */
export function parseCookieFile(text: string, now = Date.now()): ParsedCookies {
  if (typeof text !== 'string' || !text.trim()) throw new CookieFileError('The file is empty.');
  // TextEncoder, not Buffer: the web app's mock parses with this too
  if (text.length > COOKIE_FILE_MAX || new TextEncoder().encode(text).length > COOKIE_FILE_MAX) throw new CookieFileError(`The file is over ${COOKIE_FILE_MAX / 1024 / 1024} MB.`);
  const nowSec = now / 1000;
  const body = text.replace(/^\uFEFF/, '').trim();
  let format: ParsedCookies['format'];
  let entries: Array<Entry | undefined>;
  if (body.startsWith('[') || body.startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      // the parser's message can quote the file, so it is not passed on
      throw new CookieFileError('The file is not valid JSON.');
    }
    let list: unknown;
    if (Array.isArray(data)) {
      format = 'json';
      list = data;
    } else if (data && typeof data === 'object' && Array.isArray((data as { cookies?: unknown }).cookies)) {
      format = 'storage-state';
      list = (data as { cookies: unknown[] }).cookies;
    } else throw new CookieFileError('The JSON is not a cookie list or a Playwright storage state ({"cookies": [...]}).');
    const arr = list as unknown[];
    if (arr.length > COOKIE_COUNT_MAX) throw new CookieFileError(`The file has ${arr.length} cookies; ${COOKIE_COUNT_MAX} at most.`);
    entries = arr.map((x) => fromObject(x, nowSec));
  } else {
    const lines = body.split('\n');
    if (!/^# (Netscape )?HTTP Cookie File/i.test(body) && !lines.some((l) => l.split('\t').length === 7)) {
      throw new CookieFileError('The file is not a cookie export. Use JSON from Cookie-Editor, a Playwright storage state, or a cookies.txt.');
    }
    format = 'netscape';
    entries = [];
    for (const l of lines) {
      const e = fromNetscapeLine(l, nowSec);
      if (e === undefined) continue;
      // stop at the cap, before parsing the rest
      if (entries.length >= COOKIE_COUNT_MAX) throw new CookieFileError(`The file has more than ${COOKIE_COUNT_MAX} cookies; ${COOKIE_COUNT_MAX} at most.`);
      entries.push(e);
    }
  }
  const cookies: PlaywrightCookie[] = [];
  let expired = 0;
  let invalid = 0;
  for (const e of entries) {
    if (e?.cookie) cookies.push(e.cookie);
    else if (e?.expired) expired++;
    else invalid++;
  }
  if (!cookies.length) throw new CookieFileError(expired ? `Every cookie in the file has expired (${expired}). Export them again.` : 'The file has no cookies the hub can use.');
  return { format, cookies, expired, invalid };
}

/** Cookies per site (the domain without its leading dot), most first. */
export function cookiesPerSite(cookies: Array<Pick<PlaywrightCookie, 'domain'>>): Array<{ domain: string; cookies: number }> {
  const n = new Map<string, number>();
  for (const c of cookies) {
    const d = (c.domain ?? '').replace(/^\./, '');
    n.set(d, (n.get(d) ?? 0) + 1);
  }
  return [...n].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain));
}
