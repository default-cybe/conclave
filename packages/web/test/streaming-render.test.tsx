/**
 * Streaming renders (src/features/chat/Markdown.tsx, src/features/conversation/ChatMarkdown.tsx):
 * while a reply streams, the markdown is re-parsed at most every ~45ms instead
 * of once per delta, and the final text renders the moment streaming ends; a
 * code block whose fence has not closed yet renders as plain text, because
 * highlighting it would be thrown away by the next delta.
 *
 *   bun test packages/web/test/streaming-render.test.tsx
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as markdown from 'react-markdown';
import { Markdown } from '../src/features/chat/Markdown';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMarkdown } from '../src/features/conversation/ChatMarkdown';

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
let win: unknown;

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

const OPEN = 'Here is a function:\n\n```ts\nconst x = 1;';
const CLOSED = 'Here is a function:\n\n```ts\nconst x = 1;\n```';

describe('a streamed reply', () => {
  for (const [name, Component] of [['Markdown', Markdown], ['ChatMarkdown', ChatMarkdown]] as const) {
    test(`${name}: unchanged throttled text does not re-parse`, async () => {
      const { act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const host = document.createElement('div');
      const root = createRoot(host);
      const parse = spyOn(markdown, 'default');
      let tick = () => {};
      const timer = spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void, ms: number) => {
        expect(ms).toBe(45);
        tick = callback;
        return 0;
      });
      try {
        await act(async () => root.render(<Component text="alpha" streaming />));
        const initial = parse.mock.calls.length;
        expect(initial).toBeGreaterThan(0);
        await act(async () => root.render(<Component text="alpha beta" streaming />));
        expect(parse.mock.calls.length).toBe(initial);
        await act(async () => tick());
        expect(host.textContent).toContain('alpha beta');
        expect(parse.mock.calls.length).toBe(initial + 1);
        await act(async () => root.render(<Component text="alpha beta FINAL" streaming={false} />));
        expect(host.textContent).toContain('FINAL');
        expect(parse.mock.calls.length).toBe(initial + 2);
      } finally {
        await act(async () => root.unmount());
        parse.mockRestore();
        timer.mockRestore();
      }
    });

    test(`${name}: only a matching closed fence is highlighted`, () => {
      for (const text of [OPEN, '```ts', '````ts\nconst x = 1;\n```', '```ts\nconst x = 1;\n~~~']) {
        expect(renderToStaticMarkup(<Component text={text} streaming />)).not.toContain('class="hljs"');
      }
      for (const text of [CLOSED, '~~~ts\nconst x = 1;\n~~~', '```ts\nconst x = 1;\n````']) {
        expect(renderToStaticMarkup(<Component text={text} streaming />)).toContain('class="hljs"');
      }
    });

    test(`${name}: final text highlights even when its fence never closes`, () => {
      // truncated reports (RunView cuts at 1200 chars) and fences in a blockquote never end on a bare fence line
      for (const text of [`${OPEN}…`, '> ```ts\n> const x = 1;\n> ```']) {
        expect(renderToStaticMarkup(<Component text={text} />)).toContain('class="hljs"');
        expect(renderToStaticMarkup(<Component text={text} streaming />)).not.toContain('class="hljs"');
      }
    });
  }

  test('an open code fence is plain text, a closed one is highlighted', () => {
    const open = renderToStaticMarkup(<ChatMarkdown text={OPEN} streaming />);
    expect(open).not.toContain('class="hljs"');
    expect(open).toContain('const x = 1;');
    const closed = renderToStaticMarkup(<ChatMarkdown text={CLOSED} streaming={false} />);
    expect(closed).toContain('class="hljs"');
  });

  test('the final text renders at once when streaming ends', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Markdown } = await import('../src/features/chat/Markdown');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const draw = (text: string, streaming: boolean) => act(async () => root.render(<Markdown text={text} streaming={streaming} />));
    try {
      await draw('alpha', true);
      expect(host.textContent).toContain('alpha');
      // a delta mid-stream: parsed at most every 45ms, so it is not on screen yet
      await draw('alpha beta gamma THE-END', true);
      expect(host.textContent).not.toContain('THE-END');
      // streaming ends: the full text renders immediately, no wait for a timer
      await draw('alpha beta gamma THE-END', false);
      expect(host.textContent).toContain('THE-END');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
