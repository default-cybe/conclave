/**
 * Friends in words (docs/design/FRIENDS.md): the invite link a friend sends,
 * the short key and the safety code in groups, whether friends reach this
 * hub, a friend's state in one line, what waits in the Inbox, and how a
 * sent note is doing. A friend's thread with notes and shares is in
 * lib/shares.ts. No React here, so the tests run it as is.
 */
import type { FriendDto, FriendReachability, OutboxItemDto } from '@conclave/core/client';
import { hhmm, inTime, shortDate } from './format';

// ---------------------------------------------------------------------------
// The invite link
// ---------------------------------------------------------------------------

/** A friend's invite: conclave://friend?fp=...&url=...&alt=...&s=...&exp=... */
export interface FriendLink {
  /** The link alone, as the hub takes it. */
  link: string;
  /** The inviting hub's key fingerprint, 32 hex characters. */
  fp: string;
  /** Where that hub answers, best first. */
  url: string;
  alts: string[];
  expiresAt: number;
}

const LINK = /conclave:\/\/friend\?[^\s"'<>]+/i;

/** An http or https address with no user, query or hash, without a trailing slash. */
function cleanUrl(v: string | null): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password || u.search || u.hash) return undefined;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * The invite in pasted or scanned text: the link alone, or a message with
 * the link in it ("Here is my invite: conclave://friend?..."). Undefined
 * when there is none or it is not whole. The hub checks it again.
 */
export function parseFriendLink(text: string | null | undefined): FriendLink | undefined {
  const m = (text ?? '').match(LINK);
  if (!m) return undefined;
  // a sentence may end right after the link
  const link = m[0].replace(/[).,;:!?]+$/, '');
  const q = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  const fp = (q.get('fp') ?? '').toLowerCase();
  const url = cleanUrl(q.get('url'));
  const secret = q.get('s') ?? '';
  const exp = Number(q.get('exp'));
  if (!/^[0-9a-f]{32}$/.test(fp) || !url || !/^[A-Za-z0-9_-]{22,64}$/.test(secret) || !Number.isSafeInteger(exp) || exp <= 0) return undefined;
  const alts: string[] = [];
  for (const a of q.getAll('alt')) {
    const u = cleanUrl(a);
    if (u && u !== url && !alts.includes(u)) alts.push(u);
  }
  return { link, fp, url, alts: alts.slice(0, 8), expiresAt: exp * 1000 };
}

