/**
 * A picture you attached opens whole (components/ui/ImageViewer.tsx, used by
 * features/conversation/UserMessage.tsx): the thumbnail over your message is a
 * button, and a click shows the picture in a dialog with Download; Escape and
 * Close shut it. Rendered into a DOM like toast-expand.test.tsx.
 *
 *   bun test packages/web/test/attached-image-viewer.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Message, Session } from '@conclave/core/types';

const SRC = 'data:image/png;base64,iVBORw0KGgo=';

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
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  g.window = win;
  g.document = dom.document;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.matchMedia = win.matchMedia;
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.getComputedStyle = () => ({ getPropertyValue: () => '', lineHeight: '' });
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

describe('an attached picture in your message', () => {
  test('a click opens it in a dialog with Download, Escape closes it', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Router } = await import('wouter');
    const { memoryLocation } = await import('wouter/memory-location');
    const { UserMessage } = await import('../src/features/conversation/UserMessage');
    const message = { id: 'm1', seq: 1, role: 'user', createdAt: 1, content: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'text', text: 'look' }] } as unknown as Message;
    const session = { id: 's1', kind: 'chat' } as unknown as Session;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Router hook={memoryLocation({ path: '/' }).hook}><UserMessage message={message} session={session} after={0} /></Router>));
    try {
      const dialog = () => document.body.querySelector('[role="dialog"]');
      expect(dialog()).toBeNull();
      const thumb = host.querySelector('button[aria-label="Open attached image full size"]')!;
      expect(thumb.querySelector('img')!.getAttribute('src')).toBe(SRC);
      await act(async () => void thumb.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true })));
      expect(dialog()).not.toBeNull();
      expect(dialog()!.querySelector('img')!.getAttribute('src')).toBe(SRC);
      const dl = [...dialog()!.querySelectorAll('a')].find((a) => a.textContent === 'Download')!;
      expect(dl.getAttribute('href')).toBe(SRC);
      expect(dl.hasAttribute('download')).toBe(true);
      // linkedom has no KeyboardEvent: a keydown Event that carries the key
      await act(async () => void document.dispatchEvent(Object.assign(new win.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' })));
      await act(async () => void (await Bun.sleep(250)));
      expect(dialog()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe('the media viewer', () => {
  const A = 'data:image/png;base64,QUFB';
  const B = 'data:image/gif;base64,QkJC';
  const key = (k: string) => Object.assign(new win.Event('keydown', { bubbles: true, cancelable: true }), { key: k });

  test('Left and Right move between the pictures of the transcript, Close and the backdrop shut it and focus goes back', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ImageThumb } = await import('../src/components/ui/ImageViewer');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <div role="log">
          <ImageThumb src={A} name="a.png" alt="First" />
          <ImageThumb src={B} name="b.gif" alt="Second" />
        </div>,
      ),
    );
    const dialog = () => document.body.querySelector('[role="dialog"]');
    const shown = () => dialog()!.querySelector('img')!.getAttribute('src');
    const facts = () => dialog()!.querySelector('#media-viewer-facts')!.textContent;
    const click = (el: Element) => act(async () => void el.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true })));
    const press = (k: string) => act(async () => void document.dispatchEvent(key(k)));
    try {
      const first = host.querySelector('button[aria-label="Open first full size"]') as HTMLButtonElement;
      // linkedom keeps no focus: the thumbnail is the focused element, and its focus() is counted
      Object.defineProperty(document, 'activeElement', { configurable: true, get: () => first });
      let focused = 0;
      first.focus = () => void focused++;
      await click(first);
      expect(dialog()!.getAttribute('aria-label')).toBe('a.png');
      expect(shown()).toBe(A);
      expect(facts()).toBe('PNG image, 1 of 2');
      await press('ArrowRight');
      expect(shown()).toBe(B);
      expect(facts()).toBe('GIF image, 2 of 2');
      // the last one stays the last
      await press('ArrowRight');
      expect(shown()).toBe(B);
      await press('ArrowLeft');
      expect(shown()).toBe(A);
      await click(dialog()!.querySelector('[data-close]')!);
      expect(dialog()).toBeNull();
      expect(focused).toBe(1);
      // again, and a click on the backdrop closes it
      await click(first);
      await click(dialog()!.querySelector('[aria-hidden]')!);
      expect(dialog()).toBeNull();
    } finally {
      delete (document as unknown as Record<string, unknown>).activeElement;
      await act(async () => root.unmount());
      host.remove();
    }
  });

  test('what a file opens as', async () => {
    const { mediaKind } = await import('../src/components/ui/ImageViewer');
    expect(mediaKind('image/gif')).toBe('image');
    expect(mediaKind('video/mp4')).toBe('video');
    expect(mediaKind('audio/mpeg')).toBe('audio');
    expect(mediaKind('application/pdf')).toBe('pdf');
    expect(mediaKind('text/html')).toBe('text');
    expect(mediaKind('application/octet-stream', 'main.ts')).toBe('text');
    expect(mediaKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe('other');
    expect(mediaKind('application/zip', 'a.zip')).toBe('other');
  });
});
