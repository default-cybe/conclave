/**
 * A member's own browser (docs/design/ACCOUNTS.md 5), with a fake launcher so
 * it runs without Chromium: the profile is under accounts/<id>/, cookies of
 * the owner's browser are not in the member's, a member's saved logins use
 * their own key, a member's browser refuses file:// and the hub's network,
 * at most two members' browsers run at once, and ReadPost stops at the disk cap.
 *
 *   bun test packages/core/test/browser/member-profile.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { ConfigStore } from '../../src/config';
import type { ConclaveConfig } from '../../src/config/schema';
import { BrowserManager, MEMBER_BROWSER_BUSY } from '../../src/browser';
import { runAs } from '../../src/people/context';
import { ReadPostTool } from '../../src/tools/read-post';
import type { ToolContext } from '../../src/tools/types';

const dirs: string[] = [];
const managers: BrowserManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class FakePage extends EventEmitter {
  closed = false;
  at = 'about:blank';
  readonly frame = {};
  ctx: unknown;
  context() {
    return this.ctx;
  }
  mainFrame() {
    return this.frame;
  }
  isClosed() {
    return this.closed;
  }
  url() {
    return this.at;
  }
  async close() {
    this.closed = true;
    this.emit('close', this);
  }
  async waitForLoadState() {}
}

/** Cookies per profile folder, like Chromium keeps them on disk. */
const jars = new Map<string, Array<{ name: string; value: string }>>();

function setup(memberMax = 2) {
  const home = mkdtempSync(join(tmpdir(), 'conclave-member-browser-'));
  dirs.push(home);
  const config = new ConfigStore(home, { browser: { headless: true } as ConclaveConfig['browser'] });
  const launched: string[] = [];
  const routed: string[] = [];
  const launcher = {
    async launchPersistentContext(dir: string) {
      launched.push(dir);
      const page = new FakePage();
      const ctx = {
        pages: () => [page],
        newPage: async () => Object.assign(new FakePage(), { ctx }),
        on: () => {},
        setDefaultTimeout: () => {},
        setDefaultNavigationTimeout: () => {},
        route: async () => void routed.push(dir),
        routeWebSocket: async () => {},
        addCookies: async (c: Array<{ name: string; value: string }>) => void jars.set(dir, [...(jars.get(dir) ?? []), ...c]),
        cookies: async () => jars.get(dir) ?? [],
        close: async () => {},
      };
      page.ctx = ctx;
      return ctx as unknown as BrowserContext;
    },
  };
  const m = new BrowserManager({ config, launcher, memberMax });
  managers.push(m);
  return { m, home, launched, routed };
}

describe("a member's own browser", () => {
  test('the profile is under accounts/<id>/, guarded, and has none of the owner cookies', async () => {
    const { m, home, launched, routed } = setup();
    const own = await m.page('own-s');
    await own.context().addCookies([{ name: 'sid', value: 'owner-secret', domain: 'example.com', path: '/' }] as never);
    const mine = await runAs('acc_alice', () => m.page('alice-s'));
    expect(launched[1]).toBe(join(home, 'accounts', 'acc_alice', 'browser-profile'));
    expect(launched[0].startsWith(join(home, 'accounts'))).toBe(false);
    // only the member's context gets the address guard
    expect(routed).toEqual([launched[1]]);
    expect(await mine.context().cookies()).toEqual([]);
    expect((await own.context().cookies()).map((c) => c.value)).toEqual(['owner-secret']);
    // a member's session cannot name another profile, and nobody else's session uses the member's
    await runAs('acc_alice', async () => expect(() => m.setProfile('alice-s', 'shopping')).toThrow('one profile'));
    await expect(m.page('own-2', '@acc_alice')).rejects.toThrow("not this session's");
    // another member never reaches alice's session (the engine says whose a session is)
    m.accountFor = (id) => (id.startsWith('alice') ? 'acc_alice' : undefined);
    await runAs('acc_bob', async () => expect(() => m.profileFor('alice-s')).toThrow('no such browser session'));
    // the owner's profile list does not show it
    expect(m.listProfiles()).toEqual(['default']);
  });

  test("a member's saved logins use their own key in their folder, never the hub's", () => {
    const { m, home } = setup();
    const v = m.loginsFor('acc_alice');
    const l = v.add({ site: 'https://example.com', username: 'alice', password: 'pw-alice', profile: 'whatever' });
    expect(l.profile).toBe('default');
    expect(v.keyFile).toBe(join(home, 'accounts', 'acc_alice', 'browser-logins.key'));
    expect(existsSync(v.keyFile)).toBe(true);
    expect(existsSync(join(home, 'browser-logins.key'))).toBe(false);
    expect(v.secret(l.id, 'password')).toBe('pw-alice');
    expect(m.logins.list()).toEqual([]);
    expect(m.loginsFor('acc_bob').list()).toEqual([]);
    expect(m.loginsFor('owner')).toBe(m.logins);
  });

  test("a member's browser refuses file:// and the hub's own network", async () => {
    const { m } = setup();
    await runAs('acc_alice', async () => {
      for (const url of ['file:///etc/passwd', 'http://127.0.0.1:8080/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/']) {
        await expect(m.navigate('alice-s', url)).rejects.toThrow();
      }
      expect(await m.memberRefusal('https://93.184.215.14/')).toBeUndefined();
    });
  });

  test("at most two members' browsers run at once; the owner's is not counted", async () => {
    const { m } = setup(2);
    await runAs('acc_a', () => m.page('a-s'));
    await runAs('acc_b', () => m.page('b-s'));
    await expect(runAs('acc_c', () => m.page('c-s'))).rejects.toThrow(MEMBER_BROWSER_BUSY);
    await m.page('owner-s');
    // a's own browser is still there for a
    await runAs('acc_a', () => m.page('a-s2'));
  });

  test("a member's session never goes out through the hub's proxy", async () => {
    const { m } = setup();
    await runAs('acc_alice', async () => {
      await m.page('alice-s');
      for (const want of [true, 'JP']) await expect(m.useProxy('alice-s', want)).rejects.toThrow("The hub's proxy is the owner's");
      expect(m.proxied('alice-s')).toBe(false);
      // turning it off is always allowed
      expect(await m.useProxy('alice-s', false)).toBeUndefined();
    });
  });

  test("a member's browser does not start over their disk cap", async () => {
    const { m } = setup();
    m.diskRefusal = (acct) => (acct === 'acc_full' ? 'Your files on this hub are over your limit.' : undefined);
    await expect(runAs('acc_full', () => m.page('f-s'))).rejects.toThrow('over your limit');
    await m.page('owner-s');
  });
});

describe('ReadPost and the disk cap', () => {
  test('refuses before downloading when the member is over their cap', async () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-readpost-cap-'));
    dirs.push(home);
    const ctx = {
      sessionId: 's1',
      session: { id: 's1', accountId: 'acc_alice' },
      signal: new AbortController().signal,
      host: { outputsDir: () => home, diskRefusal: () => 'Your files on this hub are over your limit.' },
    } as unknown as ToolContext;
    const out = await ReadPostTool.run({ url: 'https://example.com/clip.mp4' }, ctx);
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain('over your limit');
  });
});
