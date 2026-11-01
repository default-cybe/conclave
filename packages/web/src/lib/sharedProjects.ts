/**
 * Shared projects with friends (docs/design/FRIENDS.md, "Shared projects as
 * built"): the words and orders the screens use, kept apart from React so
 * they are tested on their own.
 */
import type { ProjectDto, SharedItemDto, SharedProjectDto } from '@conclave/core/client';
import type { Tone } from './friends';

export const projectHref = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const PROJECTS = '/projects';

/** Waiting for the owner here: an invite. */
export const projectInvite = (p: Pick<SharedProjectDto, 'state'>) => p.state === 'invited';

/** Read only here: left, taken out, ended or declined. */
export const projectClosed = (p: Pick<SharedProjectDto, 'state'>) => p.state !== 'active' && p.state !== 'invited';

/** The project's state as a word with its tone, for lists. */
export function projectWords(p: Pick<SharedProjectDto, 'state' | 'role' | 'unread'>): { word: string; tone: Tone } {
  switch (p.state) {
    case 'invited':
      return { word: 'Invited', tone: 'warn' };
    case 'active':
      return p.unread ? { word: `${p.unread} new`, tone: 'warn' } : { word: p.role === 'owner' ? 'Yours' : 'Member', tone: 'dim' };
    case 'declined':
      return { word: 'Declined', tone: 'dim' };
    case 'left':
      return { word: 'Left', tone: 'dim' };
    case 'removed':
      return { word: 'Taken out', tone: 'dim' };
    case 'ended':
      return { word: 'Ended', tone: 'dim' };
  }
}

/** Invites first, then those with something new, then the newest. Closed ones last. */
export function projectOrder(list: SharedProjectDto[]): SharedProjectDto[] {
  const rank = (p: SharedProjectDto) => (projectInvite(p) ? 0 : p.state === 'active' ? (p.unread ? 1 : 2) : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

/** owner/name from a GitHub address or a remote ("github.com/owner/name"); undefined when it is not GitHub. */
export function repoOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const s = text
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(s) && !/\/\.\.?$/.test(s) ? s : undefined;
}

/** The GitHub repository of a project of this hub, from its remotes. */
export function repoOfProject(p: Pick<ProjectDto, 'identity'> | undefined): string | undefined {
  for (const r of p?.identity.remotes ?? []) {
    const m = /^github\.com\/(.+)$/i.exec(r);
    const repo = m ? repoOf(m[1]) : undefined;
    if (repo) return repo;
  }
  return undefined;
}

/** A shared project already made from this project of the hub, if any (active or waiting). */
export function sharedFrom(localId: string, list: SharedProjectDto[]): SharedProjectDto | undefined {
  return list.find((p) => p.localProjectId === localId && (p.state === 'active' || p.state === 'invited'));
}

/** "Alice, Bob and Carol". */
export function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Who is in it besides you, for a line under its name. */
export function membersLine(p: Pick<SharedProjectDto, 'members'>): string {
  const others = p.members.filter((m) => !m.you && m.state === 'active').map((m) => m.name);
  const waiting = p.members.filter((m) => !m.you && m.state === 'invited').length;
  const w = waiting ? `${waiting} ${waiting === 1 ? 'invite' : 'invites'} waiting` : '';
  if (!others.length) return w || 'Just you so far';
  return `With ${names(others)}${w ? `, ${w}` : ''}`;
}

/** Whose it is and who else is in it: "You own it. With Bob." or "Alice owns it. Carol is in it too." */
export function ownerLine(p: Pick<SharedProjectDto, 'role' | 'owner' | 'members'>): string {
  if (p.role === 'owner') return `You own it. ${membersLine(p)}.`;
  const others = p.members.filter((m) => !m.you && m.role !== 'owner' && m.state === 'active').map((m) => m.name);
  return `${p.owner.name} owns it.${others.length ? ` ${names(others)} ${others.length === 1 ? 'is' : 'are'} in it too.` : ''}`;
}

/** The items of one kind, newest first, without deleted ones. */
export function itemsOf(items: SharedItemDto[], kind: SharedItemDto['kind']): SharedItemDto[] {
  return items.filter((i) => i.kind === kind && !i.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A member's item in a line: "Bob, version 2". */
export function byLine(i: Pick<SharedItemDto, 'mine' | 'authorName' | 'version'>): string {
  return `${i.mine ? 'You' : i.authorName}${i.version > 1 ? `, version ${i.version}` : ''}`;
}

/** What friends added since the read mark, for the Inbox line: "Bob added 2 notes". */
export function updateLine(p: Pick<SharedProjectDto, 'unread' | 'name'>): string {
  return p.unread === 1 ? `1 new item in '${p.name}'` : `${p.unread} new items in '${p.name}'`;
}

/**
 * The mailto: link for an invite (the hub makes one with the link in it);
 * here only checked, so a page never opens anything but mail.
 */
export function isMailto(href: string | undefined): href is string {
  return !!href && /^mailto:[^\s]+$/i.test(href);
}
