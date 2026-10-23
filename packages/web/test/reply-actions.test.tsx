/**
 * Replies and the composer on a phone (docs/design/CHAT-AND-MOTION.md 2.5,
 * 2.6 and 2.8): a long press selects text and opens nothing; every finished
 * reply ends with Copy, Retry and "..." in view (quieter under earlier
 * ones), with a slot for one more action; your own message opens its
 * actions on a tap. Attachments sit in one row that scrolls sideways at a
 * fixed height, 15 at most, and the pickers take zips.
 *
 * The phone cases render into a DOM (linkedom, from core's dependencies)
 * with the phone's media queries on, and press like a finger does.
 *
 *   bun test packages/web/test/reply-actions.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Session } from '@conclave/core/types';
import { ACCEPT_FILES, MAX_ATTACHMENTS, TOO_MANY_FILES } from '@conclave/core/attachments/limits';
import { ReplyIcons } from '../src/features/conversation/ReplyIcons';
import { AttachmentStrip } from '../src/features/conversation/ComposerParts';
import { PhoneBox, PHONE_FIELD } from '../src/features/conversation/PhoneBox';

const NOW = 1_800_000_000_000;
const session: Session = {
  id: 'c1',
  title: 'Caddy',
  kind: 'chat',
  agent: 'chat',
  model: 'anthropic/claude-sonnet-5-5',
  mode: 'agent',
  permissionMode: 'default',
  cwd: '~',
  device: 'local',
  status: 'idle',
  tags: [],
  pinned: false,
  archived: false,
  chat: { webSearch: true, memory: true },
  createdAt: NOW - 60_000,
  updatedAt: NOW,
  stats: { messages: 4, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
} as Session;

const msg = (id: string, seq: number, role: Message['role'], text: string): Message => ({ id, sessionId: 'c1', seq, role, kind: 'normal', content: [{ type: 'text', text }], createdAt: NOW - 50_000 + seq, ...(role === 'assistant' ? { stopReason: 'end_turn', model: session.model } : {}) }) as Message;

describe('the action row', () => {
  test('Copy, Retry, the extra slot and More, fg-3 under the last reply and quieter under earlier ones', () => {
    const last = renderToStaticMarkup(<ReplyIcons text="An answer" onRetry={() => {}} onMore={() => {}} moreOpen={false} extra={<button type="button">Try the next model</button>} />);
    const labels = [...last.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(['Copy', 'Retry', 'More actions']);
    // the slot sits after Retry and before More
    expect(last.indexOf('Try the next model')).toBeGreaterThan(last.indexOf('aria-label="Retry"'));
    expect(last.indexOf('Try the next model')).toBeLessThan(last.indexOf('aria-label="More actions"'));
    expect(last).toContain('text-fg-3');
    expect(last).not.toContain('text-fg-4');
    const earlier = renderToStaticMarkup(<ReplyIcons text="An answer" onMore={() => {}} moreOpen={false} quiet />);
    expect(earlier).toContain('text-fg-4');
    expect(earlier).not.toContain('aria-label="Retry"');
    // nothing to copy: no Copy
    expect(renderToStaticMarkup(<ReplyIcons text="  " onMore={() => {}} moreOpen={false} />)).not.toContain('aria-label="Copy"');
  });

  test('no message view listens for a long press any more', () => {
    const src = (p: string) => readFileSync(join(import.meta.dir, '../src', p), 'utf8');
    for (const p of ['features/conversation/Reply.tsx', 'features/conversation/UserMessage.tsx', 'features/chat/PhoneTranscript.tsx', 'features/conversation/ReplyIcons.tsx']) {
      expect(src(p)).not.toContain('useLongPress');
      expect(src(p)).not.toContain('onContextMenu');
    }
  });
});

describe('the composer', () => {
  const files = Array.from({ length: 10 }, (_, i) => (i % 3 === 0 ? { name: `shot-${i}.png`, size: 20_000, mediaType: 'image/png', preview: 'data:image/png;base64,AAAA' } : { name: `notes-${i}.md`, size: 1_200, mediaType: 'text/markdown' }));

  test('ten files are one row that scrolls sideways at a fixed height, above the field', () => {
    const html = renderToStaticMarkup(
      <PhoneBox rim="idle" attachments={<AttachmentStrip phone files={[...files, { name: 'src.zip', size: 90_000, mediaType: 'application/zip' }]} onRemove={() => {}} />} field={<textarea data-composer className={PHONE_FIELD} />} add={null} send={null} />,
    );
    const ul = /<ul[^>]*aria-label="Attachments"[^>]*>/.exec(html)![0];
    for (const cls of ['flex-nowrap', 'overflow-x-auto', 'overflow-y-hidden', 'h-[60px]']) expect(ul).toContain(cls);
    expect(ul).not.toContain('flex-col');
    expect((html.match(/<li /g) ?? []).length).toBe(11);
    expect((html.match(/aria-label="Remove /g) ?? []).length).toBe(11);
    // the row comes before the field, and the field is still there
    expect(html.indexOf('aria-label="Attachments"')).toBeLessThan(html.indexOf('data-composer'));
    expect(html).toContain('src.zip');
    const desk = renderToStaticMarkup(<AttachmentStrip files={files} onRemove={() => {}} />);
    expect(desk).toContain('h-[52px]');
  });

  test('the pickers take zips, and the cap is 15 with its line', () => {
    expect(ACCEPT_FILES.split(',')).toEqual(expect.arrayContaining(['.zip', 'application/zip', 'application/x-zip-compressed', 'image/*', 'application/pdf']));
    const src = (p: string) => readFileSync(join(import.meta.dir, '../src', p), 'utf8');
    expect(src('features/conversation/ChatComposer.tsx')).toContain('const ACCEPT = ACCEPT_FILES;');
    expect(src('features/chat/Composer.tsx')).toContain('const ACCEPT = ACCEPT_FILES;');
    expect(MAX_ATTACHMENTS).toBe(15);
    expect(TOO_MANY_FILES).toBe('Up to 15 files per message. Zip the rest.');
  });
});

// ---------------------------------------------------------------------------
// On a phone, in a DOM
// ---------------------------------------------------------------------------

const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver'];
/** Observers that watch nothing: the DOM here has no layout. */
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
  const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  const store = new Map<string, string>();
  win.matchMedia = (q: string) => ({ matches: q.includes('max-width: 767px') || q.includes('pointer: coarse'), media: q, addEventListener() {}, removeEventListener() {} });
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
  // what React and the sheets scheduled runs out first, while there is still a window
  await Bun.sleep(400);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

