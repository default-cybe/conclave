/**
 * Copy buttons (src/lib/clipboard.ts, useCopy in src/lib/hooks.ts): the
 * async clipboard API, else a hidden textarea and execCommand('copy'), else
 * the desktop app's copy_text. Copied shows only when one of them worked.
 *
 *   bun test packages/web/test/clipboard.test.tsx
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { COPY_FAILED, copyText } from '../src/lib/clipboard';
import { useCopy } from '../src/lib/hooks';
import { setDesktop } from '../src/overlay/desktop';
import { useHub } from '../src/store/store';

const g = globalThis as Record<string, unknown>;
const savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const savedDoc = g.document;

function setClipboard(writeText?: (t: string) => Promise<void>) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', clipboard: writeText ? { writeText } : undefined }, configurable: true, writable: true });
}

afterEach(() => {
  setDesktop(undefined);
  if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav);
  g.document = savedDoc;
});

/** A page whose execCommand('copy') answers `ok`, logging what the textarea fallback does. */
function fakePage(ok: boolean | 'throw') {
  const log: string[] = [];
  const box = { value: '', style: {}, setAttribute: () => undefined, select: () => void log.push('select'), remove: () => void log.push('remove') };
  const sel = { rangeCount: 1, getRangeAt: () => 'r1', removeAllRanges: () => void log.push('clear'), addRange: (r: string) => void log.push(`range ${r}`) };
  g.document = {
    body: { appendChild: (b: typeof box) => void log.push(`append ${b.value}`) },
    activeElement: { focus: () => void log.push('refocus'), closest: () => null },
    getSelection: () => sel,
    createElement: () => box,
    execCommand: (cmd: string) => {
      log.push(`exec ${cmd}`);
      if (ok === 'throw') throw new Error('refused');
      return ok;
    },
  };
  return log;
}

function fakeApp(ok: boolean) {
  const calls: unknown[] = [];
  setDesktop({
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (!ok) throw new Error('no clipboard');
    }) as never,
    listen: async () => () => undefined,
  });
  return calls;
}

describe('copyText', () => {
  test('the clipboard API first: nothing else runs', async () => {
    const got: string[] = [];
    setClipboard(async (t) => void got.push(t));
    const log = fakePage(true);
    const calls = fakeApp(true);
    expect(await copyText('hi')).toBe(true);
    expect(got).toEqual(['hi']);
    expect(log).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('API refused: the textarea copies, focus and selection come back', async () => {
    setClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    const log = fakePage(true);
    expect(await copyText('code')).toBe(true);
    expect(log).toEqual(['append code', 'select', 'exec copy', 'remove', 'refocus', 'clear', 'range r1']);
  });

  test('no API (plain http, WebKitGTK): the textarea copies inside the click, before any await', () => {
    setClipboard(undefined);
    const log = fakePage(true);
    void copyText('x');
    expect(log).toContain('exec copy');
  });

  test('textarea refused too: the desktop app copies', async () => {
    setClipboard(undefined);
    fakePage('throw');
    const calls = fakeApp(true);
    expect(await copyText('deep')).toBe(true);
    expect(calls).toEqual([['copy_text', { text: 'deep' }]]);
  });

  test('everything refused: false', async () => {
    setClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    const log = fakePage(false);
    const calls = fakeApp(false);
    expect(await copyText('a')).toBe(false);
    expect(log).toContain('exec copy');
    expect(calls).toHaveLength(1);
  });

  test('a browser (no desktop app) where nothing copies: false', async () => {
    setClipboard(undefined);
    fakePage(false);
    expect(await copyText('a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useCopy, in a DOM
// ---------------------------------------------------------------------------

describe('useCopy', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dom: any;
  beforeAll(() => {
    const req = createRequire(join(import.meta.dir, '../../core/package.json'));
    dom = req('linkedom').parseHTML('<!doctype html><html><body></body></html>');
    g.window = dom.window;
    g.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete g.window;
    delete g.IS_REACT_ACT_ENVIRONMENT;
  });

  async function mount() {
    g.document = dom.document;
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const h = {} as { copied: boolean; copy: (t: string) => void };
    const Probe = () => {
      const [copied, copy] = useCopy();
      Object.assign(h, { copied, copy });
      return null;
    };
    const root = createRoot(dom.document.createElement('div'));
    await act(async () => root.render(<Probe />));
    return { h, act, unmount: () => act(async () => root.unmount()) };
  }

  test('Copied only after the copy worked', async () => {
    setClipboard(async () => undefined);
    const { h, act, unmount } = await mount();
    expect(h.copied).toBe(false);
    await act(async () => h.copy('ok'));
    expect(h.copied).toBe(true);
    await unmount();
  });

  test('nothing copied: no Copied, a toast says how to copy by hand', async () => {
    setClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    useHub.setState({ toasts: [] });
    const { h, act, unmount } = await mount();
    // linkedom has no execCommand and there is no desktop app: every way fails
    await act(async () => h.copy('no'));
    expect(h.copied).toBe(false);
    expect(useHub.getState().toasts.map((t) => [t.title, t.level])).toEqual([[COPY_FAILED, 'error']]);
    await unmount();
  });
});
