/**
 * What the friends screens ask the hub, each keeping the store current so a
 * screen never waits for the hub's event. Failures toast the hub's words
 * and return undefined.
 */
import type { ApplyShareInput, ForkShareInput, FriendDto, FriendGrants, HandoffShareInput, OutboxItemDto, ReceivedShareDto, SendShareInput, SentShareDto, UpdateShareInput } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { namesWords } from '@/lib/shares';
import { attempt, toast, upsertFriend, upsertReceivedShare, upsertSentShare, upsertSession, useHub } from '@/store/store';
import { friendAdded } from '@/store/friends';

async function friendCall(fn: () => Promise<FriendDto>, okTitle?: string): Promise<FriendDto | undefined> {
  const f = await attempt(fn);
  if (!f) return undefined;
  upsertFriend(f);
  if (okTitle) toast({ title: okTitle, level: 'success' });
  return f;
}

/** Use a friend's link: the hub checks their hub's key, then sends the request. */
export function acceptInvite(link: string) {
  return friendCall(() => api().acceptFriendInvite(link));
}

/** Accept a request: once the hub says so, the friend's row and page tie the knot (success). */
export async function acceptRequest(f: FriendDto) {
  const r = await friendCall(() => api().acceptFriend(f.id), `You and ${f.name} are friends.`);
  if (r?.status === 'active') friendAdded(r.id);
  return r;
}

/** Decline a request in, or withdraw one out. Their hub is not told. */
export async function declineRequest(f: FriendDto): Promise<boolean> {
  const ok = await attempt(() => api().declineFriend(f.id));
  if (!ok) return false;
  upsertFriend({ ...f, status: 'removed' });
  toast({ title: f.direction === 'in' ? `Declined ${f.name}'s request. Their hub is not told.` : `Withdrew the request to ${f.name}.`, level: 'info' });
  return true;
}

export function markVerified(f: FriendDto, verified: boolean) {
  return friendCall(() => api().verifyFriend(f.id, verified));
}

export function setGrants(f: FriendDto, grants: Partial<FriendGrants>) {
  // the switch moves at once; the hub's answer settles it
  upsertFriend({ ...f, grants: { ...f.grants, ...grants } });
  return friendCall(() => api().setFriendGrants(f.id, grants)).then((r) => {
    if (!r) upsertFriend(f);
    return r;
  });
}

export async function removeFriend(f: FriendDto): Promise<boolean> {
  const ok = await attempt(() => api().removeFriend(f.id));
  if (!ok) return false;
  upsertFriend({ ...f, status: 'removed' });
  toast({ title: `Removed ${f.name}. Their hub is asked to stop too.`, level: 'info' });
  return true;
}

export function confirmKey(f: FriendDto) {
  return friendCall(() => api().confirmFriendKey(f.id), `Took ${f.name}'s new key. Compare the new safety code with them.`);
}

/** Send what waits and fetch what their hub holds, now. */
export function syncFriend(f: FriendDto) {
  return friendCall(() => api().syncFriend(f.id));
}

export async function sendNote(f: FriendDto, text: string): Promise<OutboxItemDto | undefined> {
  const item = await attempt(() => api().sendFriendNote(f.id, text));
  if (!item) return undefined;
  const cur = useHub.getState().friends[f.id];
  if (cur && item.state === 'queued') upsertFriend({ ...cur, queued: cur.queued + 1 });
  return item;
}

export function retryNote(id: string) {
  return attempt(() => api().retryFriendMessage(id));
}

export function cancelNote(id: string) {
  return attempt(() => api().cancelFriendMessage(id));
}

// ---------------------------------------------------------------------------
// Shares (phases 2 and 3)
// ---------------------------------------------------------------------------

/** Send a chat or session to friends. Their hubs fetch it only when they accept. */
export async function sendShare(input: SendShareInput): Promise<SentShareDto | undefined> {
  const s = await attempt(() => api().sendShare(input));
  if (s) upsertSentShare(s);
  return s;
}

/** A new revision of a sent share, from the session as it is now. */
export async function updateShare(id: string, input: UpdateShareInput): Promise<SentShareDto | undefined> {
  const s = await attempt(() => api().updateShare(id, input));
  if (!s) return undefined;
  upsertSentShare(s);
  toast({ title: `Sent revision ${s.revision} of '${s.title}'.`, level: 'success' });
  return s;
}

/** Unsend: each friend's hub is asked to delete its copy. */
export async function unsendShare(id: string): Promise<SentShareDto | undefined> {
  const s = await attempt(() => api().unsendShare(id));
  if (!s) return undefined;
  upsertSentShare(s);
  const names = s.recipients.map((r) => r.friendName);
  toast({ title: `Unsent '${s.title}'.`, body: names.length ? `${namesWords(names)} ${names.length === 1 ? 'is' : 'are'} asked to delete the copy.` : '', level: 'info' });
  return s;
}

/** Accept: the hub fetches the share from the friend's hub and checks its signature. */
export async function acceptShare(s: ReceivedShareDto, opts: { quiet?: boolean; open?: () => void } = {}): Promise<ReceivedShareDto | undefined> {
  upsertReceivedShare({ ...s, state: 'fetching', error: undefined });
  try {
    const r = await api().acceptShare(s.id);
    upsertReceivedShare(r);
    if (!opts.quiet) toast({ title: `Fetched '${r.title}' from ${r.friendName}'s hub.`, body: 'Its signature checks out against their key.', level: 'success', ...(opts.open ? { action: { label: 'Open', run: opts.open } } : {}) });
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // the hub keeps the reason on the card too
    const back = await api()
      .receivedShare(s.id)
      .catch(() => ({ ...s, error: msg }));
    upsertReceivedShare(back);
    toast({ title: msg, level: 'error' });
    return undefined;
  }
}

export async function declineShare(s: ReceivedShareDto): Promise<ReceivedShareDto | undefined> {
  const r = await attempt(() => api().declineShare(s.id));
  if (!r) return undefined;
  upsertReceivedShare(r);
  toast({ title: `Declined '${s.title}'. ${s.friendName}'s hub is not told.`, level: 'info' });
  return r;
}

/** After a fork, handoff or reference: the session is in the store, and the card lists it. */
async function madeFrom(shareId: string, session: Session | undefined): Promise<Session | undefined> {
  if (!session) return undefined;
  upsertSession(session);
  const r = await api()
    .receivedShare(shareId)
    .catch(() => undefined);
  if (r) upsertReceivedShare(r);
  return session;
}

export async function forkShare(id: string, input: ForkShareInput): Promise<Session | undefined> {
  return madeFrom(id, await attempt(() => api().forkShare(id, input)));
}

export async function handoffShare(id: string, input: HandoffShareInput): Promise<Session | undefined> {
  return madeFrom(id, await attempt(() => api().handoffShare(id, input)));
}

export async function referenceShare(id: string): Promise<Session | undefined> {
  return madeFrom(id, await attempt(() => api().referenceShare(id)));
}

/** Check where the share's code would land. Nothing changes there. */
export function planApplyShare(id: string, input: ApplyShareInput) {
  return attempt(() => api().planApplyShare(id, input));
}

/** The owner approved the plan: the code lands on its new branch. */
export function applyShare(id: string, planId: string) {
  return attempt(() => api().applyShare(id, planId));
}
