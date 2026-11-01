/**
 * Friends in the Inbox: requests, key changes, notes not read yet and share
 * cards not seen yet, and the hub's read marks (one per friend, so a note
 * read on the phone is not new on the desktop). Each share card says itself
 * whether it is read; when a friend's mark moves (on any device), the cards
 * are fetched again so that stays true.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { friendInbox, friendWaiting, type FriendInboxItem } from '@/lib/friendInbox';
import { onHubEvent, upsertFriend, useHub } from './store';

let refetch: ReturnType<typeof setTimeout> | undefined;

/** Fetch the share cards again soon: their read flags follow the friend's mark. */
export function reloadReceivedShares(delay = 150) {
  clearTimeout(refetch);
  refetch = setTimeout(() => {
    api()
      .receivedShares()
      .then((list) => useHub.setState({ receivedShares: Object.fromEntries(list.map((r) => [r.id, r])) }))
      .catch(() => undefined);
  }, delay);
}

/**
 * What happened while the owner watched, for the knot rope
 * (docs/design/KNOT-MOTION.md 5): a share that arrived (receive) and a
 * friend who was just added (success). Each plays once, then is let go.
 */
export const useFriendMoments = create<{ shares: Record<string, true>; friends: Record<string, true> }>(() => ({ shares: {}, friends: {} }));

/** A friend became a friend here: their row and page tie the knot once. */
export function friendAdded(id: string) {
  useFriendMoments.setState((s) => ({ friends: { ...s.friends, [id]: true } }));
}

/** The moment played: let it go. */
export function momentPlayed(kind: 'shares' | 'friends', id: string) {
  useFriendMoments.setState((s) => {
    const next = { ...s[kind] };
    delete next[id];
    return { [kind]: next } as Partial<{ shares: Record<string, true>; friends: Record<string, true> }>;
  });
}

onHubEvent((e) => {
  if (e.type === 'friend.updated') {
    const was = useHub.getState().friends[e.friend.id];
    // a friend's read mark moved, here or on another device
    if (was && (was.readAt !== e.friend.readAt || was.unreadShares !== e.friend.unreadShares)) reloadReceivedShares();
    // they accepted our request, or we accepted theirs on another device
    if (was?.status === 'pending' && e.friend.status === 'active') friendAdded(e.friend.id);
  }
  // a share came in, or a new revision of one: its card ties the rope in
  if (e.type === 'friend.share' && (e.change === 'received' || e.change === 'updated')) useFriendMoments.setState((s) => ({ shares: { ...s.shares, [e.share.id]: true } }));
});

/**
 * Tell the hub the owner saw these (a note's id, or share cards' ids): its
 * mark moves to the newest of them and never back. Every device of the
 * owner sees it.
 */
export async function markFriendRead(friendId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  let moved = false;
  for (const id of ids) {
    try {
      upsertFriend(await api().markFriendRead(friendId, id));
      moved = true;
    } catch {
      /* gone meanwhile, or a hub from before read marks: the next look tries again */
    }
  }
  if (moved) reloadReceivedShares(0);
}

/** What friends put in the Inbox (requests, key changes, new notes, share cards) and how many count. */
export function useFriendInbox(): { items: FriendInboxItem[]; count: number } {
  const friends = useHub((s) => s.friends);
  const notes = useHub((s) => s.friendNotes);
  const shares = useHub((s) => s.receivedShares);
  const projects = useHub((s) => s.sharedProjects);
  return useMemo(() => {
    const items = friendInbox(Object.values(friends), notes, Object.values(shares), Object.values(projects ?? {}));
    return { items, count: friendWaiting(items) };
  }, [friends, notes, shares, projects]);
}
