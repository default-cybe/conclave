/**
 * Words for Settings > Calendar and mail: what an account is, what its
 * sign-in may do, and which Google sign-in fits where this page is open.
 * Plain functions, so they have tests.
 */
import type { GoogleOAuthStatus, PimAccountDto } from '@conclave/core/client';

const PRESET: Record<string, string> = { nextcloud: 'Nextcloud', icloud: 'iCloud', fastmail: 'Fastmail', gmail: 'Gmail', yahoo: 'Yahoo', other: '' };

/** "Nextcloud calendar", "Google mail and calendar", "Outlook mail", "iCloud mail over IMAP". */
export function accountKind(a: Pick<PimAccountDto, 'kind' | 'preset' | 'mail' | 'calendar'>): string {
  if (a.kind === 'caldav') return `${PRESET[a.preset ?? ''] || 'CalDAV'} calendar`;
  if (a.kind === 'imap') return `${PRESET[a.preset ?? ''] ? `${PRESET[a.preset ?? '']} mail` : 'Mail'} over IMAP`;
  if (a.kind === 'microsoft') return 'Outlook mail';
  return `Google ${[a.mail && 'mail', a.calendar && 'calendar'].filter(Boolean).join(' and ') || 'account'}`;
}

export const AUTO_DRAFT_HELP = 'The Assistant saves a draft straight into Drafts. It never sends; sending still needs your approval.';

const SCOPE: Array<[RegExp, string]> = [
  [/gmail\.readonly$/, 'read mail'],
  [/gmail\.compose$/, 'save drafts and send'],
  [/calendar\.readonly$/, 'read calendars'],
  [/calendar\.events$/, 'change events'],
  [/Mail\.Read$/i, 'read mail'],
  [/Mail\.ReadWrite$/i, 'save drafts'],
  [/Mail\.Send$/i, 'send mail'],
  [/^offline_access$/, 'stay signed in'],
];

/** What the provider granted, in words, in a stable order and without repeats. */
export function scopeWords(scopes: string[] | undefined): string[] {
  const out: string[] = [];
  for (const [re, word] of SCOPE) if ((scopes ?? []).some((s) => re.test(s)) && !out.includes(word)) out.push(word);
  return out;
}

/** Is this page open on the hub machine itself (where Google's loopback redirect comes back)? */
export function onHubMachine(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Which Google sign-in to start from here, in this order: the hub's own Web
 * client with its https callback; else the relay (the shared Web client,
 * whose page on the project site sends the browser back to this hub after a
 * click); else the loopback one. On the hub machine the loopback page
 * finishes it; anywhere else (`paste`) Google lands on 127.0.0.1, which does
 * not load here, and the owner pastes that address back. Without a client,
 * the reason in one sentence.
 */
export function googleChoice(g: GoogleOAuthStatus, host: string): { client: 'web' | 'relay' | 'desktop'; paste?: true } | { why: string } {
  if (g.redirect.web && g.hub.webClientId && g.hub.webSecret) return { client: 'web' };
  if (g.relay) return { client: 'relay' };
  const desktop = g.builtin.desktop || !!g.hub.desktopClientId;
  if (desktop && onHubMachine(host)) return { client: 'desktop' };
  if (desktop) return { client: 'desktop', paste: true };
  return { why: 'No Google client is set up on this hub yet. Follow the steps below once.' };
}

/** What to do while a Google sign-in waits, for the way it started. */
export function googleWaitWords(choice: ReturnType<typeof googleChoice>): string {
  if ('client' in choice && choice.paste) return 'Allow it in the Google tab, then paste the address above.';
  if ('client' in choice && choice.client === 'relay') return 'Allow it in the Google tab, then press Continue on the Conclave page it opens. This page updates when it is done.';
  return 'Finish the sign-in in the Google tab. This page updates when it is done.';
}

/**
 * The hub address the relay sends the browser back to: the hub this page
 * talks to. In a browser or the desktop app that is the page's own origin;
 * the phone app's page is capacitor://localhost, so there it is the API
 * address. The hub checks it is one of its own.
 */
export function hubOrigin(apiBase: string, pageOrigin: string): string {
  try {
    const u = new URL(apiBase);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {
    /* not an address: the page's own */
  }
  return pageOrigin;
}

/** The state and code (or error) from the address Google sent the browser to, pasted back. */
export function pastedCallback(text: string): { state: string; code?: string; error?: string } | undefined {
  const t = text.trim();
  const at = t.indexOf('?');
  if (at < 0) return undefined;
  const q = new URLSearchParams(t.slice(at + 1).split('#')[0]);
  const state = q.get('state');
  const code = q.get('code');
  const error = q.get('error');
  if (!state || (!code && !error)) return undefined;
  return { state, ...(code ? { code } : {}), ...(error ? { error } : {}) };
}

/** The last check, as one line. */
export function checkWords(a: Pick<PimAccountDto, 'lastCheck' | 'signedIn'>): { tone: 'ok' | 'fault' | 'dim'; word: string; detail?: string } {
  if (!a.signedIn) return { tone: 'fault', word: 'Signed out', detail: 'Sign in again or add the app password again.' };
  if (!a.lastCheck) return { tone: 'dim', word: 'Not checked yet' };
  return a.lastCheck.ok ? { tone: 'ok', word: 'Works', detail: a.lastCheck.detail } : { tone: 'fault', word: 'Failed', detail: a.lastCheck.detail };
}
