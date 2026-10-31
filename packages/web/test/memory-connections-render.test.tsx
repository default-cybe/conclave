/**
 * /memory/connections renders a bounded number of times: no update loop
 * (React error #185, "Maximum update depth exceeded") as the list loads,
 * fails, or the hub answers a member with 403.
 *
 * Renders into a DOM (linkedom, from core's dependencies).
 *
 *   bun test packages/web/test/memory-connections-render.test.tsx
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ReactNode } from 'react';

const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'fetch'];
class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const CONN = {
  id: 'basic-memory',
  type: 'basic-memory',
  name: 'Basic Memory',
  enabled: true,
  mode: 'mirror',
  search: true,
  timeoutMs: 3000,
  options: { url: 'http://192.168.0.66:8000/mcp', project: 'main' },
  status: { state: 'ok', imported: 12, failures: 0, latencyMs: 40, lastSync: { at: Date.now() - 60_000, added: 1, updated: 0, removed: 0, unchanged: 11, total: 12, skipped: 0 } },
  capabilities: { search: true, write: true, pull: true },
};

/** What GET /api/memory/connections answers in the current test. */
let answer: () => Response = () => Response.json([CONN]);

beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  Object.defineProperty(win, 'location', { configurable: true, value: new URL('http://hub.test/memory/connections') });
  win.matchMedia = (q: string) => ({ matches: q.includes('min-width: 1280px'), media: q, addEventListener() {}, removeEventListener() {} });
  g.window = win;
  g.document = dom.document;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.matchMedia = win.matchMedia;
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  g.MutationObserver = Quiet;
  g.ResizeObserver = Quiet;
  g.IntersectionObserver = Quiet;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/memory/connections') return answer();
    return Response.json(path.endsWith('/presets') ? [] : {});
  }) as typeof fetch;
});

afterAll(async () => {
  await Bun.sleep(100);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});

/** Mount the Memory page on /memory/connections, count its commits, and wait for the list to settle. */
async function mountConnections(conn: 'open' | 'connecting' = 'open') {
  const { act, Profiler } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Route, Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { connectClient } = await import('../src/lib/api');
  const { useHub } = await import('../src/store/store');
  const { useConnections } = await import('../src/features/memory/store');
  const { default: MemoryPage } = await import('../src/features/memory/MemoryPage');
  await connectClient({ baseUrl: 'http://hub.test', token: 't' });
  useHub.setState({ conn, booted: conn === 'open' });
  useConnections.setState({ list: undefined, error: undefined, loading: false });
  const errors: unknown[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host, { onUncaughtError: (e) => errors.push(e), onCaughtError: (e) => errors.push(e) });
  let commits = 0;
  const wrap = (el: ReactNode) => (
    <Profiler id="memory" onRender={() => commits++}>
      {el}
    </Profiler>
  );
  await act(async () =>
    root.render(
      wrap(
        <Router hook={memoryLocation({ path: '/memory/connections' }).hook}>
          <Route path="/memory/:tab?" component={MemoryPage} />
        </Router>,
      ),
    ),
  );
  await act(async () => Bun.sleep(50));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, errors, commits: () => commits, act, useHub };
}

describe('/memory/connections', () => {
  test('a list loads in a few renders, with no update loop', async () => {
    answer = () => Response.json([CONN]);
    const { host, errors, commits } = await mountConnections();
    expect(errors).toEqual([]);
    expect(host.textContent).toContain('Basic Memory');
    expect(commits()).toBeLessThan(15);
  });

  test('a member (403) and a failing hub settle too', async () => {
    for (const status of [403, 500]) {
      answer = () => Response.json({ error: 'forbidden' }, { status });
      const { errors, commits } = await mountConnections();
      expect(errors).toEqual([]);
      expect(commits()).toBeLessThan(15);
      await unmount?.();
      unmount = undefined;
    }
  });

  test('opened at app start, before the socket connects, settles', async () => {
    answer = () => Response.json([CONN]);
    const { errors, commits, act, useHub } = await mountConnections('connecting');
    await act(async () => {
      useHub.setState({ conn: 'open', booted: true, configVersion: useHub.getState().configVersion + 1, memories: {} });
      await Bun.sleep(50);
    });
    expect(errors).toEqual([]);
    expect(commits()).toBeLessThan(20);
  });

  test('a config reload and a reconnect do not start a loop', async () => {
    answer = () => Response.json([CONN]);
    const { errors, commits, act, useHub } = await mountConnections();
    const before = commits();
    await act(async () => {
      useHub.setState({ configVersion: useHub.getState().configVersion + 1 });
      useHub.setState({ conn: 'closed' });
      useHub.setState({ conn: 'open' });
      await Bun.sleep(50);
    });
    expect(errors).toEqual([]);
    expect(commits() - before).toBeLessThan(15);
  });
});
