/**
 * The notes strip at the top of Chat and Code (src/features/chat/NotesStrip.tsx,
 * notes.ts): hidden with no notes, one line with the first open note, checked
 * notes fall to the end and leave after a day, and a dropped note lands
 * between its neighbours.
 *
 *   bun test packages/web/test/notes-strip.test.tsx
 */
import { describe, expect, test } from 'bun:test';
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