/** A finger on `el`: down, held `ms`, up, as a touch pointer. */
async function press(el: Element, ms: number) {
  const fire = (type: string) => {
    const e = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerType: 'touch', clientX: 10, clientY: 10, button: 0, isPrimary: true, pointerId: 1 });
    el.dispatchEvent(e);
  };
  fire('pointerdown');
  await Bun.sleep(ms);
  fire('pointerup');
}

async function mount(node: React.ReactNode) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Router hook={memoryLocation({ path: '/chat/c1' }).hook}>{node}</Router>));
  return {
    host,
    act,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const menuOpen = () => !!document.querySelector('[role="menu"]') || !!document.querySelector('[role="dialog"]');

describe('a reply on a phone', () => {
  test('a long press opens no menu; the row under it does', async () => {
    const { Reply } = await import('../src/features/conversation/Reply');
    const user1 = msg('u1', 1, 'user', 'First question');
    const r1 = msg('a1', 2, 'assistant', 'The first answer, to select part of.');
    const user2 = msg('u2', 3, 'user', 'Second question');
    const r2 = msg('a2', 4, 'assistant', 'The second answer.');
    const common = { session, live: false, phase: 'between' as const, startedAt: 0, streaming: {}, tools: {}, results: {}, after: 0 };
    const view = await mount(
      <>
        <Reply {...common} reply={{ kind: 'reply', key: 'a1', messages: [r1], user: user1 }} isLast={false} after={1} />
        <Reply {...common} reply={{ kind: 'reply', key: 'a2', messages: [r2], user: user2 }} isLast extraAction={<button type="button">Try the next model</button>} />
      </>,
    );
    try {
      // both replies end with the row, always there; the earlier one quieter
      const rows = view.host.querySelectorAll('[data-reply-actions]');
      expect(rows.length).toBe(2);
      expect(rows[0].innerHTML).toContain('text-fg-4');
      expect(rows[1].innerHTML).toContain('text-fg-3');
      expect(rows[1].textContent).toContain('Try the next model');
      expect(rows[0].textContent).not.toContain('Try the next model');

      // a long press on the text: nothing opens, so the phone selects the text
      const para = [...view.host.querySelectorAll('p')].find((p) => p.textContent?.includes('first answer'))!;
      expect(para).toBeDefined();
      await view.act(async () => press(para, 700));
      expect(menuOpen()).toBe(false);

      // "..." opens the rest
      const more = rows[0].querySelector('[aria-label="More actions"]') as HTMLElement;
      await view.act(async () => {
        more.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
      });
      expect(menuOpen()).toBe(true);
      expect(document.body.textContent).toContain('Ask another model');
      expect(document.body.textContent).toContain('Branch');
      expect(document.body.textContent).toContain('Continue as a session');
      expect(document.body.textContent).toContain('Send to friend');
    } finally {
      await view.unmount();
    }
  });

  test('your message: a long press opens nothing, a tap opens Copy and Edit', async () => {
    const { UserMessage } = await import('../src/features/conversation/UserMessage');
    const view = await mount(<UserMessage message={msg('u9', 9, 'user', 'Select part of this, please')} session={session} after={0} />);
    try {
      const bubble = [...view.host.querySelectorAll('div')].find((d) => d.textContent === 'Select part of this, please' && d.className.includes('rounded'))!;
      expect(bubble).toBeDefined();
      await view.act(async () => press(bubble, 700));
      expect(menuOpen()).toBe(false);
      await view.act(async () => {
        bubble.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
      });
      expect(menuOpen()).toBe(true);
      expect(document.body.textContent).toContain('Edit');
    } finally {
      await view.unmount();
    }
  });
});
