/**
 * A question on desktop (components/inbox/QuestionCard.tsx): each option is
 * a full width row with its description as visible text, a click on a row
 * answers, and the last "Other…" row opens the answer field. Options with no
 * description stay compact buttons.
 *
 * Renders into a DOM (linkedom, from core's dependencies) at desktop width.
 *
 *   bun test packages/web/test/question-rows.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionRequest } from '@conclave/core/types';
import { QuestionCard } from '../src/components/inbox/QuestionCard';
import { connectClient } from '../src/lib/api';

const NOW = 1_800_000_000_000;
const ask: QuestionRequest = {
  id: 'q_host',
  sessionId: 's_x',
  createdAt: NOW,
  questions: [
    {
      question: 'Where should it run?',
      options: [
        { label: 'Hub', description: 'Runs next to the hub, shares its disk and restarts with it.' },
        { label: 'Laptop', description: 'Runs only while the laptop is awake.' },
      ],
    },
  ],
};
const plain: QuestionRequest = { ...ask, id: 'q_plain', questions: [{ question: 'Which inbox?', options: [{ label: 'Work' }, { label: 'Home' }] }] };

const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any;
const sent: { url: string; body: string }[] = [];

beforeAll(async () => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  // desktop: no phone media query matches
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
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // the client keeps the fetch it was made with: every answer lands in `sent`
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? '') });
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
  } finally {
    globalThis.fetch = real;
  }
});

afterAll(async () => {
  await Bun.sleep(50);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

async function mount(node: React.ReactNode) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, act, unmount: () => act(async () => root.unmount()) };
}

const click = (el: Element) => el.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
const rowOf = (host: Element, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!;

describe('a question on desktop', () => {
  test('each description shows as text under its label, not only as a tooltip', () => {
    const out = renderToStaticMarkup(<QuestionCard question={ask} inSession />);
    expect(out).toContain('>Runs next to the hub, shares its disk and restarts with it.</span>');
    expect(out).toContain('>Runs only while the laptop is awake.</span>');
    expect(out).not.toContain('title="Runs');
    // a row per option and the quiet Other row
    expect(out.match(/<button type="button"/g)).toHaveLength(3);
    expect(out).toContain('>Other…</button>');
  });

  test('a click on a row answers with its label', async () => {
    sent.length = 0;
    const view = await mount(<QuestionCard question={ask} inSession />);
    await view.act(async () => {
      click(rowOf(view.host, 'Laptop'));
      await Bun.sleep(20);
    });
    const answer = sent.find((s) => s.url.includes('q_host'));
    expect(answer).toBeDefined();
    expect(JSON.parse(answer!.body)).toEqual({ answers: { 'Where should it run?': 'Laptop' } });
    await view.unmount();
  });

  test('"Other…" opens the answer field', async () => {
    const view = await mount(<QuestionCard question={ask} inSession />);
    expect(view.host.querySelector('input[aria-label="Your answer"]')).toBeNull();
    await view.act(async () => click(rowOf(view.host, 'Other…')));
    expect(view.host.querySelector('input[aria-label="Your answer"]')).not.toBeNull();
    // the row goes while the field is open
    expect(rowOf(view.host, 'Other…')).toBeUndefined();
    await view.unmount();
  });

  test('options with no description stay compact buttons in one line', () => {
    const out = renderToStaticMarkup(<QuestionCard question={plain} inSession />);
    expect(out).toContain('flex flex-wrap gap-1.5');
    expect(out).toContain('>Other…</button>');
    expect(out).not.toContain('max-w-[664px]');
  });
});
