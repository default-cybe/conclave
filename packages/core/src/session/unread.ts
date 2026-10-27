/**
 * Unread conversations: the hub stamps `meta.doneAt` when a turn stops
 * running (a reply, a finished turn, a subagent result, a question or an
 * approval for the owner), and `meta.seenAt` when the owner opens it
 * (POST /api/sessions/:id/seen). A session is unread when it finished after
 * it was last seen. Kept on the hub so the web app and the phone agree;
 * sessions from before this have no doneAt and read as seen.
 *
 * Pure, so the hub, the web app and the tests share it.
 */
import type { Session } from '../types';

export function isUnread(s: Pick<Session, 'meta'>): boolean {
  const done = s.meta?.doneAt;
  if (typeof done !== 'number') return false;
  const seen = s.meta?.seenAt;
  return typeof seen !== 'number' || done > seen;
}
