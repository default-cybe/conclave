/**
 * browser_screenshot's width, height and color_scheme, with a fake browser
 * (as in close.test.ts): they apply to the one shot, and the tab's viewport
 * and color scheme are back as they were after it, also when the shot fails.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { ConfigStore } from '../../src/config';
import type { ConclaveConfig } from '../../src/config/schema';
import { BrowserManager, browserTools } from '../../src/browser';
import type { ToolContext, ToolOutput } from '../../src/tools/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Size = { width: number; height: number };

/** A page that records the emulation it was under at each screenshot. */
class FakePage extends EventEmitter {
  closed = false;
  viewport: Size | null = { width: 1280, height: 800 };
  scheme: 'light' | 'dark' | null = null;
  shots: Array<{ viewport: Size | null; scheme: string | null }> = [];
  failShot = false;
  readonly frame = {};
  mainFrame() {
    return this.frame;
  }
  isClosed() {
    return this.closed;
  }
  url() {
    return 'http://127.0.0.1/app';
  }
  viewportSize() {
    return this.viewport && { ...this.viewport };
  }
  async setViewportSize(s: Size) {
    this.viewport = { ...s };
  }
  async emulateMedia(o: { colorScheme?: 'light' | 'dark' | null }) {
    if (o.colorScheme !== undefined) this.scheme = o.colorScheme;
  }
  async screenshot() {
    if (this.failShot) throw new Error('boom');
    this.shots.push({ viewport: this.viewportSize(), scheme: this.scheme });
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  }
  async close() {
    this.closed = true;
    this.emit('close', this);
  }
  async waitForLoadState() {}
}

function setup(page: FakePage) {
  const home = mkdtempSync(join(tmpdir(), 'conclave-shot-'));
  dirs.push(home);
  const config = new ConfigStore(home, { browser: { headless: true } as ConclaveConfig['browser'] });
  const launcher = {
    async launchPersistentContext() {
      return { pages: () => [page], on: () => {}, setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, close: async () => {} } as unknown as BrowserContext;
    },
  };
  const manager = new BrowserManager({ config, launcher });
  const tool = browserTools(manager).find((t) => t.name === 'browser_screenshot')!;
  const run = (input: Record<string, unknown>): Promise<ToolOutput> => tool.run(input, { sessionId: 's1', signal: new AbortController().signal } as unknown as ToolContext);
  return { manager, run };
}

const text = (o: ToolOutput) => (typeof o.content === 'string' ? o.content : o.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n'));

describe('browser_screenshot width and color_scheme', () => {
  test('apply to the one shot and are restored after it', async () => {
    const page = new FakePage();
    const { manager, run } = setup(page);
    const out = await run({ width: 390, color_scheme: 'dark' });
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain('[image]');
    expect(page.shots).toEqual([{ viewport: { width: 390, height: 800 }, scheme: 'dark' }]);
    expect(page.viewport).toEqual({ width: 1280, height: 800 });
    expect(page.scheme).toBeNull();
    // a plain shot changes nothing
    await run({});
    expect(page.shots[1]).toEqual({ viewport: { width: 1280, height: 800 }, scheme: null });
    await manager.close();
  });

  test('a failed shot still restores the page', async () => {
    const page = new FakePage();
    const { manager, run } = setup(page);
    page.failShot = true;
    const out = await run({ width: 1440, height: 900, color_scheme: 'light' });
    expect(out.isError).toBe(true);
    expect(page.viewport).toEqual({ width: 1280, height: 800 });
    expect(page.scheme).toBeNull();
    await manager.close();
  });

  test('out-of-range inputs are refused before the page is touched', async () => {
    const page = new FakePage();
    const { manager, run } = setup(page);
    for (const bad of [{ width: 100 }, { width: 3000 }, { width: 390.5 }, { height: 10 }, { color_scheme: 'sepia' }]) {
      const out = await run(bad);
      expect(out.isError).toBe(true);
      expect(text(out)).toMatch(/must be/);
    }
    expect(page.shots).toEqual([]);
    expect(page.viewport).toEqual({ width: 1280, height: 800 });
    await manager.close();
  });

  test('a window with no emulated viewport refuses a width but takes a color scheme', async () => {
    const page = new FakePage();
    page.viewport = null;
    const { manager, run } = setup(page);
    const out = await run({ width: 390 });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('emulated viewport');
    expect(page.viewport).toBeNull();
    expect((await run({ color_scheme: 'dark' })).isError).toBeFalsy();
    expect(page.shots).toEqual([{ viewport: null, scheme: 'dark' }]);
    expect(page.scheme).toBeNull();
    await manager.close();
  });
});
