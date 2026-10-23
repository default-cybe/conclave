/**
 * Shared by Home and the Inbox page.
 *
 * The hub removes an approval the moment it is resolved, which would unmount
 * the card before it can say "Allowed once, 14:09". When the owner acted on a
 * card here, we keep it on screen until the card reports back (600ms after
 * the decision, so its "Allowed once" can be read before the card leaves).
 * Resolved items are also logged for 10 minutes so the Inbox can show them
 * in a "Resolved" group (spec 11.3).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ApprovalRequest, QuestionRequest, Session } from '@conclave/core/types';
import { underParent } from '@conclave/core/session/delegated';
import { useNow } from '@/lib/hooks';

/** How long after a click or key press a removal counts as "the owner did this here". */
const TOUCH_MS = 8000;
/** Upper bound for keeping a resolved card. The card itself reports after 600ms. */
const HOLD_MS = 6000;
/** How long resolved items stay in the Inbox. */
const LOG_MS = 10 * 60_000;

export type Decision = 'once' | 'session' | 'always' | 'deny';

export const DECISION_WORDS: Record<Decision, string> = {
  once: 'Allowed once',
  session: 'Allowed for this session',
  always: 'Always allowed',
  deny: 'Denied',
};

type Item = { id: string; createdAt: number };

/**
 * Items plus the ones the owner just resolved here, in createdAt order.
 * Wrap each card with `touch(id)` on pointer and key events, and call
 * `release(id)` when the card is done showing its result.
 */
export function useRetained<T extends Item>(items: T[]) {
  const touched = useRef(new Map<string, number>());
  // released before the hub's removal reached this list (the card reports and removes in one tick): never hold these
  const released = useRef(new Set<string>());
  const [held, setHeld] = useState<Record<string, { item: T; until: number }>>({});
  const [prevItems, setPrevItems] = useState(items);

  // Adjust during render, not in an effect: if the card's item vanished for
  // even one commit, the card would remount and lose its "Allowed once" state.
  if (items !== prevItems) {
    const now = Date.now();
    const ids = new Set(items.map((i) => i.id));
    const gone: Record<string, { item: T; until: number }> = {};
    for (const item of prevItems) {
      if (ids.has(item.id)) continue;
      const t = touched.current.get(item.id);
      if (t && now - t < TOUCH_MS && !released.current.has(item.id)) gone[item.id] = { item, until: now + HOLD_MS };
    }
    setPrevItems(items);
    if (Object.keys(gone).length) setHeld((h) => ({ ...h, ...gone }));
  }

  // drop held items once their time is up
  useEffect(() => {
    const ends = Object.values(held).map((h) => h.until);
    if (!ends.length) return;
    const t = setTimeout(
      () => {
        const now = Date.now();
        setHeld((h) => Object.fromEntries(Object.entries(h).filter(([, v]) => v.until > now)));
      },
      Math.max(50, Math.min(...ends) - Date.now()),
    );
    return () => clearTimeout(t);
  }, [held]);

  const touch = useCallback((id: string) => touched.current.set(id, Date.now()), []);
  const release = useCallback((id: string) => {
    released.current.add(id);
    setHeld((h) => {
      if (!h[id]) return h;
      const next = { ...h };
      delete next[id];
      return next;
    });
  }, []);

  const list = useMemo(() => {
    const live = new Set(items.map((i) => i.id));
    const extra = Object.values(held)
      .map((h) => h.item)
      .filter((i) => !live.has(i.id));
    return [...items, ...extra].sort((a, b) => a.createdAt - b.createdAt);
  }, [items, held]);

  const isHeld = useCallback((id: string) => !!held[id] && !items.some((i) => i.id === id), [held, items]);

  return { list, touch, release, isHeld };
}

// ---------------------------------------------------------------------------
// Resolved log
// ---------------------------------------------------------------------------

export type ResolvedEntry = { kind: 'approval'; id: string; at: number; decision: Decision; approval: ApprovalRequest } | { kind: 'question'; id: string; at: number; question: QuestionRequest };

let log: ResolvedEntry[] = [];
const subs = new Set<() => void>();

export function logResolved(e: ResolvedEntry) {
  if (log.some((x) => x.id === e.id)) return;
  log = [e, ...log].filter((x) => Date.now() - x.at < LOG_MS);
  for (const f of subs) f();
}

/**
 * The Inbox's results on phones: sessions that finished or failed since
 * `since` (the start of today, or the last Clear done), newest first. Chats,
 * subagents and sessions that never ran are not results.
 */
export function finishedSince(sessions: Session[], since: number): Session[] {
  return sessions
    .filter((s) => s.kind !== 'chat' && !underParent(s) && !s.archived && (s.status === 'idle' || s.status === 'error') && s.updatedAt >= since && (s.stats?.messages ?? 0) > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const CLEARED_KEY = 'conclave.inbox.cleared';

/** When Clear done was last pressed on this device, or 0. */
export function readCleared(): number {
  try {
    return Number(localStorage.getItem(CLEARED_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function saveCleared(at: number) {
  try {
    localStorage.setItem(CLEARED_KEY, String(at));
  } catch {
    /* private mode: this page only */
  }
}

/** The Inbox's Clear done on phones: the resolved items go now, not after 10 minutes. */
export function clearResolved() {
  log = [];
  for (const f of subs) f();
}

function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** Items resolved on this device in the last 10 minutes, newest first. */
export function useResolvedLog(): ResolvedEntry[] {
  const all = useSyncExternalStore(
    subscribe,
    () => log,
    () => log,
  );
  const now = useNow(30_000);
  return useMemo(() => all.filter((x) => now - x.at < LOG_MS), [all, now]);
}
