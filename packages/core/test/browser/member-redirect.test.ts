/**
 * A member's browser and Capture never reach the hub's own network through a
 * redirect (docs/design/ACCOUNTS.md 5). Playwright's routes do not see redirect
 * hops, so a public page answering 302 to 127.0.0.1 used to load the hub's
 * page. Real Chromium: a local "public" server (the test's address hook lets
 * its port count as public) redirects to a second local server that serves
 * INTERNAL-SECRET; the member must never see it, and the second server must
 * never be asked. Skipped without playwright-core and a Chromium.
 *
 *   bun test packages/core/test/browser/member-redirect.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import type { ConclaveConfig } from '../../src/config/schema';
import { BrowserManager, findBrowserExecutable } from '../../src/browser';
import { capture } from '../../src/browser/capture';
import { runAs } from '../../src/people/context';
import { resolvePublic } from '../../src/people/net';

const exe = findBrowserExecutable({ headless: true, extraDirs: ['/var/lib/conclave/browser/ms-playwright'] });
let pw: typeof import('playwright-core') | undefined;
try {
  pw = await import('playwright-core');
} catch {
  pw = undefined;
}
const live = exe && pw ? describe : describe.skip;

live("a member's browser and Capture do not follow a redirect into the hub's network", () => {
  const home = mkdtempSync(join(tmpdir(), 'conclave-member-redirect-'));
  let internalHits = 0;
  const internal = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      internalHits++;
      return new Response('<!doctype html><title>INTERNAL-SECRET</title><p>INTERNAL-SECRET</p>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const targets = [`http://127.0.0.1:${internal.port}/x`, `http://localhost:${internal.port}/x`, `http://[::ffff:127.0.0.1]:${internal.port}/x`];
  const attacker = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      const i = Number(u.searchParams.get('to') ?? -1);
      if (u.pathname === '/r') return new Response(null, { status: 302, headers: { location: targets[i] } });
      return new Response('<!doctype html><title>public</title><p>public page</p>', { headers: { 'content-type': 'text/html' } });
    },
  });
  // the attacker's port counts as public; everything else gets the real check (loopback is refused)
  const publicAddress = (host: string, port: number) => (host === '127.0.0.1' && port === attacker.port ? Promise.resolve('127.0.0.1') : resolvePublic(host));
  const config = new ConfigStore(home, { browser: { headless: true, executablePath: exe } as ConclaveConfig['browser'] });
  const m = new BrowserManager({ config, memberAddress: publicAddress });
  afterAll(async () => {
    await m.close().catch(() => {});
    internal.stop(true);
    attacker.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  test('the public page itself loads', async () => {
    await runAs('acc_alice', async () => {
      await m.navigate('alice-s', `http://127.0.0.1:${attacker.port}/`);
      expect(await (await m.page('alice-s')).content()).toContain('public page');
    });
  }, 60_000);

  test('a 302 to 127.0.0.1, localhost or a mapped address is blocked before the request is sent', async () => {
    await runAs('acc_alice', async () => {
      for (let i = 0; i < targets.length; i++) {
        await m.navigate('alice-s', `http://127.0.0.1:${attacker.port}/r?to=${i}`).catch(() => undefined);
        const page = await m.page('alice-s');
        // Chromium's error page replaces the blocked one
        await page.waitForLoadState('load').catch(() => {});
        await page.waitForTimeout(300);
        expect(await page.content()).not.toContain('INTERNAL-SECRET');
        // a request from the public page through the same redirect does not reach it either (internalHits)
        await m.navigate('alice-s', `http://127.0.0.1:${attacker.port}/`);
        await page.evaluate(async (u) => fetch(u, { mode: 'no-cors' }).then(() => 'ok', () => 'failed'), `http://127.0.0.1:${attacker.port}/r?to=${i}`);
      }
    });
    expect(internalHits).toBe(0);
  }, 60_000);

  test('Capture as a member: the redirect does not reach the internal server', async () => {
    const r = await runAs('acc_alice', () =>
      capture(`http://127.0.0.1:${attacker.port}/r?to=0`, { widths: [390], themes: ['light'], browsers: ['chromium'], scroll: false, earlyFrame: -1 }, {
        chromium: pw!.chromium,
        chromiumPath: exe!,
        ffmpeg: async () => ({ error: 'none' }),
        outDir: home,
        publicAddress,
      }),
    );
    const b = r.results[0];
    expect(readFileSync(b.report, 'utf8')).not.toContain('INTERNAL-SECRET');
    expect(internalHits).toBe(0);
  }, 120_000);
});
