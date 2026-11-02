import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RemotePage } from '../src/features/settings/RemotePage';

const saved: Record<string, unknown> = {};
const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
beforeAll(() => {
  const { parseHTML } = createRequire(join(import.meta.dir, '../../core/package.json'))('linkedom');
  const { window, document } = parseHTML('<html><body></body></html>');
  for (const k of keys) saved[k] = (globalThis as any)[k];
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.assign(globalThis, { window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete (globalThis as any)[k];
    else (globalThis as any)[k] = saved[k];
  }
});

test('remote frames pause hidden, resume immediately at the same sequence, and reset for a new view', async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const root = createRoot(document.createElement('div'));
  const calls: number[] = [];
  const poll = async (after: number) => {
    calls.push(after);
    return { seq: after + 1, width: 1, height: 1, data: '', url: 'https://example.com' };
  };
  const draw = (viewKey: string) => act(async () => root.render(<RemotePage viewKey={viewKey} poll={poll} send={async () => {}} interactive={false} help="Live" />));
  const visibility = (value: string) => act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  try {
    await draw('first');
    expect(calls).toEqual([]);
    await visibility('visible');
    expect(calls).toEqual([0]);
    await visibility('hidden');
    await act(async () => { await Bun.sleep(500); });
    expect(calls).toEqual([0]);
    await visibility('visible');
    expect(calls).toEqual([0, 1]);
    await draw('second');
    expect(calls).toEqual([0, 1, 0]);
  } finally {
    await act(async () => root.unmount());
    await Bun.sleep(500);
  }
});
