/**
 * A toast cut short (components/ui/Toast.tsx): a line wider than its box
 * gets a chevron, "Show full message", that opens the whole text with Copy;
 * an open toast stays until folded or closed. A short line gets no chevron.
 *
 * Renders into a DOM (linkedom, from core's dependencies). linkedom has no
 * layout, so each element reports a width from its text: 7px a character in
 * a 300px box.
 *
 *   bun test packages/web/test/toast-expand.test.tsx
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const LONG = 'Failed. A subagent runs where its parent session runs. Move the parent session instead.';
const SHORT = 'Saved.';

const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver'];
/** Observers that watch nothing: the DOM here has no layout. */
class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
  Object.defineProperty(win.HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return (this.textContent ?? '').length * 7;
    },
  });
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
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await Bun.sleep(300);
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

async function mountToaster() {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { useHub } = await import('../src/store/store');
  const { Toaster } = await import('../src/components/ui/Toast');
  useHub.setState({ toasts: [] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Router hook={memoryLocation({ path: '/' }).hook}><Toaster /></Router>));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, act, useHub };
}

const chevron = (host: Element) => host.querySelector('button[aria-label="Show full message"]') as HTMLButtonElement | null;

describe('a toast cut short', () => {
  test('a long message shows the chevron, a short one does not', async () => {
    const { host, act } = await mountToaster();
    const { toast } = await import('../src/store/store');
    await act(async () => void toast({ title: SHORT, sticky: true }));
    expect(chevron(host)).toBeNull();
    await act(async () => void toast({ title: LONG, level: 'error', sticky: true }));
    const b = chevron(host);
    expect(b).not.toBeNull();
    expect(b!.getAttribute('aria-expanded')).toBe('false');
  });

  test('opening shows the full text with Copy and stops auto dismiss until folded', async () => {
    const { host, act, useHub } = await mountToaster();
    const { toast } = await import('../src/store/store');
    let id = '';
    await act(async () => void (id = toast({ title: LONG, level: 'error', ttl: 120 })));
    const p = host.querySelector('[data-toast] p')!;
    expect(p.className).toContain('truncate');
    await act(async () => chevron(host)!.click());
    expect(chevron(host)!.getAttribute('aria-expanded')).toBe('true');
    expect(p.className).not.toContain('truncate');
    expect(p.className).toContain('whitespace-pre-wrap');
    expect(p.textContent).toBe('Failed. A subagent runs where its parent session runs. Move the parent session instead.');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Copy')).toBe(true);
    await act(async () => void (await Bun.sleep(300)));
    expect(useHub.getState().toasts.some((t) => t.id === id)).toBe(true);
    // folded, the timer runs out again
    await act(async () => chevron(host)!.click());
    await act(async () => void (await Bun.sleep(300)));
    expect(useHub.getState().toasts.some((t) => t.id === id)).toBe(false);
  });
});
