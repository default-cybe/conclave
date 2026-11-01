/**
 * Meetings panel review fixes, rendered into a DOM like run-sheet.test.tsx:
 * the overlay's ready screen shows the prep of a scheduled meeting (it has no
 * brief message), a live meeting keeps its prep and Steering tab, clearing the
 * steering sends '' (JSON drops undefined), and the list asks the hub for its
 * views instead of the 50 newest created.
 *
 *   bun test packages/web/test/meetings-panel-fixes.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Meeting, PrepView } from '../src/overlay/wire';

type Call = { method: string; path: string; query: string; body?: unknown };
const calls: Call[] = [];
let server: { port: number; stop: () => Promise<void> };

const MIN = 60_000;
const meeting = (p: Partial<Meeting> = {}): Meeting => ({ id: 'mtg_1', accountId: 'owner', sessionId: 'ses_1', device: 'd', cwd: '/p/capstone', title: 'Capstone defence', status: 'scheduled', createdAt: 1, autoAnswer: 'questions', ...p });
const PREP: PrepView = { state: 'done', draft: '## Summary\nThe generated draft', edited: '## Summary\nMy own prep', at: 1, editedAt: 2, sources: { sessions: 3, chunks: 3, workflows: 0, commits: 4, files: 5, tokensIn: 1, tokensOut: 1, leftOut: [] } };
const old = meeting({ id: 'mtg_old', title: 'Scheduled long ago', createdAt: 1, scheduledAt: Date.now() + 2 * 24 * 60 * MIN });

const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver'];
class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any;

beforeAll(async () => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  const store = new Map<string, string>();
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  g.window = win;
  g.document = dom.document;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.matchMedia = win.matchMedia;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  g.MutationObserver = Quiet;
  g.ResizeObserver = Quiet;
  g.IntersectionObserver = Quiet;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const s = Bun.serve({
    port: 0,
    fetch: async (r) => {
      const u = new URL(r.url);
      const body = r.method === 'PATCH' || r.method === 'PUT' || r.method === 'POST' ? await r.json().catch(() => undefined) : undefined;
      calls.push({ method: r.method, path: u.pathname, query: u.search, body });
      if (u.pathname === '/api/meetings') return Response.json({ meetings: u.searchParams.get('view') === 'upcoming' ? [old] : [] });
      if (u.pathname.endsWith('/prep')) return Response.json(PREP);
      if (u.pathname === '/api/meetings/presets') return Response.json({ presets: [] });
      if (r.method === 'PATCH') return Response.json(meeting({ ...(body as object) }));
      if (u.pathname === '/api/sessions') return Response.json([]);
      return Response.json({}, { status: 404 });
    },
  });
  server = { port: s.port, stop: () => s.stop(true) };
  const { connectClient } = await import('../src/lib/api');
  await connectClient({ baseUrl: `http://localhost:${s.port}`, token: 't' });
});

afterAll(async () => {
  await server.stop();
  await Bun.sleep(200);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

async function mount(node: React.ReactNode) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Router hook={memoryLocation({ path: '/meetings/mtg_1' }).hook}>{node}</Router>));
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 100 && !until(); i++)
      await act(async () => {
        await Bun.sleep(10);
      });
  };
  // a tab carries a hidden bold copy of its label for width, so its text is the label twice
  const byText = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === t || b.textContent === t + t);
  const click = async (el: Element) => await act(async () => el.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true })));
  const unmount = () => act(async () => root.unmount());
  return { host, settle, byText, click, unmount, act };
}

describe('meetings panel fixes', () => {
  test('the overlay ready screen shows the prep of a scheduled meeting, not "No brief"', async () => {
    const { Ready } = await import('../src/overlay/Setup');
    const { meetingApi } = await import('../src/overlay/hub');
    const { emptyView } = await import('../src/overlay/model');
    const { api } = await import('../src/lib/api');
    const v = emptyView();
    v.meeting = meeting({ status: 'ready' });
    const r = await mount(<Ready api={meetingApi((m, p, b) => api().request(m, p, b))} view={v} />);
    await r.settle(() => r.host.textContent!.includes('My own prep'));
    expect(r.host.textContent).toContain('My own prep');
    expect(r.host.textContent).not.toContain('No brief');
    await r.unmount();
  });

  test('a live meeting keeps its prep and the Steering tab; clearing the steering sends an empty string', async () => {
    const { PrepPanel } = await import('../src/features/meeting/Prep');
    const r = await mount(<PrepPanel meeting={meeting({ status: 'live', startedAt: Date.now(), steering: 'Be confident' })} zone="UTC" now={Date.now()} ahead={false} />);
    await r.settle(() => r.host.textContent!.includes('My own prep'));
    expect(r.host.textContent).toContain('My own prep');
    // read-only once it started
    expect(r.byText('Edit brief')).toBeUndefined();
    await r.click(r.byText('Steering')!);
    expect(r.host.textContent).toContain('Changes apply from the next answer.');
    const box = r.host.querySelector('textarea') as HTMLTextAreaElement;
    // stand-ins for the IE calls React falls back to under linkedom (run-sheet.test.tsx)
    Object.assign(box, { attachEvent() {}, detachEvent() {} });
    await r.act(async () => box.dispatchEvent(new win.Event('focusin', { bubbles: true })));
    await r.act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')!.set!.call(box, '');
      box.dispatchEvent(new win.Event('input', { bubbles: true }));
      box.dispatchEvent(new win.Event('keyup', { bubbles: true }));
    });
    await r.settle(() => !!r.byText('Save steering'));
    await r.click(r.byText('Save steering')!);
    await r.settle(() => calls.some((c) => c.method === 'PATCH'));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ steering: '' });
    await r.unmount();
  });

  test('the list reads the now, upcoming and past views, so an old scheduled meeting still shows', async () => {
    calls.length = 0;
    const { default: MeetingPage } = await import('../src/features/meeting/MeetingPage');
    const { MeetingsList } = await import('../src/features/meeting/MeetingsList');
    void MeetingPage;
    const r = await mount(<MeetingsList />);
    await r.settle(() => r.host.textContent!.includes('Scheduled long ago'));
    expect(r.host.textContent).toContain('Scheduled long ago');
    const views = calls.filter((c) => c.path === '/api/meetings').map((c) => new URLSearchParams(c.query).get('view'));
    expect(views.sort()).toEqual(['now', 'past', 'upcoming']);
    await r.unmount();
  });
});
