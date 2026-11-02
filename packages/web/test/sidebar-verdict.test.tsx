/**
 * A jury or debate row shows the verdict the hub keeps on session meta and
 * does not load its transcript; an older session without it still loads the
 * messages to find the verdict.
 *
 *   bun test packages/web/test/sidebar-verdict.test.tsx
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Message, Session } from '@conclave/core/types';

const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'fetch'];
const saved: Record<string, unknown> = {};
class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const asked: string[] = [];
const now = Date.now();
const session = (p: Partial<Session> & Pick<Session, 'id' | 'mode' | 'title'>): Session =>
  ({ agent: 'assistant', model: 'mock/m', permissionMode: 'default', cwd: '~', device: 'local', status: 'idle', tags: [], createdAt: now, updatedAt: now, ...p }) as Session;
const verdictMsg = (sessionId: string, text: string): Message =>
  ({ id: `${sessionId}_v`, sessionId, seq: 3, role: 'assistant', kind: 'normal', group: 'g1', author: 'Verdict', content: [{ type: 'text', text }], createdAt: now, stopReason: 'end_turn' }) as Message;

beforeAll(() => {
  const { parseHTML } = createRequire(join(import.meta.dir, '../../core/package.json'))('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  const store = new Map<string, string>();
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  Object.assign(g, {
    window: win,
    document: dom.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    matchMedia: win.matchMedia,
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: Quiet,
    ResizeObserver: Quiet,
    IntersectionObserver: Quiet,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string | URL | Request) => {
      const m = /\/api\/sessions\/([^/]+)\/messages$/.exec(new URL(String(url)).pathname);
      if (!m) return Response.json([]);
      asked.push(m[1]);
      return Response.json(m[1] === 'old' ? [verdictMsg('old', '**Neither, for now.** Go made the stronger case.')] : []);
    },
  });
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

test('the verdict on meta shows without loading the transcript; an old session falls back to its messages', async () => {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { connectClient } = await import('../src/lib/api');
  const { useHub } = await import('../src/store/store');
  const { SessionList } = await import('../src/features/chat/SessionList');
  await connectClient({ baseUrl: 'http://hub.test', token: 't' });
  useHub.setState({
    sessions: {
      jury: session({ id: 'jury', mode: 'jury', title: 'Reverse proxy', meta: { verdict: '**Use Caddy.** Three of four jurors chose it.' } }),
      old: session({ id: 'old', mode: 'debate', title: 'Rust or Go' }),
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Router hook={memoryLocation({ path: '/' }).hook}><SessionList /></Router>));
  for (let i = 0; i < 50 && !host.textContent!.includes('verdict Neither, for now'); i++) await act(async () => void (await Bun.sleep(10)));
  expect(host.textContent).toContain('verdict Caddy');
  expect(host.textContent).toContain('verdict Neither, for now');
  expect(asked).toEqual(['old']);
  await act(async () => root.unmount());
});
