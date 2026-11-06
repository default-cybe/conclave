/**
 * A provider key saves only on a press (components/providers/ProviderRow.tsx):
 * a paste, a blur or a password manager fill never stores or tests it; Save
 * and Enter do. Save is off while the field is empty or holds the key just
 * tried, and the field tells password managers to stay out.
 *
 *   bun test packages/web/test/provider-key-save.test.tsx
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'fetch'];
const saved: Record<string, unknown> = {};
const saves: unknown[] = [];
let tests = 0;
class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeAll(() => {
  const { parseHTML } = createRequire(join(import.meta.dir, '../../core/package.json'))('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  Object.assign(g, {
    window: win,
    document: dom.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    matchMedia: win.matchMedia,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: Quiet,
    ResizeObserver: Quiet,
    IntersectionObserver: Quiet,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/secrets' && init?.method === 'PUT') {
        saves.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      if (u.pathname.endsWith('/test')) {
        tests++;
        return Response.json({ ok: false, detail: '401 Unauthorized' });
      }
      return Response.json([]);
    },
  });
});
afterAll(async () => {
  await Bun.sleep(50);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

// linkedom sends no events React hears: call the handlers React attached
type Props = Record<string, ((e: unknown) => void) | boolean | undefined>;
const props = (el: Element) => (el as unknown as Record<string, Props>)[Object.keys(el).find((k) => k.startsWith('__reactProps'))!]!;

test('paste and blur never save; Save and Enter do; Save is off when empty or unchanged', async () => {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { connectClient } = await import('../src/lib/api');
  const { ProviderRow } = await import('../src/components/providers/ProviderRow');
  await connectClient({ baseUrl: 'http://hub.test', token: 't' });

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<ProviderRow provider="openai" />));

  const input = () => host.querySelector('input[aria-label="OpenAI API key"]')!;
  const save = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
  // the house Button marks itself aria-disabled and swallows the click
  const off = () => save().getAttribute('aria-disabled') === 'true';
  expect(input().getAttribute('type')).toBe('password');
  // linkedom keeps React's attribute case
  expect(input().getAttribute('autoComplete')).toBe('new-password');
  for (const a of ['data-1p-ignore', 'data-lpignore', 'data-bwignore']) expect(input().getAttribute(a)).toBe('true');
  expect(input().getAttribute('data-form-type')).toBe('other');
  expect(off()).toBe(true);

  // a password manager fill or a paste only changes the value
  const pasteEvent = { clipboardData: { getData: () => 'hunter2-from-a-vault' }, preventDefault() {} };
  await act(async () => {
    (props(input()).onPaste as ((e: unknown) => void) | undefined)?.(pasteEvent);
    (props(input()).onChange as (e: unknown) => void)({ target: { value: 'hunter2-from-a-vault' } });
  });
  await act(async () => (props(input()).onBlur as ((e: unknown) => void) | undefined)?.({}));
  await Bun.sleep(20);
  expect(saves).toEqual([]);
  expect(off()).toBe(false);

  // Save stores it once and tests it
  await act(async () => (props(save()).onClick as (e: unknown) => void)({}));
  await Bun.sleep(20);
  expect(saves).toEqual([{ kind: 'providers', key: 'openai', value: 'hunter2-from-a-vault' }]);
  // rejected: the same key again is unchanged, so Save is off
  expect(off()).toBe(true);

  // Enter is a press too
  await act(async () => (props(input()).onChange as (e: unknown) => void)({ target: { value: 'sk-real' } }));
  await act(async () => (props(input()).onKeyDown as (e: unknown) => void)({ key: 'Enter', preventDefault() {} }));
  await Bun.sleep(20);
  expect(saves.length).toBe(2);
  expect((saves[1] as { value: string }).value).toBe('sk-real');
  // let the second test land before unmounting: a late setState after the DOM goes throws between tests
  for (let i = 0; i < 200 && !(tests === 2 && host.textContent?.includes('Rejected')); i++) await act(async () => Bun.sleep(10));
  expect(tests).toBe(2);

  await act(async () => root.unmount());
});
