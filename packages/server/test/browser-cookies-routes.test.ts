/**
 * Settings > Browser, Import cookies, over HTTP (routes-browser.ts): the file
 * goes into the profile's context with addCookies, the answer is counts per
 * site, the sites are listed as signed in, and no cookie value is in an
 * answer, the audit log or the hub's log. A fake browser context stands in
 * for Chromium; it refuses one cookie the way Playwright does. Gates hold
 * addCookies and newPage so the tests can line up an agent opening the
 * same profile, two imports at once, and an import that times out.
 *
 *   bun test packages/server/test/browser-cookies-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { BrowserManager, BrowserStepTimeout, type BrowserCookieImportResult } from '@conclave/core/browser/index.ts';
import type { BrowserStatusDto } from '@conclave/core/watches/index.ts';
import { setLogTap } from '@conclave/core/util/log.ts';
import { startHub, type TestHub } from './helpers';

const SECRET = 'imported-session-value-7c41';
const LATER = Math.floor(Date.now() / 1000) + 30 * 86_400;

let hub: TestHub;
let browser: BrowserManager;
const logs: string[] = [];
let prevTap: ReturnType<typeof setLogTap>;
let launches = 0;
let closes = 0;
/** What the fake context was given, per launch. */
const jar: Array<{ name: string; value: string; domain?: string }> = [];

/** A promise the test opens by hand. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
/** While set, addCookies and newPage wait for these. */
let cookieGate: ReturnType<typeof gate> | undefined;
let pageGate: ReturnType<typeof gate> | undefined;
/** Calls to addCookies so far; the one at this number times out. */
let addCalls = 0;
let timeoutAt = 0;

