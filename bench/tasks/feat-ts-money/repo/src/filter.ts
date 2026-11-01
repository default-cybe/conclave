import { monthRange } from './dates';
import type { Entry } from './entry';

export interface EntryFilter {
  /** "YYYY-MM" */
  month?: string;
  category?: string;
  /** Case-insensitive substring of the description. */
  text?: string;
  minCents?: number;
  maxCents?: number;
}

export function inMonth(entry: Entry, month: string): boolean {
  const { start, end } = monthRange(month);
  return entry.date >= start && entry.date < end;
}

export function filterEntries(entries: Entry[], f: EntryFilter): Entry[] {
  const text = f.text?.toLowerCase();
  return entries.filter((e) => {
    if (f.month && !inMonth(e, f.month)) return false;
    if (f.category && e.category !== f.category) return false;
    if (text && !e.description.toLowerCase().includes(text)) return false;
    if (f.minCents !== undefined && e.amountCents < f.minCents) return false;
    if (f.maxCents !== undefined && e.amountCents > f.maxCents) return false;
    return true;
  });
}

/** Entries sorted by date, then by description, without changing the input. */
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => a.date.getTime() - b.date.getTime() || a.description.localeCompare(b.description));
}
