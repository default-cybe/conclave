/**
 * Incognito sits at the top right of a new chat (features/conversation/
 * incognito.tsx IncognitoToggle), not in "+": turning it on reaches the
 * create call with incognito and memorySave false, the memory picked beside
 * it changes what goes, the toggle is gone while the first message is on its
 * way, and incognito is not kept for the next chat. A failed send keeps it.
 *
 *   cd packages/web && bun test test/incognito-toggle.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { CreateSessionInput } from '@conclave/core/client';
import { api, connectClient } from '../src/lib/api';
import { firstSend, memoryItems, useIncognito } from '../src/features/conversation/incognito';

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

beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  const store = new Map<string, string>();
  // a desktop: no phone, no touch
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  // startChat reads where the page is
  win.location = { pathname: '/chat', search: '', hash: '' };
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
});

afterAll(async () => {
  await Bun.sleep(300);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

async function mountNewChat() {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { ChatComposer, SEND_EVENT } = await import('../src/features/conversation/ChatComposer');
  const { IncognitoToggle } = await import('../src/features/conversation/incognito');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <Router hook={memoryLocation({ path: '/chat' }).hook}>
        <IncognitoToggle code={false} />
        <ChatComposer chatId="new" />
      </Router>,
    ),
  );
  const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-label="Incognito"]');
  const type = async (text: string) => {
    const box = host.querySelector<HTMLTextAreaElement>('[data-composer]')!;
    // stand-ins for the IE calls React falls back to under linkedom (meetings-panel-fixes.test.tsx)
    Object.assign(box, { attachEvent() {}, detachEvent() {} });
    await act(async () => box.dispatchEvent(new win.Event('focusin', { bubbles: true })));
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')!.set!.call(box, text);
      box.dispatchEvent(new win.Event('input', { bubbles: true }));
      box.dispatchEvent(new win.Event('keyup', { bubbles: true }));
    });
  };
  const send = () => window.dispatchEvent(new win.Event(SEND_EVENT));
  return { act, host, toggle, type, send, unmount: async () => (await act(async () => root.unmount()), host.remove()) };
}

describe('incognito at the top right of a new chat', () => {
  test('on: the create call carries incognito and memorySave false; the toggle is gone while it goes; the next chat is not incognito', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    const made: CreateSessionInput[] = [];
    let release!: () => void;
    Object.assign(api(), {
      createSession: (input: CreateSessionInput) => {
        made.push(input);
        return new Promise((r) => (release = () => r({ id: 'ses_inc', kind: 'chat', title: 'New chat', incognito: true, updatedAt: 1, stats: {} })));
      },
    });
    const v = await mountNewChat();
    expect(v.toggle()?.getAttribute('aria-pressed')).toBe('false');
    await v.act(async () => v.toggle()!.click());
    expect(v.toggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(useIncognito.getState()).toMatchObject({ incognito: true, memory: 'use' });
    // the note sits under the toggle, not under the box
    expect(v.host.textContent).toContain('Incognito. Not kept');
    await v.type('A private question');
    await v.act(async () => v.send());
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: 'chat', incognito: true, prompt: 'A private question', chat: { memory: true, memorySave: false } });
    // mid-start: incognito can no longer change
    expect(v.toggle()).toBeNull();
    await v.act(async () => (release(), Bun.sleep(10)));
    expect(useIncognito.getState()).toMatchObject({ incognito: false, sending: false });
    await v.unmount();
  });

  test('the memory picked beside it goes; off sends memory false; a failed send keeps incognito for the retry', async () => {
    const made: CreateSessionInput[] = [];
    Object.assign(api(), { createSession: async (input: CreateSessionInput) => (made.push(input), Promise.reject(new Error('The hub is busy.'))) });
    const v = await mountNewChat();
    await v.act(async () => v.toggle()!.click());
    await v.act(async () => useIncognito.setState({ memory: 'off' }));
    await v.type('Try this');
    await v.act(async () => (v.send(), Bun.sleep(10)));
    expect(made[0]).toMatchObject({ incognito: true, chat: { memory: false } });
    expect(made[0].chat).not.toHaveProperty('memorySave');
    expect(useIncognito.getState()).toMatchObject({ incognito: true, memory: 'off', sending: false });
    expect(v.toggle()?.getAttribute('aria-pressed')).toBe('true');
    await v.act(async () => firstSend(true));
    await v.unmount();
  });

  test('"+" has no Incognito row; its memory rows are for a chat that is not incognito', () => {
    const rows = memoryItems('save', () => {});
    expect(rows.map((r) => r.label)).toEqual(['Memory', 'Use and save', 'Use only', 'Off']);
    expect(rows.some((r) => r.label === 'Incognito')).toBe(false);
  });
});
