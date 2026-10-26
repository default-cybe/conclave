/**
 * The Run sheet's Start and Save-as-preset handlers (features/workflows/RunSheet):
 * bad args stop the start with the reason instead of silently running with no
 * args, a no-args sheet can still save its preset (as null, like Android), and
 * a preset with null args fills the JSON box with empty, not the literal null.
 * Rendered into a DOM like model-picker.test.tsx; the sheet's api client is a
 * real ConclaveClient pointed at a local server that records the calls.
 *
 *   bun test packages/web/test/run-sheet.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { WorkflowSummary } from '@conclave/core/client';

type Call = { method: string; path: string; body?: unknown };
const calls: Call[] = [];
let server: { port: number; stop: () => Promise<void> };

const workflow: WorkflowSummary = {
  id: 'triage',
  name: 'triage',
  description: 'triages the inbox',
  phases: [],
  source: 'builtin',
  portable: true,
  runnable: true,
};

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
  // the hub the sheet talks to: answers the three preset/run routes, records every call
  const s = Bun.serve({
    port: 0,
    fetch: async (r) => {
      const body = r.method === 'POST' ? await r.json().catch(() => undefined) : undefined;
      calls.push({ method: r.method, path: new URL(r.url).pathname, body });
      if (r.method === 'GET' && r.url.endsWith('/presets'))
        return Response.json([
          { id: 'wfp_1', workflow: 'triage', name: 'no args', args: null, createdAt: 1 },
          { id: 'wfp_2', workflow: 'triage', name: 'with args', args: { question: 'Caddy?' }, createdAt: 2 },
        ]);
      if (r.method === 'POST' && r.url.endsWith('/presets')) return Response.json({ id: 'wfp_9', workflow: 'triage', name: body?.name, args: body?.args, createdAt: 3 }, { status: 201 });
      if (r.method === 'POST' && r.url.endsWith('/workflows/runs')) return Response.json({ id: 'wfr_9' }, { status: 201 });
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

async function openSheet(wf: WorkflowSummary = workflow) {
  const { RunSheet } = await import('../src/features/workflows/RunSheet');
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Router hook={memoryLocation({ path: '/workflows' }).hook}>{<RunSheet workflow={wf} onClose={() => {}} />}</Router>));
  // the dialog portals into the body, not the host
  const byText = (t: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent === t)!;
  const box = () => document.body.querySelector('textarea') as HTMLTextAreaElement;
  const field = (ph: string) => {
    const el = [...document.body.querySelectorAll('input')].find((i) => i.getAttribute('placeholder') === ph)!;
    // a browser reads a field with no type as text; linkedom says null, and React then listens for no typing
    Object.defineProperty(el, 'type', { configurable: true, get: () => el.getAttribute('type') ?? 'text' });
    return el;
  };
  const type = async (el: Element, v: string) => {
    // stand-ins for the IE calls React falls back to when react-dom runs under linkedom (model-picker.test.tsx)
    Object.assign(el, { attachEvent() {}, detachEvent() {} });
    await act(async () => el.dispatchEvent(new win.Event('focusin', { bubbles: true })));
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('keyup', { bubbles: true }));
    });
  };
  const click = async (el: Element) =>
    await act(async () => {
      el.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
    });
  // presets arrive from the server after the sheet opens: wait for a button by its text
  const awaitText = async (t: string) => {
    for (let i = 0; i < 50 && !byText(t); i++) await act(async () => {
      await Bun.sleep(10);
    });
    return byText(t);
  };
  // Start and Save fire their fetch without awaiting it: wait for the recorded call to land
  const awaitCall = async (path: string, method = 'POST') => {
    const hit = () => calls.find((c) => c.path === path && c.method === method);
    for (let i = 0; i < 100 && !hit(); i++) await act(async () => {
      await Bun.sleep(10);
    });
    return hit();
  };
  return {
    byText,
    awaitText,
    awaitCall,
    box,
    field,
    type,
    click,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('the Run sheet handlers', () => {
  test('bad JSON stops Start with the reason; it does not start with no args', async () => {
    const view = await openSheet();
    try {
      await view.type(view.box(), '{"question": }');
      await view.click(view.byText('Start'));
      expect(calls.map((c) => c.path)).not.toContain('/api/workflows/runs');
      expect(document.body.textContent).toContain('Args must be JSON');
    } finally {
      await view.unmount();
    }
  });

  test('an empty sheet starts with no args key and saves its preset as null', async () => {
    const view = await openSheet();
    try {
      await view.click(view.byText('Start'));
      const start = await view.awaitCall('/api/workflows/runs');
      expect(start?.body).toEqual({ name: 'triage', device: 'local' });
      await view.type(view.field('weekly triage'), 'bare');
      await view.click(view.byText('Save'));
      const save = await view.awaitCall('/api/workflows/triage/presets');
      expect(save?.body).toEqual({ name: 'bare', args: null });
    } finally {
      await view.unmount();
    }
  });

  test('a null-args preset leaves the JSON box empty, a with-args preset fills it', async () => {
    const view = await openSheet();
    try {
      await view.click((await view.awaitText('no args'))!);
      expect(view.box().value).toBe('');
      await view.click(view.byText('with args'));
      expect(view.box().value).toContain('Caddy?');
    } finally {
      await view.unmount();
    }
  });

  test('a declared-args sheet keeps a More args box: a preset fills it, and what is typed there is sent', async () => {
    calls.length = 0;
    const view = await openSheet({ ...workflow, argsSchema: { base: { type: 'string' } } });
    try {
      // the preset's question is not declared, so it lands in the box
      await view.click((await view.awaitText('with args'))!);
      expect(view.box().value).toContain('Caddy?');
      await view.type(view.box(), '[3]');
      await view.click(view.byText('Start'));
      expect(calls.map((c) => c.path)).not.toContain('/api/workflows/runs');
      expect(document.body.textContent).toContain('More args must be a JSON object');
      await view.type(view.box(), '{"votes": 3}');
      await view.click(view.byText('Start'));
      const start = await view.awaitCall('/api/workflows/runs');
      expect(start?.body).toEqual({ name: 'triage', args: { votes: 3 }, device: 'local' });
    } finally {
      await view.unmount();
    }
  });
});
