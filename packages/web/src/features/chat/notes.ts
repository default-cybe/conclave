/**
 * Notes: the account's to-do strip at the top of every Chat and Code
 * conversation (NotesStrip.tsx). They are tasks with the "note" label, so the
 * Tasks page and the phone app see the same list; the hub keeps them per
 * account like any task. Their order is meta.noteOrder. A note checked off
 * stays in the strip for a day, then only the Tasks page shows it.
 */
import type { Task } from '@conclave/core/types';

export const NOTE_LABEL = 'note';
const DAY = 86_400_000;

export const isNote = (t: Task) => t.labels.includes(NOTE_LABEL);

const orderOf = (t: Task) => (typeof t.meta?.noteOrder === 'number' ? t.meta.noteOrder : t.createdAt);

/** The strip's notes: open ones in their order, then the ones checked off in the last day. */
export function stripNotes(tasks: Iterable<Task>, now: number): Task[] {
  const notes = [...tasks].filter(isNote);
  const open = notes.filter((t) => t.status !== 'done').sort((a, b) => orderOf(a) - orderOf(b));
  const done = notes.filter((t) => t.status === 'done' && now - t.updatedAt < DAY).sort((a, b) => b.updatedAt - a.updatedAt);
  return [...open, ...done];
}

/** The collapsed line: "3 to do: Call the bank", or "All done" once every note is checked off. */
export function stripLine(notes: Task[]): { count: string; first?: string } {
  const open = notes.filter((t) => t.status !== 'done');
  return open.length ? { count: `${open.length} to do:`, first: open[0].title } : { count: 'All done' };
}

/** The noteOrder for a note dropped before `before` (or at the end): halfway between its neighbours. */
export function orderAt(open: Task[], before: number): number {
  const prev = open[before - 1];
  const next = open[before];
  if (!prev && !next) return Date.now();
  if (!next) return orderOf(prev) + 1000;
  if (!prev) return orderOf(next) - 1000;
  return (orderOf(prev) + orderOf(next)) / 2;
}

/** The order for a new note: after the last open one. */
export const nextOrder = (open: Task[]) => orderAt(open, open.length);
