/**
 * Accounts in the web app (docs/design/ACCOUNTS.md 10): who is signed in
 * (GET /api/me, in the store), the sign ins this browser keeps so a person
 * can switch between them, and signing out.
 *
 * The current sign in is the connection in lib/api.ts. The others wait in
 * localStorage under conclave.accounts; switching saves the picked one as
 * the connection and reloads, so every store and socket starts clean.
 */
import { shownName, type MeDto } from '@conclave/core/client';
import { api, clearConnection, loadConnection, saveConnection, type Connection } from './api';
import { useHub } from '@/store/store';

const KEY = 'conclave.accounts';

/** Same hub and same person (or same token, for a sign in from before accounts). */
function same(a: Connection, b: Connection): boolean {
  if (a.baseUrl !== b.baseUrl) return false;
  if (a.account && b.account) return a.account.id === b.account.id;
  return a.token === b.token;
}

/** Every sign in this browser keeps, the current one first. */
export function savedAccounts(): Connection[] {
  let list: Connection[] = [];
  try {
    const raw = localStorage.getItem(KEY);
    list = raw ? (JSON.parse(raw) as Connection[]).filter((c) => c && c.baseUrl && c.token) : [];
  } catch {
    list = [];
  }
  const cur = loadConnection();
  if (cur) list = [cur, ...list.filter((c) => !same(c, cur))];
  return list;
}

function keep(list: Connection[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: only the current one is kept */
  }
}

/** Keep a new sign in (or its newer token) in the list. */
export function rememberAccount(conn: Connection): void {
  keep([conn, ...savedAccounts().filter((c) => !same(c, conn))]);
}

/** The name to show for a sign in: the person (their display name, else their sign-in name), else the hub. */
export function accountLabel(c: Connection): string {
  return (c.account && (shownName(c.account) ?? c.account.name)) || c.hubName || c.baseUrl.replace(/^https?:\/\//, '');
}

/** After a change to who is signed in (a new name): the kept sign in shows it too, in the list of accounts to switch to. */
export function refreshAccount(me: Pick<MeDto, 'id' | 'name' | 'displayName' | 'role'>): void {
  const cur = loadConnection();
  if (!cur?.account || cur.account.id !== me.id) return;
  if (cur.account.name === me.name && cur.account.displayName === me.displayName) return;
  const conn: Connection = { ...cur, account: { id: me.id, name: me.name, ...(me.displayName ? { displayName: me.displayName } : {}), role: me.role } };
  saveConnection(conn);
  rememberAccount(conn);
}

/** True when this is the sign in the app runs on now. */
export function isCurrent(c: Connection): boolean {
  const cur = loadConnection();
  return !!cur && same(c, cur);
}

/** Use another kept sign in: it becomes the connection and the app starts again on Home. */
export function switchAccount(conn: Connection): void {
  saveConnection(conn);
  window.location.assign('/');
}

/** Add another person on this browser: the Connect screen, with the current sign in kept. */
export function addAccount(): void {
  window.location.assign('/?connect=1');
}

/**
 * Sign out of the current sign in: end its app token on the hub (any app may
 * sign itself out), forget it here, and open the next kept sign in or the
 * Connect screen. The hub token has no app to end: it is only forgotten.
 */
export async function signOut(): Promise<void> {
  const cur = loadConnection();
  if (cur?.clientId) {
    try {
      await api().request('DELETE', `/api/clients/${encodeURIComponent(cur.clientId)}`);
    } catch {
      /* already gone, or the hub is away: forget it here anyway */
    }
  }
  const rest = savedAccounts().filter((c) => !cur || !same(c, cur));
  keep(rest);
  await clearConnection();
  if (rest[0]) switchAccount(rest[0]);
  else window.location.assign('/?connect=1');
}

/** What a sign-in name may be: what a person types to sign in (core people/store.ts NAME_RE). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * The person's name to show, or undefined for an owner who has not given
 * one ("owner" is no name): their display name, else their sign-in name with
 * a capital (core client/people.ts shownName).
 */
export function personName(me: Pick<MeDto, 'name' | 'displayName' | 'role'> | undefined): string | undefined {
  return shownName(me);
}

/**
 * The name Home greets with ("Good evening, Kai."). A member: their own
 * display name. The owner: hub config ui.name, which the hub sets to the
 * owner's display name when that changes (Settings, Appearance can still set
 * it on its own, or clear it for no name); else the display name; else none.
 */
export function greetingName(me: Pick<MeDto, 'name' | 'displayName' | 'role'> | undefined, uiName: unknown): string | undefined {
  if (me?.role === 'member') return shownName(me);
  if (typeof uiName === 'string') return uiName.trim() || undefined;
  return shownName(me);
}

/** Why a name cannot be the account's sign-in name, or undefined when it can. */
export function nameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n || NAME_RE.test(n)) return undefined;
  if (/\s/.test(n)) return 'One word, with no spaces.';
  if (n.length > 40) return 'At most 40 characters.';
  return 'Use letters, digits, dots, dashes or underscores, starting with a letter or digit.';
}

/** Why a name cannot be a display name, or undefined when it can (spaces are fine). */
export { displayNameProblem, tidyDisplayName, DISPLAY_NAME_MAX } from '@conclave/core/client';

/** Who is signed in. Undefined on a hub from before accounts: then it is the owner. */
export function useMe(): MeDto | undefined {
  return useHub((s) => s.me);
}

/** The hub's owner sees everything; a member sees their own things and no hub settings. */
export function useIsOwner(): boolean {
  return useHub((s) => !s.me || s.me.role === 'owner');
}

export function isOwnerNow(): boolean {
  const me = useHub.getState().me;
  return !me || me.role === 'owner';
}
