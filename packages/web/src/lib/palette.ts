/**
 * The command palette's ranking (components/CommandPalette.tsx): words match
 * in any order ("theme dark" finds "Switch to dark theme"), and the commands
 * used lately on this device come first. Kept in local storage: it is how
 * this keyboard works, not hub state.
 */
import { fuzzy } from './text';

const KEY = 'conclave.palette.recent';
export const RECENT_MAX = 8;

/** Each word of the query fuzzy-matches somewhere; a whole-phrase match still wins. -1 for no match. */
export function fuzzyWords(query: string, target: string): number {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const whole = fuzzy(query, target);
  if (words.length < 2) return whole;
  let sum = 0;
  for (const w of words) {
    const s = fuzzy(w, target);
    if (s < 0) return whole;
    sum += s;
  }
  return Math.max(whole, sum / words.length);
}

/** The id at the front, once, at most RECENT_MAX. */
export function pushRecent(list: string[], id: string, max = RECENT_MAX): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberCommand(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pushRecent(loadRecent(), id)));
  } catch {
    /* private mode: no memory of it */
  }
}

/** Matches best first; a command used lately gets a lift that never beats a plain word match over a loose one. */
export function rankItems<T>(items: T[], query: string, text: (t: T) => string, key: (t: T) => string, recent: string[]): T[] {
  if (!query.trim()) return items;
  return items
    .map((it) => {
      const s = fuzzyWords(query, text(it));
      const r = recent.indexOf(key(it));
      return { it, s: s < 0 ? s : s + (r >= 0 ? (RECENT_MAX - r) * 40 : 0) };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}
