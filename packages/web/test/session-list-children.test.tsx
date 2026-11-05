/**
 * The boot load lists top-level sessions only, every page (store.ts
 * loadAll): a hub with 600 subagent sessions newer than an old chat still
 * lists the chat and finds it by title. The children load with their parent
 * (loadMessages), and delegated work still has its group.
 *
 *   bun test packages/web/test/session-list-children.test.tsx
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Session } from '@conclave/core/types';

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
const now = Date.now();
const session = (p: Partial<Session> & Pick<Session, 'id' | 'title'>): Session =>
  ({ agent: 'coder', model: 'mock/m', mode: 'agent', permissionMode: 'default', cwd: '~', device: 'local', status: 'idle', tags: [], pinned: false, archived: false, createdAt: now, updatedAt: now, ...p }) as Session;

// the hub: one old chat, a busy parent with 600 subagents newer than it, and one delegated job
const hub: Session[] = [
  session({ id: 'beast', title: 'Portfolio Beast', updatedAt: now - 30 * 86_400_000 }),
  session({ id: 'notes', title: 'Portfolio Beast notes', archived: true, updatedAt: now - 40 * 86_400_000 }),
  session({ id: 'busy', title: 'Release day', updatedAt: now - 1000 }),
  ...Array.from({ length: 600 }, (_, i) => session({ id: `kid${i}`, title: `Subagent ${i}`, parentId: 'busy', tags: ['subagent'], updatedAt: now - i })),
  session({ id: 'job', title: 'Find the TODOs', parentId: 'busy', tags: ['subagent', 'delegated'], meta: { subagent: true, delegate: { to: 'code' } }, updatedAt: now - 5 }),
];
const asked: URLSearchParams[] = [];

/** GET /api/sessions as the hub answers it (core storage/repos.ts list). */
function listSessions(q: URLSearchParams): Session[] {
  let out = hub.filter((s) => s.archived === (q.get('archived') === 'true'));
  if (q.get('parentId') === 'none') out = out.filter((s) => !s.parentId);
  else if (q.get('parentId')) out = out.filter((s) => s.parentId === q.get('parentId'));
  if (q.get('tag')) out = out.filter((s) => s.tags.includes(q.get('tag')!));
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  const offset = Number(q.get('offset') ?? 0);
  return out.slice(offset, offset + Number(q.get('limit') ?? 200));
}

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
      const u = new URL(String(url));
      if (u.pathname === '/api/sessions') {
        asked.push(u.searchParams);
        return Response.json(listSessions(u.searchParams));
      }
      return Response.json([]);
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

test('600 children do not push an old chat out: it is listed and found by title; children load with their parent', async () => {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { connectClient } = await import('../src/lib/api');
  const { allPages, loadAll, loadMessages, useHub } = await import('../src/store/store');
  const { delegatedRows } = await import('../src/lib/sidebar');
  const { SessionList } = await import('../src/features/chat/SessionList');
  await connectClient({ baseUrl: 'http://hub.test', token: 't' });

  await loadAll();
  const held = useHub.getState().sessions;
  expect(held.beast?.title).toBe('Portfolio Beast');
  expect(held.busy).toBeDefined();
  // no plain subagent at boot; delegated work comes for its group
  expect(Object.keys(held).filter((id) => id.startsWith('kid'))).toEqual([]);
  expect(delegatedRows({ sessions: Object.values(held), ctx: { projects: {}, devices: {} } }).map((r) => r.id)).toEqual(['job']);
  expect(asked.some((q) => q.get('parentId') === 'none' && q.get('archived') === 'false')).toBe(true);

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Router hook={memoryLocation({ path: '/' }).hook}><SessionList /></Router>));
  expect(host.textContent).toContain('Portfolio Beast');
  expect(host.textContent).not.toContain('Subagent 0');

  // the title filter finds it without searching messages
  const input = host.querySelector('input[aria-label="Filter sessions"]') as HTMLInputElement;
  // linkedom sends no input events React hears: call the filter's onChange as React would
  const props = (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void }>)[Object.keys(input).find((k) => k.startsWith('__reactProps'))!];
  await act(async () => props.onChange({ target: { value: 'portfolio beast' } }));
  expect(host.textContent).toContain('Portfolio Beast');
  expect(host.textContent).not.toContain('Release day');
  expect(host.textContent).not.toContain('No session title matches');
  // the archive's title matches are one tap away
  expect(held.notes?.archived).toBe(true);
  expect(host.textContent).toContain('1 archived session matches');
  await act(async () => root.unmount());

  // opening the parent brings its children
  await loadMessages('busy');
  for (let i = 0; i < 50 && !useHub.getState().sessions.kid599; i++) await Bun.sleep(5);
  expect(useHub.getState().sessions.kid599?.parentId).toBe('busy');
  expect(asked.some((q) => q.get('parentId') === 'busy')).toBe(true);

  // allPages stops on a short page and at 40 pages for a hub that ignores offset
  let calls = 0;
  expect((await allPages(async () => (calls++, [hub[0], hub[1]]), 2)).length).toBe(80);
  expect(calls).toBe(40);
});
