/**
 * Sessions side by side (/sessions/split): which sessions, left to right.
 * The list is the account's (GET and PATCH /api/me, preferences.splitView),
 * so each person on the hub keeps their own and it follows them between
 * computers. Every column reads the same store and the one live socket.
 */
import { useMemo } from 'react';
import type { Session } from '@conclave/core/types';
import { SPLIT_MAX } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { isChat } from './util';

export { SPLIT_MAX };

/** id added at the right; already there, it moves to the right. More than SPLIT_MAX drops the leftmost. */
export function addToSplit(ids: readonly string[], id: string): string[] {
  return [...ids.filter((x) => x !== id), id].slice(-SPLIT_MAX);
}

export function removeFromSplit(ids: readonly string[], id: string): string[] {
  return ids.filter((x) => x !== id);
}

/** The saved ids that are still sessions here (a deleted one, or a chat, leaves the view). */
export function shownSplit(ids: readonly string[] | undefined, sessions: Record<string, Session>): string[] {
  return (ids ?? []).filter((id) => sessions[id] && !isChat(sessions[id])).slice(0, SPLIT_MAX);
}

export function useSplitIds(): string[] {
  const saved = useHub((s) => s.me?.preferences.splitView);
  const sessions = useHub((s) => s.sessions);
  return useMemo(() => shownSplit(saved, sessions), [saved, sessions]);
}

/** Save the view at once on screen, then on the hub; a refusal puts the old one back and the toast says why. */
export async function saveSplit(ids: string[]): Promise<void> {
  const me = useHub.getState().me;
  const put = (splitView: string[] | undefined) => {
    const now = useHub.getState().me;
    if (now) useHub.setState({ me: { ...now, preferences: { ...now.preferences, splitView } } });
  };
  const before = me?.preferences.splitView;
  put(ids.length ? ids : undefined);
  const ok = await attempt(() => api().updateMe({ splitView: ids.length ? ids : null }));
  if (!ok) put(before);
}
