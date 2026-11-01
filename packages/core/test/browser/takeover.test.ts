/**
 * Take over in a chat's live view of its browser (BrowserManager.takeControl,
 * giveBack, waitForOwner): while the owner holds a session's browser, the
 * session's browser tool calls wait; Give back lets them go on with a note
 * that the page may have changed; a stopped call stops waiting; closing the
 * session gives the browser back. A fake browser: no Chromium runs.
 *
 *   bun test packages/core/test/browser/takeover.test.ts
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
import type { ToolContext } from '../../src/tools/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class FakePage extends EventEmitter {
  closed = false;
  readonly frame = {};
  mainFrame() {
    return this.frame;
  }
  isClosed() {
    return this.closed;
  }
  url() {
    return 'https://example.com/';
  }
  async title() {
    return 'Example';
  }
  async close() {
    this.closed = true;
    this.emit('close', this);
  }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'conclave-takeover-'));
  dirs.push(home);
  const config = new ConfigStore(home, { browser: { headless: true } as ConclaveConfig['browser'] });
  const pages: FakePage[] = [];
  const launcher = {
    async launchPersistentContext() {
      return {
        pages: () => pages,
        newPage: async () => {
          const p = new FakePage();
          pages.push(p);
          return p;
        },
        on: () => {},
        setDefaultTimeout: () => {},
        setDefaultNavigationTimeout: () => {},
        close: async () => {},
      } as unknown as BrowserContext;
    },
  };
  const m = new BrowserManager({ config, launcher });
  const tabs = browserTools(m).find((t) => t.name === 'browser_tabs')!;
  const progress: string[] = [];
  const run = (sessionId: string, signal = new AbortController().signal) =>
    tabs.run({ action: 'list' }, { sessionId, signal, progress: (t: string) => progress.push(t), host: {} } as unknown as ToolContext);
  return { m, run, progress };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('take over a session browser', () => {
  test('hasPage opens nothing and sees the session tab', async () => {
    const { m } = setup();
    expect(m.hasPage('s1')).toBe(false);
    await m.page('s1');
    expect(m.hasPage('s1')).toBe(true);
    expect(m.hasPage('s2')).toBe(false);
    await m.close();
  });

  test('a browser call waits while the owner holds it, and goes on after Give back', async () => {
    const { m, run, progress } = setup();
    await m.page('s1');
    m.takeControl('s1');
    expect(m.ownerHolds('s1')).toBe(true);
    let done = false;
    const call = run('s1').then((r) => {
      done = true;
      return r;
    });
    await tick();
    expect(done).toBe(false);
    expect(progress).toContain('Waiting: the owner has the browser');
    // another session's calls do not wait
    const other = await run('s2');
    expect(other.isError).toBeFalsy();
    m.giveBack('s1');
    const out = await call;
    expect(m.ownerHolds('s1')).toBe(false);
    expect(out.isError).toBeFalsy();
    expect(String(out.content)).toContain('The owner used this browser and gave it back');
    await m.close();
  });

  test('a call stopped while it waits ends with an error and leaves the hold', async () => {
    const { m, run } = setup();
    await m.page('s1');
    m.takeControl('s1');
    const ac = new AbortController();
    const call = run('s1', ac.signal);
    await tick();
    ac.abort();
    const out = await call;
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain('Stopped while the owner had the browser');
    expect(m.ownerHolds('s1')).toBe(true);
    await m.close();
  });

  test('closing the session gives the browser back', async () => {
    const { m, run } = setup();
    await m.page('s1');
    m.takeControl('s1');
    const call = run('s1');
    await tick();
    await m.closeSession('s1');
    expect(m.ownerHolds('s1')).toBe(false);
    await call;
    await m.close();
  });
});