/** "example.com" from "https://example.com:8443/x"; the text itself when it is not an address. */
export function hostWords(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Keys and codes
// ---------------------------------------------------------------------------

/** "3f9a 12c0 8e41 07b2": the first groups of four of a key's fingerprint, enough to tell friends apart. */
export function shortFingerprint(fp: string, groups = 4): string {
  const clean = (fp ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return (clean.match(/.{1,4}/g) ?? []).slice(0, groups).join(' ');
}

/** "18342 90311 55120 07718" as its four groups of five digits, however it was spaced. */
export function safetyGroups(code: string): string[] {
  return (code ?? '').replace(/\D/g, '').match(/.{1,5}/g) ?? [];
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "4m ago", "3h ago", "2d ago", "on 17 Aug". */
export function agoText(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < 45_000) return 'just now';
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  if (d < 7 * DAY) return `${Math.round(d / DAY)}d ago`;
  return `on ${shortDate(ts)}`;
}

const dayOf = (t: number) => new Date(t).toDateString();

/** "Today 14:02", "Yesterday 09:10", "16 Oct 18:30": the label over a group of notes. */
export function stampText(ts: number, now = Date.now()): string {
  if (dayOf(ts) === dayOf(now)) return `Today ${hhmm(ts)}`;
  if (dayOf(ts) === dayOf(now - DAY)) return `Yesterday ${hhmm(ts)}`;
  return `${shortDate(ts)} ${hhmm(ts)}`;
}

/** "until 14:05 today", "until 09:30 tomorrow", "until 16 Oct 09:30": when an invite stops working. */
export function untilText(ts: number, now = Date.now()): string {
  if (dayOf(ts) === dayOf(now)) return `until ${hhmm(ts)} today`;
  if (dayOf(ts) === dayOf(now + DAY)) return `until ${hhmm(ts)} tomorrow`;
  return `until ${shortDate(ts)} ${hhmm(ts)}`;
}

// ---------------------------------------------------------------------------
// Can friends reach this hub
// ---------------------------------------------------------------------------

export interface ReachWords {
  ok: boolean;
  /** One plain sentence: "Friends cannot reach this hub." */
  title: string;
  /** Why, in one sentence, when they cannot. */
  why?: string;
  /** What to do, or what to know about the address. */
  detail?: string;
}

const PULLS = 'Until then your hub still fetches what friends hold for it.';

/**
 * Whether a friend's hub reaches this one (FRIENDS.md 5): a tunnel or your
 * own URL does; Tailscale serves only your tailnet, and with remote access
 * off only this network reaches the hub.
 */
export function reachWords(r: FriendReachability | undefined): ReachWords | undefined {
  if (!r) return undefined;
  if (r.ok) {
    const at = r.best ? ` at ${hostWords(r.best.url)}` : '';
    return { ok: true, title: `Friends reach this hub${at}.`, ...(r.best?.kind === 'quick' ? { detail: 'A quick tunnel gets a new address when it restarts. Your hub sends friends the new one.' } : {}) };
  }
  const fix = 'Turn on a tunnel or use your own URL in Remote access.';
  const title = 'Friends cannot reach this hub.';
  if (r.mode === 'off') return { ok: false, title, why: 'Remote access is off.', detail: `${fix} ${PULLS}` };
  if (r.mode === 'tailscale') return { ok: false, title, why: 'Tailscale serves only your tailnet.', detail: `${fix} ${PULLS}` };
  // a tunnel or an address that does not answer yet: the hub says why
  return { ok: false, title: 'Friends cannot reach this hub yet.', detail: r.reason ?? `The hub has no outside address yet. ${PULLS}` };
}

// ---------------------------------------------------------------------------
// A friend in one line
// ---------------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'fault' | 'dim';

export interface FriendState {
  /** The state, short: "Seen 4m ago", "Wants to be friends". */
  word: string;
  tone: Tone;
  /** More, when there is more to say. */
  line?: string;
}

export function friendState(f: FriendDto, now = Date.now()): FriendState {
  if (f.status === 'blocked') return { word: 'New key', tone: 'fault', line: f.blockedReason ?? `${f.name}'s hub has a new key. Nothing is sent or taken until you confirm it.` };
  if (f.status === 'pending')
    return f.direction === 'in'
      ? { word: 'Wants to be friends', tone: 'warn', line: `Asked ${agoText(f.createdAt, now)}.` }
      : { word: 'Waiting for them', tone: 'dim', line: `You asked ${agoText(f.createdAt, now)}. You are friends once their owner accepts.` };
  if (f.status === 'removed') return { word: 'Removed', tone: 'dim' };
  const queued = f.queued ? `${f.queued} waiting to go.` : '';
  if (f.lastError) return { word: f.lastSeen ? `Seen ${agoText(f.lastSeen, now)}` : 'Not reached yet', tone: 'warn', line: [f.lastError, queued].filter(Boolean).join(' ') };
  return { word: f.lastSeen ? `Seen ${agoText(f.lastSeen, now)}` : 'Not seen yet', tone: 'dim', ...(queued ? { line: queued } : {}) };
}

/** Friends in the order the list shows them: what needs you first, then by name. */
export function friendOrder(list: FriendDto[]): FriendDto[] {
  const rank = (f: FriendDto) => (f.status === 'blocked' ? 0 : f.status === 'pending' && f.direction === 'in' ? 1 : f.status === 'active' ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export { friendHref, friendInbox, friendWaiting, shareHref, type FriendInboxItem } from './friendInbox';

// ---------------------------------------------------------------------------
// The notes with one friend
// ---------------------------------------------------------------------------

/** A label goes over a note when this much time passed since the one before. */
export const STAMP_GAP_MS = 30 * MIN;

export interface DeliveryWords {
  word: string;
  tone: Tone;
  line?: string;
  /** Retry and Cancel apply. */
  retry?: boolean;
  /** Cancel applies (a note still trying). */
  cancel?: boolean;
}

/** How a sent note is doing, under it. */
export function deliveryWords(o: OutboxItemDto, name: string, now = Date.now()): DeliveryWords {
  switch (o.state) {
    case 'delivered':
      return { word: o.via === 'pull' ? `${name}'s hub fetched it` : 'Delivered', tone: 'dim' };
    case 'queued':
      if (!o.attempts) return { word: 'Sending', tone: 'dim', cancel: true };
      // a short reason fits under a note; a long one (an address and the error) stays on the friend's details
      return {
        word: 'Waiting',
        tone: 'warn',
        line: [o.lastError && o.lastError.length <= 70 ? o.lastError : `${name}'s hub has not taken it yet.`, o.nextTry ? `Trying again ${inTime(o.nextTry, now)}.` : ''].filter(Boolean).join(' '),
        cancel: true,
      };
    case 'failed':
      return { word: 'Not delivered', tone: 'fault', line: o.lastError ?? `${name}'s hub could not be reached for 7 days.`, retry: true };
    case 'expired':
      return { word: 'Not delivered', tone: 'fault', line: 'It lapsed before it arrived.' };
    case 'cancelled':
      return { word: 'Cancelled', tone: 'dim' };
  }
}
