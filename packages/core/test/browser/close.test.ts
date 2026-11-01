/**
 * Closing tabs and the steps around it, with a fake browser so the Chrome
 * behaviour is pinned down whatever Chromium is installed:
 *
 * - Chrome 156 can leave a tab half closed when it is closed while a form
 *   post loads: page.close() never finishes. closeSession then closes it
 *   from the page (Page.close) instead of waiting for good.
 * - settle() waits for a navigation in flight to commit before a sign-in
 *   view closes its tab, so the login's answer (and its cookie) lands.
 * - a step that never answers fails with its name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { ConfigStore } from '../../src/config';
import type { ConclaveConfig } from '../../src/config/schema';
import { bounded, BrowserManager, BrowserStepTimeout } from '../../src/browser';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A page whose Target close can get stuck, like Chrome 156 after a form post. */
class FakePage extends EventEmitter {
  closed = false;
  closes: string[] = [];
  loadWaits = 0;
  constructor(private stuck: boolean) {
    super();
  }
  readonly frame = {};
  mainFrame() {
    return this.frame;
  }
  isClosed() {
    return this.closed;
  }
  url() {
    return 'http://127.0.0.1/login';
  }
  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', this);
  }
  close(opts: { runBeforeUnload?: boolean } = {}): Promise<void> {
    this.closes.push(opts.runBeforeUnload ? 'page' : 'target');
    // the page's own close works; a stuck Target close never answers
    if (opts.runBeforeUnload) {
      setTimeout(() => this.finish(), 20);
      return Promise.resolve();
    }
    if (this.stuck) return new Promise(() => {});
    this.finish();
    return Promise.resolve();
  }
  async waitForLoadState() {
    this.loadWaits++;
  }
}

function setup(page: FakePage) {
  const home = mkdtempSync(join(tmpdir(), 'conclave-close-'));
  dirs.push(home);
  const config = new ConfigStore(home, { browser: { headless: true } as ConclaveConfig['browser'] });
  const launcher = {
    async launchPersistentContext() {
      const ctx = {
        pages: () => [page],
        on: () => {},
        setDefaultTimeout: () => {},
        setDefaultNavigationTimeout: () => {},
        close: async () => {},
      };
      return ctx as unknown as BrowserContext;
    },
  };
  return new BrowserManager({ config, launcher });
}

describe('closing a tab', () => {
  test('a tab whose close never finishes is closed from the page', async () => {
    const page = new FakePage(true);
    const m = setup(page);
    await m.page('view');
    const t0 = Date.now();
    await m.closeSession('view');
    expect(page.closed).toBe(true);
    expect(page.closes).toEqual(['target', 'page']);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await m.close();
  }, 15_000);

  test('a tab that closes is closed once', async () => {
    const page = new FakePage(false);
    const m = setup(page);
    await m.page('view');
    await m.closeSession('view');
    expect(page.closes).toEqual(['target']);
    await m.close();
  });
});

describe('settle', () => {
  test('waits for a navigation in flight to commit, then for the load', async () => {
    const page = new FakePage(false);
    const m = setup(page);
    await m.page('view');
    // the login form posts: a navigation request of the main frame
    page.emit('request', { isNavigationRequest: () => true, frame: () => page.frame });
    setTimeout(() => page.emit('framenavigated', page.frame), 300);
    const t0 = Date.now();
    await m.settle('view', undefined, 5_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(page.loadWaits).toBe(1);
    await m.close();
  });

  test('a navigation that never commits holds it no longer than asked; no tab, nothing to wait for', async () => {
    const page = new FakePage(false);
    const m = setup(page);
    await m.settle('nobody');
    await m.page('view');
    page.emit('request', { isNavigationRequest: () => true, frame: () => page.frame });
    const t0 = Date.now();
    await m.settle('view', undefined, 400);
    expect(Date.now() - t0).toBeLessThan(1_500);
    await m.close();
  });
});

describe('bounded steps', () => {
  test('a step that never answers fails with its name', async () => {
    const err = await bounded('Input.dispatchKeyEvent', 50, new Promise(() => {})).catch((e) => e);
    expect(err).toBeInstanceOf(BrowserStepTimeout);
    expect((err as Error).message).toBe('The browser did not finish Input.dispatchKeyEvent in 50ms.');
    expect(await bounded('a quick one', 1_000, Promise.resolve(7))).toBe(7);
  });
});
