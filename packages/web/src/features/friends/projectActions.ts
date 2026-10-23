/**
 * What the shared project screens ask the hub, each keeping the store
 * current so a screen never waits for the hub's event. Failures toast the
 * hub's words and return undefined.
 */
import type { AddFriendInput, AddFriendResult, CreateSharedProjectInput, SharedItemDto, SharedNoteInput, SharedProjectDto, SharedProjectView, UpdateSharedProjectInput } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, toast, upsertFriend, upsertSharedProject } from '@/store/store';

/** The list's entry is the project without its items. */
function keep<T extends SharedProjectDto>(p: T | undefined): T | undefined {
  if (!p) return undefined;
  const { items: _items, ...dto } = p as T & { items?: unknown };
  upsertSharedProject(dto as SharedProjectDto);
  return p;
}

const secretsWord = (n: number) => (n === 1 ? 'A secret was taken out before it left your hub.' : `${n} secrets were taken out before they left your hub.`);

export async function createSharedProject(input: CreateSharedProjectInput): Promise<SharedProjectView | undefined> {
  const p = keep(await attempt(() => api().createSharedProject(input)));
  if (p) toast({ title: input.members?.length ? `${p.name} is shared. Each friend accepts or declines it.` : `${p.name} is shared. Invite friends to it.`, level: 'success' });
  return p;
}

export async function acceptProject(p: Pick<SharedProjectDto, 'id' | 'name'>): Promise<SharedProjectView | undefined> {
  return keep(await attempt(() => api().acceptSharedProject(p.id)));
}

export async function declineProject(p: Pick<SharedProjectDto, 'id' | 'name' | 'owner'>): Promise<SharedProjectDto | undefined> {
  const r = keep(await attempt(() => api().declineSharedProject(p.id)));
  if (r) toast({ title: `Declined ${p.name}. ${p.owner.name}'s hub is told.`, level: 'info' });
  return r;
}

export async function updateProject(id: string, input: UpdateSharedProjectInput): Promise<SharedProjectView | undefined> {
  return keep(await attempt(() => api().updateSharedProject(id, input)));
}

export async function inviteToProject(id: string, friends: string[]): Promise<SharedProjectView | undefined> {
  const p = keep(await attempt(() => api().inviteToSharedProject(id, friends)));
  if (p) toast({ title: friends.length === 1 ? 'Invited. They accept or decline it in their Inbox.' : 'Invited. Each accepts or declines it in their Inbox.', level: 'success' });
  return p;
}

export async function removeMember(id: string, m: { fingerprint: string; name: string }): Promise<SharedProjectView | undefined> {
  const p = keep(await attempt(() => api().removeSharedMember(id, m.fingerprint)));
  if (p) toast({ title: `${m.name} is out. Their copy stays on their hub, and nothing more goes to them.`, level: 'info' });
  return p;
}

/** Leave (a member) or end (the owner). A copy stays here, read only. */
export async function leaveProject(p: SharedProjectDto): Promise<boolean> {
  const r = await attempt(() => api().leaveSharedProject(p.id));
  if (!r) return false;
  if ('id' in r) upsertSharedProject(r);
  toast({ title: p.role === 'owner' ? `Ended ${p.name}. The members keep their copies.` : `Left ${p.name}. Your copy stays here, read only.`, level: 'info' });
  return true;
}

/** Drop the read only copy from this hub. */
export async function forgetProject(p: SharedProjectDto): Promise<boolean> {
  const r = await attempt(() => api().leaveSharedProject(p.id, { forget: true }));
  if (!r) return false;
  upsertSharedProject(p, true);
  return true;
}

export async function addNote(id: string, input: SharedNoteInput): Promise<SharedItemDto | undefined> {
  const r = await attempt(() => api().addSharedNote(id, input));
  if (r?.redacted) toast({ title: secretsWord(r.redacted), level: 'warning' });
  return r?.item;
}

export async function editItem(id: string, itemId: string, input: Partial<SharedNoteInput>): Promise<SharedItemDto | undefined> {
  const r = await attempt(() => api().editSharedItem(id, itemId, input));
  if (r?.redacted) toast({ title: secretsWord(r.redacted), level: 'warning' });
  return r?.item;
}

export async function deleteItem(id: string, itemId: string): Promise<SharedItemDto | undefined> {
  return (await attempt(() => api().deleteSharedItem(id, itemId)))?.item;
}

export async function shareMemories(id: string, memoryIds: string[]): Promise<boolean> {
  const r = await attempt(() => api().shareProjectMemories(id, memoryIds));
  const n = r?.reduce((s, x) => s + x.redacted, 0) ?? 0;
  if (n) toast({ title: secretsWord(n), level: 'warning' });
  return !!r;
}

export async function shareChats(id: string, sessionIds: string[]): Promise<boolean> {
  return !!(await attempt(() => api().shareProjectChats(id, sessionIds)));
}

export async function markProjectRead(id: string): Promise<void> {
  try {
    upsertSharedProject(await api().markSharedProjectRead(id));
  } catch {
    /* gone meanwhile: the next look tries again */
  }
}

/** Ask a hub to be friends by its address. A request that cannot go comes back with its reason (and an invite by mail). */
export async function addFriendByAddress(input: AddFriendInput): Promise<AddFriendResult | undefined> {
  const r = await attempt(() => api().addFriendByAddress(input));
  if (r?.friend) upsertFriend(r.friend);
  return r;
}
