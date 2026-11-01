/**
 * Import cookies (browser/cookies.ts): the three export formats, SameSite
 * mapping, expired cookies left out, broken files refused with a sentence
 * that quotes nothing from the file, and the size and count caps.
 *
 *   bun test packages/core/test/browser/cookies.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { COOKIE_COUNT_MAX, COOKIE_FILE_MAX, CookieFileError, cookiesPerSite, parseCookieFile } from '../../src/browser/cookies';

const NOW = Date.UTC(2026, 9, 27, 12);
const LATER = NOW / 1000 + 30 * 86_400;
const PAST = NOW / 1000 - 86_400;
const SECRET = 'sess-value-do-not-echo-9f2';

const refuse = (text: string) => {
  try {
    parseCookieFile(text, NOW);
  } catch (err) {
    expect(err).toBeInstanceOf(CookieFileError);
    return (err as Error).message;
  }
  throw new Error('parsed');
};

describe('Cookie-Editor / EditThisCookie JSON', () => {
  test('fields map to Playwright: hostOnly, session, sameSite, expirationDate', () => {
    const r = parseCookieFile(
      JSON.stringify([
        { name: 'c_user', value: SECRET, domain: '.facebook.com', path: '/', expirationDate: LATER + 0.5, secure: true, httpOnly: false, sameSite: 'no_restriction', hostOnly: false, session: false },
        { name: 'xs', value: 'v2', domain: 'www.facebook.com', path: '/x', expirationDate: LATER, secure: true, httpOnly: true, sameSite: 'strict', hostOnly: true },
        { name: 'lang', value: 'en', domain: 'facebook.com', secure: false, sameSite: 'unspecified', hostOnly: false, session: true },
        { name: 'a', value: 'b', domain: '.facebook.com', sameSite: 'lax' },
        { name: 'none-no-secure', value: 'b', domain: 'facebook.com', sameSite: 'no_restriction', secure: false },
      ]),
      NOW,
    );
    expect(r.format).toBe('json');
    expect(r.cookies).toEqual([
      { name: 'c_user', value: SECRET, domain: '.facebook.com', path: '/', expires: Math.floor(LATER + 0.5), httpOnly: false, secure: true, sameSite: 'None' },
      { name: 'xs', value: 'v2', domain: 'www.facebook.com', path: '/x', expires: Math.floor(LATER), httpOnly: true, secure: true, sameSite: 'Strict' },
      { name: 'lang', value: 'en', domain: '.facebook.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
      { name: 'a', value: 'b', domain: '.facebook.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
      // SameSite=None needs Secure; Chromium would refuse it otherwise
      { name: 'none-no-secure', value: 'b', domain: 'facebook.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
    ]);
    expect(r.expired).toBe(0);
    expect(r.invalid).toBe(0);
  });

  test('expired cookies and broken entries are counted and left out', () => {
    const r = parseCookieFile(
      JSON.stringify([
        { name: 'old', value: 'x', domain: '.a.com', expirationDate: PAST },
        { name: 'ok', value: 'x', domain: '.a.com', expirationDate: LATER },
        { name: 'nodomain', value: 'x' },
        { name: 'bad;', value: 'x', domain: 'a.com' },
        { name: 'baddomain', value: 'x', domain: 'a com/<script>' },
        { name: 5, value: 'x', domain: 'a.com' },
        'just text',
      ]),
      NOW,
    );
    expect(r.cookies.map((c) => c.name)).toEqual(['ok']);
    expect(r.expired).toBe(1);
    expect(r.invalid).toBe(5);
  });
});

describe('Playwright storageState', () => {
  test('{cookies:[...]} with expires and Playwright sameSite', () => {
    const r = parseCookieFile(
      JSON.stringify({
        cookies: [
          { name: 'sid', value: SECRET, domain: 'github.com', path: '/', expires: LATER, httpOnly: true, secure: true, sameSite: 'Lax' },
          { name: 's', value: '1', domain: '.github.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'None' },
          { name: 'gone', value: '1', domain: '.github.com', path: '/', expires: PAST, httpOnly: false, secure: true, sameSite: 'None' },
        ],
        origins: [{ origin: 'https://github.com', localStorage: [] }],
      }),
      NOW,
    );
    expect(r.format).toBe('storage-state');
    expect(r.cookies.map((c) => [c.name, c.domain, c.expires, c.sameSite])).toEqual([
      ['sid', 'github.com', Math.floor(LATER), 'Lax'],
      ['s', '.github.com', -1, 'None'],
    ]);
    expect(r.expired).toBe(1);
  });
});

describe('Netscape cookies.txt', () => {
  test('subdomain flag, #HttpOnly_, session (0) and expired lines', () => {
    const txt = [
      '# Netscape HTTP Cookie File',
      '# https://curl.se/docs/http-cookies.html',
      '',
      `.example.com\tTRUE\t/\tTRUE\t${Math.floor(LATER)}\tsid\t${SECRET}`,
      `#HttpOnly_shop.example.com\tFALSE\t/cart\tFALSE\t0\tcart\t42`,
      `.example.com\tTRUE\t/\tFALSE\t${Math.floor(PAST)}\told\tx`,
      'broken line with no tabs',
    ].join('\r\n');
    const r = parseCookieFile(txt, NOW);
    expect(r.format).toBe('netscape');
    expect(r.cookies).toEqual([
      { name: 'sid', value: SECRET, domain: '.example.com', path: '/', expires: Math.floor(LATER), httpOnly: false, secure: true, sameSite: 'Lax' },
      { name: 'cart', value: '42', domain: 'shop.example.com', path: '/cart', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
    ]);
    expect(r.expired).toBe(1);
    expect(r.invalid).toBe(1);
  });
});

describe('refused', () => {
  test('bad input says why and quotes nothing from the file', () => {
    for (const [text, why] of [
      ['', 'empty'],
      [`{"cookies": [${SECRET}`, 'not valid JSON'],
      [`{"name": "${SECRET}"}`, 'not a cookie list'],
      [`hello ${SECRET}`, 'not a cookie export'],
      [JSON.stringify([{ name: 'x', value: SECRET, domain: 'a.com', expirationDate: PAST }]), 'expired'],
      [JSON.stringify([{ value: SECRET }]), 'no cookies'],
    ] as const) {
      const msg = refuse(text);
      expect(msg).toContain(why);
      expect(msg).not.toContain(SECRET);
    }
  });

  test('a domain over 253 characters, a path over 1024, a single label or a public suffix is left out', () => {
    const long = `${'a.'.repeat(126)}com`; // 255 characters
    const r = parseCookieFile(
      JSON.stringify([
        { name: 'long', value: 'x', domain: long },
        { name: 'path', value: 'x', domain: 'a.com', path: `/${'p'.repeat(1024)}` },
        { name: 'tld', value: 'x', domain: '.com' },
        { name: 'bare', value: 'x', domain: 'localhost' },
        { name: 'psl', value: 'x', domain: '.co.uk' },
        { name: 'psl2', value: 'x', domain: 'github.io' },
        { name: 'ok', value: 'x', domain: '.bbc.co.uk', path: `/${'p'.repeat(1023)}` },
        { name: 'ok2', value: 'x', domain: `${'a.'.repeat(125)}com` },
      ]),
      NOW,
    );
    expect(r.cookies.map((c) => c.name)).toEqual(['ok', 'ok2']);
    expect(r.invalid).toBe(6);
    // cookies.txt goes through the same check
    const txt = parseCookieFile(`.com\tTRUE\t/\tFALSE\t0\ttld\tx\nexample.com\tFALSE\t/\tFALSE\t0\tok\tx\n`, NOW);
    expect([txt.cookies.map((c) => c.name), txt.invalid]).toEqual([['ok'], 1]);
  });

  test('cookies.txt stops at the cap while reading, not after', () => {
    const lines = Array.from({ length: COOKIE_COUNT_MAX + 1 }, (_, i) => `a.com\tFALSE\t/\tFALSE\t0\tn${i}\tv`);
    // "more than" comes only from the in-loop check, at line 10,001; broken lines after it would be counted otherwise
    const rest = Array.from({ length: 50_000 }, () => 'broken');
    expect(refuse([...lines, ...rest].join('\n'))).toContain('more than 10000');
    // comments and blank lines do not count toward the cap
    const ok = [...lines.slice(1), ...Array.from({ length: 50 }, () => '# c'), ''].join('\n');
    expect(parseCookieFile(ok, NOW).cookies).toHaveLength(COOKIE_COUNT_MAX);
  });

  test('over 5 MB or over 10,000 cookies', () => {
    expect(refuse('[' + ' '.repeat(COOKIE_FILE_MAX) + ']')).toContain('over 5 MB');
    const many = Array.from({ length: COOKIE_COUNT_MAX + 1 }, (_, i) => ({ name: `n${i}`, value: 'v', domain: 'a.com' }));
    expect(refuse(JSON.stringify(many))).toContain('10000 at most');
    const lines = Array.from({ length: COOKIE_COUNT_MAX + 1 }, (_, i) => `a.com\tFALSE\t/\tFALSE\t0\tn${i}\tv`).join('\n');
    expect(refuse(lines)).toContain('10000 at most');
    // exactly the cap is fine
    expect(parseCookieFile(JSON.stringify(many.slice(1)), NOW).cookies).toHaveLength(COOKIE_COUNT_MAX);
  });
});

test('cookies per site, most first', () => {
  expect(cookiesPerSite([{ domain: '.a.com' }, { domain: 'a.com' }, { domain: 'b.com' }, { domain: '.c.com' }, { domain: 'c.com' }, { domain: 'c.com' }])).toEqual([
    { domain: 'c.com', cookies: 3 },
    { domain: 'a.com', cookies: 2 },
    { domain: 'b.com', cookies: 1 },
  ]);
});
