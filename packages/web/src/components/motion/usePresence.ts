import { useEffect, useReducer, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

/**
 * Keep a layer mounted for its exit. While `open` is true the layer shows;
 * when it turns false the layer stays `ms` longer with `leaving` set, so it
 * can fade out instead of vanishing. Under reduced motion it unmounts at once.
 *
 *   const { mounted, leaving } = usePresence(open);
 *   if (!mounted) return null;
 *   <div className={leaving ? 'anim-out' : 'anim-rise'} inert={leaving} />
 */
export function usePresence(open: boolean, ms = 120): { mounted: boolean; leaving: boolean } {
  const reduced = useReducedMotion();
  const [held, setHeld] = useState(open);
  useEffect(() => {
    if (open) {
      setHeld(true);
      return;
    }
    if (reduced) {
      setHeld(false);
      return;
    }
    const t = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(t);
  }, [open, ms, reduced]);
  const leaving = !open && held && !reduced;
  return { mounted: open || leaving, leaving };
}

/**
 * The last value seen while `open` was true. A closing layer keeps showing
 * what it showed, so its exit never flashes empty content.
 */
export function useHeld<T>(open: boolean, value: T): T {
  const last = useRef(value);
  if (open) last.current = value;
  return open ? value : last.current;
}

/**
 * A list whose removed items stay `ms` longer, at their old place, marked
 * `leaving`, so they can fade out (toasts, cards that resolve). Under reduced
 * motion removed items go at once.
 */
export function usePresenceList<T>(items: readonly T[], keyOf: (item: T) => string, ms = 120): Array<{ item: T; key: string; leaving: boolean }> {
  const reduced = useReducedMotion();
  const prev = useRef<readonly T[]>(items);
  const gone = useRef(new Map<string, { item: T; index: number; until: number }>());
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const keys = new Set(items.map(keyOf));
  if (prev.current !== items) {
    if (!reduced) {
      prev.current.forEach((item, index) => {
        const key = keyOf(item);
        if (!keys.has(key) && !gone.current.has(key)) gone.current.set(key, { item, index, until: Date.now() + ms });
      });
    }
    prev.current = items;
  }
  for (const key of [...gone.current.keys()]) if (keys.has(key) || reduced) gone.current.delete(key);

  useEffect(() => {
    if (!gone.current.size) return;
    const next = Math.min(...[...gone.current.values()].map((g) => g.until));
    const t = setTimeout(
      () => {
        const now = Date.now();
        for (const [key, g] of gone.current) if (g.until <= now + 4) gone.current.delete(key);
        tick();
      },
      Math.max(0, next - Date.now()),
    );
    return () => clearTimeout(t);
  });

  const out: Array<{ item: T; key: string; leaving: boolean }> = items.map((item) => ({ item, key: keyOf(item), leaving: false }));
  const leavers = [...gone.current.entries()].sort((a, b) => a[1].index - b[1].index);
  for (const [key, g] of leavers) out.splice(Math.min(g.index, out.length), 0, { item: g.item, key, leaving: true });
  return out;
}

/**
 * Which keys arrived after the view first had its data. Entrances play for
 * new items only, never for a transcript or a list that was already there
 * when the view opened. Pass `ready` false while the first load runs, and a
 * `scope` (a session id) that resets it when the view shows something else.
 *
 * Returns the keys present at the first ready render, or null before it.
 * An item is new when the set exists and does not have its key. `keys` may
 * be a function, so long lists are only walked once.
 */
export function useArrivals(keys: readonly string[] | (() => readonly string[]), ready = true, scope?: unknown): ReadonlySet<string> | null {
  const seen = useRef<Set<string> | null>(null);
  const scoped = useRef(scope);
  if (scoped.current !== scope) {
    scoped.current = scope;
    seen.current = null;
  }
  if (ready && !seen.current) seen.current = new Set(typeof keys === 'function' ? keys() : keys);
  return seen.current;
}

/** True when `key` arrived after the first batch (see useArrivals). */
export function arrived(seen: ReadonlySet<string> | null | undefined, key: string): boolean {
  return !!seen && !seen.has(key);
}
