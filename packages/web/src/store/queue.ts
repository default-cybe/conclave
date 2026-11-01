/**
 * Messages you sent while a session works, before they join the transcript
 * (docs/design/CHAT-AND-MOTION.md 2.11). The hub lists them (GET
 * /api/sessions/:id/queue and the session.queue event); this app also
 * holds the ones it sent itself until the hub's list has them, so a message
 * shows the moment you send it. The user message that takes one's place
 * carries its id in meta.pendingIds.
 *
 * Pure, so the rules are tested (test/session-queue.test.ts); store.ts keeps
 * the state.
 */
import type { Message, QueuedMessage } from '@conclave/core/types';

/** A message this app sent that the hub's list does not show yet. confirmedAt: when the hub answered that it waits. */
export type Sending = QueuedMessage & { confirmedAt?: number };

/** What waits, as a session shows it: the hub's list in its order, then what this app sent that the hub has not listed yet. */
export function shownQueue(hub: readonly QueuedMessage[] | undefined, sending: readonly Sending[] | undefined): QueuedMessage[] {
  const list = hub ?? [];
  if (!sending?.length) return list as QueuedMessage[];
  const listed = new Set(list.map((q) => q.id));
  const mine = sending.filter((s) => !listed.has(s.id)).map(({ confirmedAt: _c, ...q }) => q);
  return mine.length ? [...list, ...mine] : (list as QueuedMessage[]);
}

/** The waiting messages a user message took the place of. */
export function pendingIdsOf(m: Pick<Message, 'role' | 'meta'>): string[] {
  const ids = m.role === 'user' ? m.meta?.pendingIds : undefined;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/** The message joined the transcript in place of a waiting one: no rise, it is already on screen. */
export function replacesPending(m: Pick<Message, 'role' | 'meta'>): boolean {
  return pendingIdsOf(m).length > 0;
}

/** `list` without the ids, the same array when none of them is in it. */
export function withoutIds<T extends { id: string }>(list: T[] | undefined, ids: Iterable<string>): T[] | undefined {
  if (!list?.length) return list;
  const drop = new Set(ids);
  const next = list.filter((q) => !drop.has(q.id));
  return next.length === list.length ? list : next;
}

/**
 * After the hub's list arrives: what it shows is the hub's now. An event can
 * come before the hub had a send that is still on its way, so the rest
 * stays. A full load (GET) asked after the hub answered a send is the whole
 * truth: one of those it does not list is gone (it ran, or a Stop dropped it).
 */
export function afterHubList(sending: Sending[] | undefined, hub: readonly QueuedMessage[], loadedFrom?: number): Sending[] | undefined {
  if (!sending?.length) return sending;
  const listed = new Set(hub.map((q) => q.id));
  const next = sending.filter((s) => !listed.has(s.id) && !(loadedFrom !== undefined && s.confirmedAt !== undefined && s.confirmedAt <= loadedFrom));
  return next.length === sending.length ? sending : next;
}

/** An id for a message this app sends while the session works (the hub keeps it: SendInput.pendingId). */
export function newPendingId(): string {
  const rand = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `w_${Date.now().toString(36)}${rand}`;
}