class FakePage extends EventEmitter {
  closed = false;
  isClosed() {
    return this.closed;
  }
  url() {
    return 'about:blank';
  }
  mainFrame() {
    return {};
  }
  async close() {
    this.closed = true;
    this.emit('close', this);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

beforeAll(() => {
  hub = startHub();
  prevTap = setLogTap((level, scope, msg, extra) => logs.push(`${level} ${scope} ${msg} ${extra === undefined ? '' : JSON.stringify(extra)}`));
  browser = new BrowserManager({
    config: hub.engine.config,
    launcher: {
      launchPersistentContext: async () => {
        launches++;
        const listeners: Array<() => void> = [];
        const pages: FakePage[] = [];
        let gone = false;
        return {
          pages: () => pages,
          newPage: async () => {
            await pageGate?.p;
            const p = new FakePage();
            pages.push(p);
            return p;
          },
          // the cookies persist in the profile folder, so every launch sees them all
          cookies: async () => jar,
          addCookies: async (cs: Array<{ name: string; value: string; domain?: string }>) => {
            await cookieGate?.p;
            if (gone) throw new Error('Target page, context or browser has been closed');
            if (++addCalls === timeoutAt) throw new BrowserStepTimeout('adding the cookies', 10_000);
            // Playwright refuses the whole call when one cookie is bad
            if (cs.some((c) => c.name === 'refused')) throw new Error('Invalid cookie fields');
            jar.push(...cs);
          },
          on: (ev: string, fn: () => void) => void (ev === 'close' && listeners.push(fn)),
          setDefaultTimeout: () => {},
          setDefaultNavigationTimeout: () => {},
          close: async () => {
            gone = true;
            closes++;
            for (const p of pages) await p.close();
            listeners.forEach((fn) => fn());
          },
        } as never;
      },
    },
  });
  (hub.engine as unknown as { browser: BrowserManager }).browser = browser;
});

afterAll(async () => {
  setLogTap(prevTap);
  await browser.close();
  await hub.stop();
});

const post = (profile: string, body: unknown, token?: null) => hub.api(`/api/browser/profiles/${profile}/cookies`, { method: 'POST', json: body, ...(token === null ? { token: null } : {}) });

describe('Import cookies', () => {
  test('a Cookie-Editor export: added to the profile, counts per site, the browser closed again', async () => {
    const file = JSON.stringify([
      { name: 'c_user', value: SECRET, domain: '.facebook.com', path: '/', expirationDate: LATER, secure: true, httpOnly: true, sameSite: 'no_restriction', hostOnly: false },
      { name: 'xs', value: 'v', domain: '.facebook.com', path: '/', expirationDate: LATER, secure: true, sameSite: 'lax' },
      { name: 'refused', value: 'v', domain: 'github.com', path: '/', session: true },
      { name: 'user_session', value: 'v', domain: 'github.com', path: '/', session: true, hostOnly: true, sameSite: 'strict' },
      { name: 'old', value: 'v', domain: '.github.com', expirationDate: 1000 },
    ]);
    const res = await post('default', { file });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text) as BrowserCookieImportResult).toEqual({
      format: 'json',
      added: 3,
      expired: 1,
      invalid: 1,
      sites: [
        { domain: 'facebook.com', cookies: 2 },
        { domain: 'github.com', cookies: 1 },
      ],
    });
    expect(jar.map((c) => c.name)).toEqual(['c_user', 'xs', 'user_session']);
    expect(launches).toBe(1);
    expect(closes).toBe(1);
    expect(browser.isOpen('default')).toBe(false);
    const st = (await (await hub.api('/api/browser')).json()) as BrowserStatusDto;
    expect(st.profiles.find((p) => p.name === 'default')!.sites.map((s) => s.host).sort()).toEqual(['facebook.com', 'github.com']);
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'browser.cookies.import' && a.detail === 'default: 3 cookies for 2 sites')).toBe(true);
  });

  test('a cookies.txt works too', async () => {
    const r = (await (await post('default', { file: `# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t${LATER}\tsid\t${SECRET}\n` })).json()) as BrowserCookieImportResult;
    expect(r).toMatchObject({ format: 'netscape', added: 1, sites: [{ domain: 'example.com', cookies: 1 }] });
  });

  test('a bad file is a 400 that quotes nothing; an unknown profile is a 404; no token is a 401', async () => {
    for (const file of [`[{"name": "x", "value": "${SECRET}"`, `nonsense ${SECRET}`, JSON.stringify([{ name: 'x', value: SECRET, domain: 'a.com', expirationDate: 1000 }])]) {
      const res = await post('default', { file });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(SECRET);
    }
    expect((await post('default', {})).status).toBe(400);
    expect((await post('nothere', { file: '[]' })).status).toBe(404);
    expect((await post('bad..name', { file: '[]' })).status).toBe(400);
    expect((await post('default', { file: '[]' }, null)).status).toBe(401);
  });

  const one = (name: string, domain: string, n = 1) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `${name}${i}`, value: SECRET, domain, session: true })));

  test('an agent that registers a session while an import runs keeps its browser, even before its first tab', async () => {
    expect(browser.isOpen('default')).toBe(false);
    cookieGate = gate();
    const imp = browser.importCookies('default', one('a', 'shop.example'));
    await tick();
    expect(browser.isOpen('default')).toBe(true);
    // the agent's tab is still opening: its session is there with tabs = []
    pageGate = gate();
    const agent = browser.page('agent-1', 'default');
    await tick();
    expect(browser.openIn('default')).toEqual([]);
    cookieGate.open();
    cookieGate = undefined;
    expect((await imp).added).toBe(1);
    expect(browser.isOpen('default')).toBe(true);
    pageGate.open();
    pageGate = undefined;
    await agent;
    expect(browser.openIn('default')).toEqual(['agent-1']);
    await browser.closeSession('agent-1');
    await browser.closeProfileBrowser('default');
  });

  test('an import into a browser an agent is starting does not close it', async () => {
    pageGate = gate();
    const agent = browser.page('agent-2', 'default');
    const imp = browser.importCookies('default', one('b', 'shop.example'));
    pageGate.open();
    pageGate = undefined;
    await Promise.all([agent, imp]);
    expect(browser.isOpen('default')).toBe(true);
    expect(browser.openIn('default')).toEqual(['agent-2']);
    await browser.closeSession('agent-2');
    await browser.closeProfileBrowser('default');
  });

  test('two imports at once both add all their cookies; the browser closes once, after the last', async () => {
    expect(browser.isOpen('default')).toBe(false);
    jar.length = 0;
    const closed = closes;
    cookieGate = gate();
    // the second has two batches, so it is still adding after the first is done
    const a = browser.importCookies('default', one('a', 'one.example'));
    const b = browser.importCookies('default', one('b', 'two.example', 501));
    await tick();
    cookieGate.open();
    cookieGate = undefined;
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.added, ra.invalid, rb.added, rb.invalid]).toEqual([1, 0, 501, 0]);
    expect(jar.length).toBe(502);
    expect(closes - closed).toBe(1);
    expect(browser.isOpen('default')).toBe(false);
  });

  test('an import that times out answers 504 and is audited with what got in, never a value', async () => {
    timeoutAt = addCalls + 2;
    const res = await post('default', { file: one('t', 'bulk.example', 501) });
    timeoutAt = 0;
    expect(res.status).toBe(504);
    expect(await res.text()).not.toContain(SECRET);
    const rows = hub.engine.repos.audit.list({ limit: 20 }).filter((x) => x.action === 'browser.cookies.import');
    expect(rows.some((x) => x.detail === 'default: failed after 500 cookies added')).toBe(true);
    expect(logs.some((l) => l.includes('failed after 500 added'))).toBe(true);
    // what got in is listed, so Forget can take it out
    expect(browser.signIns('default').map((s) => s.host)).toContain('bulk.example');
    expect(browser.isOpen('default')).toBe(false);
  });

  test('no cookie value anywhere an app or a log can see', () => {
    const all = [JSON.stringify(hub.engine.repos.audit.list({ limit: 500 })), logs.join('\n')].join('\n');
    expect(all).not.toContain(SECRET);
    expect(logs.some((l) => l.includes('imported 3 cookies for 2 sites into browser profile "default"'))).toBe(true);
  });
});
