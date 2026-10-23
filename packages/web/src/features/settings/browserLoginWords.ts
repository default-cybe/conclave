/**
 * Words and rows for Settings > Browser, Sites and logins (sitesLogins.tsx).
 * Pure, so tests read them.
 */
import type { BrowserLoginDto, BrowserProfileDto } from '@conclave/core/client';
import { agoWords } from './parts';

/** The line under the group's title: what it is, and where the passwords are. */
export const LOGINS_HELP =
  'The sites each profile is signed in to, and the logins the assistant may use by itself. Saved logins are kept on the hub, encrypted: the hub fills the password in on that site only, the assistant never sees it, and it is not shown here again.';

/** The line at the top of the add and edit form. */
export const LOGIN_FORM_HELP =
  'For your own accounts. The hub keeps the password and 2FA key encrypted and fills them in only on this site, when a task of yours needs it. The assistant never sees them.';

export const SUBDOMAINS_HELP = 'Also fill it in on the site\'s subdomains, such as m.facebook.com for www.facebook.com.';
export const TOTP_HELP = 'The key or otpauth:// link the site shows when you set up an authenticator app. Without it, the assistant asks you for the code.';

/** One site of a profile: a saved login, a site signed in to, or both. */
export interface SiteRow {
  key: string;
  host: string;
  login?: BrowserLoginDto;
  /** When the profile signed in to it (cookies). */
  signedIn?: number;
  lastUsed?: number;
}

/** One row per saved login, and one per signed-in site without a login, most recent first. */
export function siteRows(p: Pick<BrowserProfileDto, 'sites' | 'logins'>): SiteRow[] {
  const signed = new Map(p.sites.map((s) => [s.host, s.at]));
  const covered = new Set<string>();
  const rows: SiteRow[] = [];
  for (const l of p.logins ?? []) {
    const at = signed.get(l.host);
    if (at !== undefined) covered.add(l.host);
    const used = Math.max(l.lastUsed ?? 0, at ?? 0);
    rows.push({ key: l.id, host: l.host, login: l, ...(at !== undefined ? { signedIn: at } : {}), ...(used ? { lastUsed: used } : {}) });
  }
  for (const s of p.sites) if (!covered.has(s.host)) rows.push({ key: `site:${s.host}`, host: s.host, signedIn: s.at, lastUsed: s.at });
  return rows.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.host.localeCompare(b.host));
}

/** "kai@example.com", what the profile has for the site, and when it was last used. */
export function siteRowWords(r: SiteRow, now = Date.now()): { account: string; state: string; used: string; problem?: string } {
  const has = [r.signedIn !== undefined ? 'Signed in' : '', r.login ? `login saved${r.login.totp ? ' with a 2FA key' : ''}` : ''].filter(Boolean).join(', ');
  return {
    account: r.login?.username ?? 'Account not saved',
    state: has.charAt(0).toUpperCase() + has.slice(1),
    used: r.lastUsed ? `last used ${agoWords(r.lastUsed, now)}` : 'not used yet',
    ...(r.login?.problem ? { problem: r.login.problem } : {}),
  };
}

/** The line under a profile's name. */
export function profileLine(p: Pick<BrowserProfileDto, 'label' | 'open' | 'isDefault'>): string {
  return [`${p.label} profile`, p.isDefault ? 'used when a chat picks none' : '', p.open ? 'open now' : ''].filter(Boolean).join(', ');
}

/** The confirm before Delete profile: what goes, and who used it. */
export function deleteProfileWords(p: Pick<BrowserProfileDto, 'name' | 'logins' | 'usedBy' | 'open'>): string {
  const parts = ['Its folder goes, with every cookie in it, so its sites are signed out.'];
  const n = p.logins?.length ?? 0;
  if (n) parts.push(n === 1 ? 'Its saved login goes too.' : `Its ${n} saved logins go too.`);
  const users = p.usedBy ?? [];
  if (users.length) {
    const names = users.map((u) => `${u.watch ? 'watch' : 'routine'} ${u.name}`).join(', ');
    parts.push(`Used by ${names}. ${users.length === 1 ? 'It runs' : 'They run'} in a new, empty profile of this name until you pick another one.`);
  }
  if (p.open) parts.push('Its browser is open now and closes first.');
  return parts.join(' ');
}

/** The confirm before Forget. */
export function forgetWords(r: Pick<SiteRow, 'host' | 'login'>, profile: string): string {
  return `Clears the cookies and stored data of ${r.host} in ${profile}, so the profile is signed out there. ${r.login ? 'The saved login stays, so the assistant can log in again.' : 'Sign in again any time.'}`;
}
