/**
 * The notes strip at the top of Chat and Code (src/features/chat/NotesStrip.tsx,
 * notes.ts): hidden with no notes, one line with the first open note, checked
 * notes fall to the end and leave after a day, and a dropped note lands
 * between its neighbours.
 *
 *   bun test packages/web/test/notes-strip.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Task } from '@conclave/core/types';
import { NotesView } from '../src/features/chat/NotesStrip';
import { orderAt, stripLine, stripNotes } from '../src/features/chat/notes';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const task = (id: string, m: Partial<Task> = {}): Task => ({ id, title: id, description: '', status: 'todo', priority: 1, labels: ['note'], createdAt: NOW - HOUR, updatedAt: NOW - HOUR, ...m });

describe('notes strip', () => {
  test('hidden when there are no notes, even with other tasks', () => {
    const notes = stripNotes([task('t1', { labels: [] }), task('t2', { labels: ['work'] })], NOW);
    expect(notes).toEqual([]);
    expect(renderToStaticMarkup(<NotesView notes={notes} state="closed" />)).toBe('');
    // Add a note opens it before the first one exists
    expect(renderToStaticMarkup(<NotesView notes={notes} state="add" />)).toContain('Add a note');
  });

  test('one line with the count and the first open note, in their order', () => {
    const notes = stripNotes([task('Call the bank', { meta: { noteOrder: 2 } }), task('Renew passport', { meta: { noteOrder: 1 } }), task('Book flights', { meta: { noteOrder: 3 } })], NOW);
    expect(notes.map((n) => n.title)).toEqual(['Renew passport', 'Call the bank', 'Book flights']);
    const html = renderToStaticMarkup(<NotesView notes={notes} state="closed" />);
    expect(html).toContain('3 to do:');
    expect(html).toContain('Renew passport');
    expect(html).toContain('aria-expanded="false"');
    // closed: no checklist
    expect(html).not.toContain('Call the bank');
    const open = renderToStaticMarkup(<NotesView notes={notes} state="open" />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('Call the bank');
    expect(open).toContain('Add a note');
  });

  test('a checked note leaves the count, stays a day, then goes', () => {
    const fresh = task('Pay rent', { status: 'done', updatedAt: NOW - HOUR });
    const old = task('Old one', { status: 'done', updatedAt: NOW - 25 * HOUR });
    const notes = stripNotes([fresh, old, task('Call the bank')], NOW);
    expect(notes.map((n) => n.title)).toEqual(['Call the bank', 'Pay rent']);
    expect(stripLine(notes)).toEqual({ count: '1 to do:', first: 'Call the bank' });
    expect(stripLine([fresh])).toEqual({ count: 'All done' });
    const open = renderToStaticMarkup(<NotesView notes={notes} state="open" />);
    expect(open).toContain('checked=""');
    expect(open).toContain('line-through');
  });

  test('a dropped note takes a place between its neighbours', () => {
    const open = [task('a', { meta: { noteOrder: 10 } }), task('b', { meta: { noteOrder: 20 } })];
    expect(orderAt(open, 1)).toBe(15);
    expect(orderAt(open, 0)).toBeLessThan(10);
    expect(orderAt(open, 2)).toBeGreaterThan(20);
  });
});

// the add box on linkedom: while a note saves it keeps the focus (a disabled field drops it to the page,
// so the next note's typing and Escape went nowhere)
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT', 'matchMedia', 'localStorage'];
const saved: Record<string, unknown> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any;
beforeAll(() => {
  const { parseHTML } = createRequire(join(import.meta.dir, '../../core/package.json'))('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  win = dom.window;
  // a browser has an input event; linkedom's document lacks the property React looks for
  dom.document.oninput = null;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  const store = new Map<string, string>();
  Object.assign(g, {
    window: win,
    document: dom.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  });
});
afterAll(async () => {
  await Bun.sleep(20);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) (saved[k] === undefined ? delete g[k] : (g[k] = saved[k]));
});

describe('adding a note', () => {
  test('the add box stays enabled while the note saves, then clears', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { connectClient, api } = await import('../src/lib/api');
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    let done!: (t: Task) => void;
    Object.assign(api(), { createTask: () => new Promise<Task>((r) => (done = r)) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<NotesView notes={[]} state="add" />));
    const input = host.querySelector('input[aria-label="Add a note"]') as HTMLInputElement;
    // linkedom gives a field with no type null; React then follows no typing
    Object.defineProperty(input, 'type', { configurable: true, get: () => input.getAttribute('type') ?? 'text' });
    // where react-dom was loaded under another test's linkedom it follows typing from the focused field
    Object.assign(input, { attachEvent() {}, detachEvent() {} });
    await act(async () => {
      input.dispatchEvent(new win.Event('focusin', { bubbles: true }));
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, 'Renew the passport');
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.dispatchEvent(new win.Event('keyup', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(input.hasAttribute('disabled')).toBe(false);
    await act(async () => done(task('n1', { title: 'Renew the passport' })));
    expect(input.value).toBe('');
    await act(async () => root.unmount());
  });
});
