/**
 * What friends put in the Inbox (docs/design/FRIENDS.md 6), apart from the
 * rest of lib/friends.ts: the Inbox count is in every screen's bar, so this
 * part loads with the app and the rest with Settings.
 *
 * What is new comes from the hub's read marks, one per friend
 * (POST /api/friends/:id/read): every device of the owner counts the same.
 */
import type { FriendDto, InboxItemDto, ReceivedShareDto, SharedProjectDto } from '@conclave/core/client';

// ---------------------------------------------------------------------------
// Read marks
// ---------------------------------------------------------------------------

/**
 * Notes from a friend not read yet. The hub keeps one read mark per friend
 * (FriendDto.readAt, on the hub's clock): a note that came after it is new.
 * The mark moves on every device at once, so this reads it rather than each
 * note's own flag, which is as old as the list. A hub from before read
 * marks sets neither, and nothing counts.
 */
export function unreadNotes(f: Pick<FriendDto, 'unread' | 'readAt'>, notes: InboxItemDto[]): InboxItemDto[] {
  const note = (n: InboxItemDto) => n.type === 'note' && n.state !== 'failed';
  if (f.unread === undefined) return notes.filter((n) => note(n) && n.read === false);
  const mark = f.readAt ?? 0;
  return notes.filter((n) => note(n) && n.receivedAt > mark);
}

/** A share waits for the owner: an offer, or a newer revision of one accepted. */
export function shareWaiting(s: Pick<ReceivedShareDto, 'state' | 'updateWaiting'>): boolean {
  return s.state === 'offered' || (s.state === 'accepted' && s.updateWaiting);
}

/** A share card counts while it waits for the owner and they have not seen it (ReceivedShareDto.read, from the hub). */
export const unreadShare = (s: Pick<ReceivedShareDto, 'read' | 'state' | 'updateWaiting'>) => !s.read && shareWaiting(s);

// ---------------------------------------------------------------------------
// What waits in the Inbox
// ---------------------------------------------------------------------------

export interface FriendInboxItem {
  /** Unique in the Inbox. */
  id: string;
  kind: 'request' | 'key' | 'note' | 'share' | 'project';
  friendId: string;
  name: string;
  at: number;
  /** One line under the name. */
  line: string;
  /** Notes not read yet: each counts in the Inbox. Requests, key changes and share cards count one. */
  count: number;
  href: string;
  /** A share card: the share, for Accept and Decline in place. */
  share?: ReceivedShareDto;
  /** A shared project: an invite (Accept and Decline in place) or items from members not read yet. */
  project?: SharedProjectDto;
}

export const friendHref = (id: string) => `/settings/friends/${encodeURIComponent(id)}`;
export const shareHref = (id: string) => `/shares/${encodeURIComponent(id)}`;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Requests to accept, key changes to confirm, notes not read yet (one row
 * per friend, with its newest note and how many) and share cards not seen
 * yet (one row each), newest first.
 */
export function friendInbox(friends: FriendDto[], notes: InboxItemDto[], shares: ReceivedShareDto[] = [], projects: SharedProjectDto[] = []): FriendInboxItem[] {
  const out: FriendInboxItem[] = [];
  const byId = new Map(friends.map((f) => [f.id, f]));
  for (const f of friends) {
    if (f.status === 'pending' && f.direction === 'in') out.push({ id: `request:${f.id}`, kind: 'request', friendId: f.id, name: f.name, at: f.createdAt, line: 'Wants to be friends', count: 1, href: friendHref(f.id) });
    if (f.status === 'blocked') out.push({ id: `key:${f.id}`, kind: 'key', friendId: f.id, name: f.name, at: f.lastSeen ?? f.createdAt, line: 'Has a new key. Confirm it before anything more moves.', count: 1, href: friendHref(f.id) });
    if (f.status === 'removed') continue;
    const fresh = unreadNotes(
      f,
      notes.filter((n) => n.friendId === f.id),
    );
    // the hub counts every note; the app holds the newest few hundred
    const count = Math.max(fresh.length, f.unread === undefined ? 0 : (f.unreadNotes ?? 0));
    if (!count) continue;
    const last = fresh.reduce<InboxItemDto | undefined>((a, b) => (!a || b.receivedAt > a.receivedAt ? b : a), undefined);
    const text = last?.text ? oneLine(last.text) : last?.state === 'fetching' ? 'A note is on its way.' : 'New notes';
    out.push({ id: `note:${f.id}`, kind: 'note', friendId: f.id, name: f.name, at: last?.receivedAt ?? f.readAt ?? f.createdAt, line: text, count, href: friendHref(f.id) });
  }
  for (const s of shares) {
    const f = byId.get(s.friendId);
    if (!f || f.status === 'removed' || !unreadShare(s)) continue;
    const line = s.state === 'offered' ? `Sent '${s.title}'` : `Sent revision ${s.revision} of '${s.title}'`;
    out.push({ id: `share:${s.id}`, kind: 'share', friendId: f.id, name: f.name, at: s.receivedAt, line, count: 1, href: shareHref(s.id), share: s });
  }
  // shared projects: an invite counts one; a project you are in, each item from a member not read yet
  for (const p of projects) {
    const href = `/projects/${encodeURIComponent(p.id)}`;
    if (p.state === 'invited') out.push({ id: `project:${p.id}`, kind: 'project', friendId: p.owner.friendId ?? '', name: p.owner.name, at: p.updatedAt, line: `Invited you to '${p.name}'`, count: 1, href, project: p });
    else if (p.state === 'active' && p.unread > 0) {
      const line = p.unread === 1 ? 'Something new from a member' : `${p.unread} new things from members`;
      out.push({ id: `project:${p.id}`, kind: 'project', friendId: p.owner.friendId ?? '', name: p.name, at: p.updatedAt, line, count: Math.min(p.unread, 99), href, project: p });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** How many Inbox items friends add: each new note, each request, each key change, each share card. */
export function friendWaiting(items: FriendInboxItem[]): number {
  return items.reduce((n, i) => n + i.count, 0);
}
