/**
 * Where the pages are reached (docs/design/SPEC.md 5.3). The sidebar shows
 * Inbox, Meetings (when on) and the mode's own rows (Routines in
 * Assistant); More opens a menu with the rest, Workflows, Memory and
 * Extensions first. Every page keeps its "G then X" key and its place in
 * Search. On a phone the drawer has none of them: they are under Settings,
 * in its More list.
 */
import { useHub } from '@/store/store';
import type { SideMode } from '@/lib/sidebar';
import { useFriendInbox } from '@/store/friends';
import { useIsOwner } from '@/lib/people';

export interface NavItem {
  to: string;
  label: string;
  /** Second key of the "G then X" shortcut. */
  key: string;
  match?: (path: string) => boolean;
}

/** Every page, in order (spec 10.1). Home is first. */
export const NAV: NavItem[] = [
  { to: '/', label: 'Home', key: 'h', match: (p) => p === '/' },
  { to: '/chat', label: 'Chat', key: 'c', match: (p) => p === '/chat' || p.startsWith('/chat/') },
  { to: '/sessions', label: 'Sessions', key: 's', match: (p) => p.startsWith('/sessions') || p.startsWith('/chats') || p.startsWith('/s/') },
  { to: '/approvals', label: 'Inbox', key: 'i', match: (p) => p.startsWith('/approvals') || p.startsWith('/inbox') },
  { to: '/meetings', label: 'Meetings', key: 'n' },
  { to: '/map', label: 'Map', key: 'p' },
  { to: '/tasks', label: 'Tasks', key: 't' },
  { to: '/goals', label: 'Goals', key: 'o' },
  { to: '/routines', label: 'Routines', key: 'r' },
  { to: '/workflows', label: 'Workflows', key: 'w' },
  { to: '/agents', label: 'Agents', key: 'a' },
  { to: '/extensions', label: 'Extensions', key: 'e' },
  { to: '/memory', label: 'Memory', key: 'm' },
  { to: '/usage', label: 'Usage', key: 'u' },
  { to: '/devices', label: 'Devices', key: 'd' },
];
export const SETTINGS_NAV: NavItem = { to: '/settings', label: 'Settings', key: ',' };

/** Pages for the hub's owner only (docs/design/ACCOUNTS.md): a member's apps leave them out. */
export const OWNER_PAGES = new Set(['/extensions', '/settings/friends', '/settings/remote', '/shares', '/projects']);

/** The main navigation as this person sees it. */
export function useNav(): NavItem[] {
  const owner = useIsOwner();
  return owner ? NAV : NAV.filter((n) => !OWNER_PAGES.has(n.to));
}

export const isActive = (n: Pick<NavItem, 'to' | 'match'>, path: string) => (n.match ? n.match(path) : path === n.to || path.startsWith(n.to + '/'));

/** Rows one mode's sidebar has of its own. Routines is the assistant's; Search, G R and /routines reach it in every mode. */
export const MODE_PAGES: Partial<Record<SideMode, string[]>> = { assistant: ['/routines'] };

/** The sidebar's rows after Search and New, in order: Inbox, Meetings when it is on, then the mode's own. */
export const sidePages = (mode: SideMode, meetings: boolean): string[] => ['/approvals', ...(meetings ? ['/meetings'] : []), ...(MODE_PAGES[mode] ?? [])];

/**
 * The sidebar's More menu: the pages that have no row, then the friends,
 * shares and remote access the owner reaches from Settings too.
 */
export const MORE_PAGES: Array<{ to: string; label: string; key?: string }> = [
  { to: '/workflows', label: 'Workflows', key: 'w' },
  { to: '/memory', label: 'Memory', key: 'm' },
  { to: '/extensions', label: 'Extensions', key: 'e' },
  { to: '/tasks', label: 'Tasks', key: 't' },
  { to: '/goals', label: 'Goals', key: 'o' },
  { to: '/agents', label: 'Agents', key: 'a' },
  { to: '/usage', label: 'Usage', key: 'u' },
  { to: '/devices', label: 'Devices', key: 'd' },
  { to: '/map', label: 'Map', key: 'p' },
  { to: '/today', label: 'Today' },
  { to: '/settings/friends', label: 'Friends' },
  { to: '/settings/remote', label: 'Remote access' },
];

/** A phone's More page: the drawer's More row and Settings' More row both open it. */
export const PHONE_MORE = '/settings/more';

/**
 * The More list on a phone (PHONE_MORE): every page the drawer has no row
 * for, the Inbox and All conversations first.
 */
export const PHONE_PAGES: Array<{ to: string; label: string }> = [
  { to: '/approvals', label: 'Inbox' },
  { to: '/sessions', label: 'All conversations' },
  { to: '/workflows', label: 'Workflows' },
  { to: '/routines', label: 'Routines' },
  { to: '/memory', label: 'Memory' },
  { to: '/extensions', label: 'Extensions' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/goals', label: 'Goals' },
  { to: '/agents', label: 'Agents' },
  { to: '/usage', label: 'Usage' },
  { to: '/devices', label: 'Devices' },
  { to: '/map', label: 'Map' },
  { to: '/shares', label: 'Shares' },
  { to: '/projects', label: 'Shared projects' },
];

/** What the Inbox holds: approvals, questions, alerts, offers to import a new computer's chats, and what friends sent (requests, key changes, new notes, share cards). */
export function useInboxCount() {
  const friends = useFriendInbox().count;
  return useHub((s) => Object.keys(s.approvals).length + Object.keys(s.questions).length + Object.keys(s.alerts).length + Object.keys(s.importOffers).length) + friends;
}
