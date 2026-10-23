/**
 * Settings > Browser, Sites and logins, over HTTP (routes-browser.ts): save,
 * change and delete a login, Forget a site, Delete a profile. The password
 * and 2FA key go to the hub's secrets, encrypted, and never come back: not
 * in an answer, the config, the audit log or the hub's log. Delete refuses
 * the default profile and a profile a session has open, unless asked to
 * close it. No real browser runs.
 *
 *   bun test packages/server/test/browser-logins-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserManager } from '@conclave/core/browser/index.ts';
import type { BrowserStatusDto } from '@conclave/core/watches/index.ts';
import { setLogTap } from '@conclave/core/util/log.ts';
import { startHub, type TestHub } from './helpers';

const PASSWORD = 'fb-Pa55word-route-1';
const NEW_PASSWORD = 'fb-Pa55word-route-2';
const TOTP = 'JBSWY3DPEHPK3PXP';

let hub: TestHub;
let browser: BrowserManager;
const logs: string[] = [];
let prevTap: ReturnType<typeof setLogTap>;

/** A tab that is only there: enough for a session to have one open. */
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

beforeAll(() => {
  prevTap = setLogTap((level, scope, msg, extra) => logs.push(`${level} ${scope} ${msg} ${extra === undefined ? '' : JSON.stringify(extra)}`));
  hub = startHub();
  browser = new BrowserManager({
    config: hub.engine.config,
    launcher: {
      launchPersistentContext: async () => {
        const listeners: Array<() => void> = [];
        const pages: FakePage[] = [];
        return {
          pages: () => pages,
          newPage: async () => {
            const p = new FakePage();
            pages.push(p);
            return p;
          },
          on: (ev: string, fn: () => void) => void (ev === 'close' && listeners.push(fn)),
          setDefaultTimeout: () => {},
          setDefaultNavigationTimeout: () => {},
          close: async () => {
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

const json = async <T>(r: Response) => (await r.json()) as T;
const status = async () => json<BrowserStatusDto>(await hub.api('/api/browser'));
const profile = (s: BrowserStatusDto, name: string) => s.profiles.find((p) => p.name === name);

/** Everything the hub said or kept where an app or a log can see it. */
async function everythingVisible(): Promise<string> {
  const st = await (await hub.api('/api/browser')).text();
  const config = await (await hub.api('/api/config')).text();
  const audit = JSON.stringify(hub.engine.repos.audit.list({ limit: 500 }));
  return [st, config, audit, logs.join('\n'), readFileSync(join(hub.engine.config.paths.home, 'config.json'), 'utf8')].join('\n');
}

describe('saved logins', () => {
  let id = '';

  test('save: the answer says a password and 2FA key are saved, never what they are', async () => {
    const res = await hub.api('/api/browser/logins', { method: 'POST', json: { profile: 'marketplace', site: 'https://www.facebook.com/login', username: 'kai@example.com', password: PASSWORD, totp: TOTP } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(TOTP);
    const s = JSON.parse(text) as BrowserStatusDto;
    const p = profile(s, 'marketplace')!;
    expect(p.logins).toHaveLength(1);
    const l = p.logins![0];
    id = l.id;
    expect(l).toMatchObject({ profile: 'marketplace', origin: 'https://www.facebook.com', host: 'facebook.com', username: 'kai@example.com', subdomains: false, password: true, totp: true });
    expect(l.problem).toBeUndefined();
    // the hub keeps it as an encrypted secret
    const sealed = hub.engine.config.secretValue(`browser.login.${id}.password`)!;
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(browser.logins.secret(id, 'password')).toBe(PASSWORD);
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'browser.login.save' && a.detail.includes('facebook.com'))).toBe(true);
  });

  test('bad input is a 400 that does not echo the password', async () => {
    const bad = await hub.api('/api/browser/logins', { method: 'POST', json: { site: 'ftp://x.example', username: 'u', password: 'leak-me-not-1' } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('leak-me-not-1');
    expect((await hub.api('/api/browser/logins', { method: 'POST', json: { site: 'x.example', username: 'u' } })).status).toBe(400);
    expect((await hub.api('/api/browser/logins', { method: 'POST', json: { site: 'x.example', username: 'u', password: 5 } })).status).toBe(400);
    const dup = await hub.api('/api/browser/logins', { method: 'POST', json: { profile: 'marketplace', site: 'www.facebook.com', username: 'KAI@example.com', password: 'other-1' } });
    expect(dup.status).toBe(400);
  });

  test('edit: a new password replaces the old, left out keeps it; null removes the 2FA key', async () => {
    const res = await hub.api(`/api/browser/logins/${id}`, { method: 'PUT', json: { password: NEW_PASSWORD, subdomains: true } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(NEW_PASSWORD);
    expect(browser.logins.secret(id, 'password')).toBe(NEW_PASSWORD);
    await hub.api(`/api/browser/logins/${id}`, { method: 'PUT', json: { username: 'kai.ahir@example.com', totp: null } });
    const l = profile(await status(), 'marketplace')!.logins![0];
    expect(l).toMatchObject({ username: 'kai.ahir@example.com', subdomains: true, totp: false, password: true });
    expect(browser.logins.secret(id, 'password')).toBe(NEW_PASSWORD);
    expect(hub.engine.config.secretValue(`browser.login.${id}.totp`)).toBeUndefined();
    expect((await hub.api('/api/browser/logins/lg_000000000000', { method: 'PUT', json: { username: 'x' } })).status).toBe(404);
  });

  test('a login the hub cannot read says so', async () => {
    const key = join(hub.engine.config.paths.home, 'browser-logins.key');
    const was = readFileSync(key, 'utf8');
    writeFileSync(key, Buffer.alloc(32, 9).toString('base64'));
    const l = profile(await status(), 'marketplace')!.logins![0];
    expect(l.password).toBe(false);
    expect(l.problem).toContain('Save it again');
    writeFileSync(key, was);
  });

  test('delete takes the secrets with it', async () => {
    const res = await hub.api(`/api/browser/logins/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(profile(await json<BrowserStatusDto>(res), 'marketplace')).toBeUndefined();
    expect(hub.engine.config.secretValue(`browser.login.${id}.password`)).toBeUndefined();
    expect((await hub.api(`/api/browser/logins/${id}`, { method: 'DELETE' })).status).toBe(404);
  });

  test('no password or 2FA key anywhere an app or a log can see', async () => {
    const all = await everythingVisible();
    for (const s of [PASSWORD, NEW_PASSWORD, TOTP]) expect(all).not.toContain(s);
  });
});

describe('Forget a site', () => {
  test('a profile no browser ran in: the site leaves the list; a bad site is a 400', async () => {
    browser.recordSignIn('shop', 'gumtree.com');
    browser.recordSignIn('shop', 'ebay.com');
    expect(profile(await status(), 'shop')?.sites.map((x) => x.host).sort()).toEqual(['ebay.com', 'gumtree.com']);
    const res = await hub.api('/api/browser/profiles/shop/forget', { method: 'POST', json: { host: 'www.gumtree.com' } });
    expect(res.status).toBe(200);
    expect(profile(await json<BrowserStatusDto>(res), 'shop')?.sites.map((x) => x.host)).toEqual(['ebay.com']);
    expect((await hub.api('/api/browser/profiles/shop/forget', { method: 'POST', json: { host: '' } })).status).toBe(400);
    expect((await hub.api('/api/browser/profiles/shop/forget', { method: 'POST', json: { host: 'ftp://x' } })).status).toBe(400);
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'browser.forget' && a.detail.startsWith('shop: www.gumtree.com'))).toBe(true);
  });
});

describe('Delete profile', () => {
  test('the default profile cannot be deleted; an unknown one is a 404', async () => {
    const res = await hub.api('/api/browser/profiles/default', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('cannot be deleted');
    expect((await hub.api('/api/browser/profiles/nothere', { method: 'DELETE' })).status).toBe(404);
    expect(profile(await status(), 'default')?.isDefault).toBe(true);
  });

  test('the confirm can list the watches and routines that use it', async () => {
    hub.engine.routines.create({ name: 'Cars under 8k', schedule: '0 8 * * *', prompt: 'Look for cars.', watch: { url: 'https://www.facebook.com/marketplace', profile: 'marketplace' } } as never);
    hub.engine.routines.create({ name: 'Morning check', schedule: '0 7 * * *', prompt: 'Use the browser profile "marketplace" to read my messages.' } as never);
    hub.engine.routines.create({ name: 'Unrelated', schedule: '0 9 * * *', prompt: 'Read Facebook Marketplace listings.' } as never);
    browser.recordSignIn('marketplace', 'facebook.com');
    const p = profile(await status(), 'marketplace')!;
    expect(p.usedBy?.map((u) => [u.name, u.watch])).toEqual([
      ['Cars under 8k', true],
      ['Morning check', false],
    ]);
  });

  test('refused while a session has it open; with close it closes and deletes everything', async () => {
    hub.engine.config.update({ browser: { profiles: { marketplace: { engine: 'chromium' } } } } as never);
    browser.logins.add({ profile: 'marketplace', site: 'facebook.com', username: 'kai', password: PASSWORD });
    await browser.page('chat-1', 'marketplace');
    expect(browser.openIn('marketplace')).toEqual(['chat-1']);
    const busy = await hub.api('/api/browser/profiles/marketplace', { method: 'DELETE' });
    expect(busy.status).toBe(409);
    expect(await json<{ error: string; code: string }>(busy)).toMatchObject({ code: 'open' });
    const dir = join(browser.profilesDir(), 'marketplace');
    expect(existsSync(dir)).toBe(true);

    const res = await hub.api('/api/browser/profiles/marketplace?close=1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(profile(await json<BrowserStatusDto>(res), 'marketplace')).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(hub.engine.config.getUser().browser?.profiles?.marketplace).toBeUndefined();
    expect(browser.logins.list('marketplace')).toEqual([]);
    expect(browser.isOpen('marketplace')).toBe(false);
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'browser.profile.delete' && a.detail.startsWith('marketplace, with 1 saved login'))).toBe(true);
  });

  test('a closed profile goes at once', async () => {
    mkdirSync(join(browser.profilesDir(), 'oops'), { recursive: true });
    expect((await status()).profiles.map((p) => p.name)).toContain('oops');
    const res = await hub.api('/api/browser/profiles/oops', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await json<BrowserStatusDto>(res)).profiles.map((p) => p.name)).not.toContain('oops');
  });

  test('need the hub token', async () => {
    expect((await hub.api('/api/browser/profiles/shop', { method: 'DELETE', token: null })).status).toBe(401);
    expect((await hub.api('/api/browser/logins', { method: 'POST', json: {}, token: null })).status).toBe(401);
  });
});
