/**
 * Accounts in the web app (Settings > Models > Accounts, Usage): the status
 * hook, words for each state, window names, reset times, and the "Now using
 * Account 2 (resets Tue 10:00, 45% left)" line. The hub never sends a key
 * or token here.
 */
import { useEffect, useState } from 'react';
import type { AccountDto, AccountNowDto, AccountState, AccountsStatus, StarterDto } from '@conclave/core/client';
import type { LimitWindow } from '@conclave/core/types';
import { suggestPrefixes } from '@conclave/core/accounts/prefix';
import { variantBase } from '@conclave/core/providers/model-id';
import type { LogoId } from '@/components/logo';
import { api } from './api';
import { useHub } from '@/store/store';
import type { Tone } from './subscriptions';

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/**
 * The status: loaded once, then kept current by accounts.updated events.
 * `fresh` reads it again on mount (Settings); elsewhere the first reader loads it.
 */
export function useAccounts(fresh = false): { status: AccountsStatus | undefined; set: (s: AccountsStatus) => void; error?: string; reload: () => void } {
  const live = useHub((s) => s.accounts);
  const [error, setError] = useState<string>();
  const set = (s: AccountsStatus) => useHub.setState({ accounts: s });
  const reload = () => {
    setError(undefined);
    // a member's answer is their own plans (docs/design/ACCOUNTS.md 12)
    api()
      .accounts()
      .then(set)
      .catch((e) => setError(errText(e)));
  };
  useEffect(() => {
    if (fresh || !useHub.getState().accounts) reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { status: live, set, error, reload };
}

export const STATE_WORD: Record<AccountState, { word: string; tone: Tone }> = {
  ready: { word: 'Ready', tone: 'ok' },
  unknown: { word: 'Ready', tone: 'ok' },
  limited: { word: 'At its limit', tone: 'warn' },
  cooldown: { word: 'Resting', tone: 'warn' },
  budget: { word: 'Budget spent', tone: 'fault' },
  paused: { word: 'Paused', tone: 'dim' },
  error: { word: 'Not working', tone: 'fault' },
};

/** Company mark per vendor. */
export const VENDOR_LOGO: Record<string, LogoId> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  xai: 'xai',
  moonshot: 'moonshot',
  meta: 'llama',
  zai: 'zai',
  deepseek: 'deepseek',
  qwen: 'qwen',
  minimax: 'minimax',
};

/** "5 hours", "Week", "Week, Opus", "Fable", "Budget". */
export function windowName(w: Pick<LimitWindow, 'name'>): string {
  const n = w.name.trim().toLowerCase();
  if (n === '5h') return '5 hours';
  if (n === '7d') return 'Week';
  if (n === '7d fable') return 'Fable';
  if (n === 'budget') return 'Budget';
  const m = /^7d (.+)$/.exec(n);
  if (m) return `Week, ${m[1][0].toUpperCase()}${m[1].slice(1)}`;
  if (n === 'requests') return 'Requests per minute';
  if (n === 'tokens' || n === 'input-tokens' || n === 'output-tokens') return 'Tokens per minute';
  return n[0].toUpperCase() + n.slice(1);
}

/** The windows a row shows: 5 hours, week, the model weeks, Fable, the budget. Rates and info-only weeks stay out. */
export function rowWindows(a: Pick<AccountDto, 'windows'>): LimitWindow[] {
  return a.windows.filter((w) => w.kind !== 'rate' && w.kind !== 'extra' && !/oauth apps|cowork|code review|credits/i.test(w.name));
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "14:10" today, "Tue 10:00" within the next 7 days, "22 Nov" after that. */
export function resetWords(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hm(d);
  if (ts - now < 7 * 86_400_000 && ts > now) return `${WEEKDAY[d.getDay()]} ${hm(d)}`;
  return `${d.getDate()} ${MONTH[d.getMonth()]}`;
}

/** Percent used, rounded, or undefined when unknown. */
export function usedOf(w: LimitWindow): number | undefined {
  if (w.usedPercent !== undefined) return Math.round(w.usedPercent);
  if (w.limit && w.remaining !== undefined) return Math.round((1 - w.remaining / w.limit) * 100);
  return undefined;
}

/** "$38.40 of $100" for a budget window. */
export function budgetWords(w: LimitWindow): string | undefined {
  if (w.kind !== 'budget' || w.limit === undefined) return undefined;
  const spent = Math.max(0, w.limit - (w.remaining ?? 0));
  const usd = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(2).replace(/\.00$/, '')}`;
  return `${usd(spent)} of ${usd(w.limit)}`;
}

/**
 * The line for a vendor: "Now using Account 2 (resets Tue 10:00, 45% left)",
 * and why the accounts before it were passed over.
 */
export function nowLine(n: AccountNowDto, accounts: AccountDto[], now = Date.now()): { lead: string; why: string[]; tone: Tone } {
  const name = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
  const why = n.skipped.map((s) => {
    const a = accounts.find((x) => x.id === s.account);
    const until = a?.until ? ` until ${resetWords(a.until, now)}` : '';
    return `${name(s.account)}: ${s.reason.toLowerCase()}${until}.`;
  });
  if (!n.account) {
    return { lead: `No ${n.vendorName} account can take a call${n.until ? ` until ${resetWords(n.until, now)}` : ''}.`, why, tone: 'fault' };
  }
  const w = n.window;
  const used = w ? usedOf(w) : undefined;
  const parts = [w?.resetsAt && `resets ${resetWords(w.resetsAt, now)}`, used !== undefined && `${Math.max(0, 100 - used)}% left`].filter(Boolean);
  return { lead: `Now using ${name(n.account)}${parts.length ? ` (${parts.join(', ')})` : ''}.`, why, tone: n.skipped.length ? 'warn' : 'ok' };
}

// ---------------------------------------------------------------------------
// Short names (CLIProxyAPI prefixes, core/src/accounts/prefix.ts)
// ---------------------------------------------------------------------------

/** Where the owner gives a plan its short name, for hints elsewhere. */
export const SHORT_NAME_WHERE = 'Settings > Models > Accounts';

/** What a signed in plan's short name and its "Use when a model refuses" switch need, said where they are off. */
export const MANAGEMENT_NOTE = "Short names and Use when a model refuses need CLIProxyAPI's management key. Add it in Subscriptions.";

// ---------------------------------------------------------------------------
// Use when a model refuses (core/src/session/refusal-fallback.ts)
// ---------------------------------------------------------------------------

export const REFUSAL_SWITCH = 'Use when a model refuses';
export const REFUSAL_HINT = 'A refused reply is tried again here first, same model.';

/** How a marked account is named in the Refusal fallback line: a plan by its short name, a key by its label. */
function markedName(a: AccountDto): string {
  return a.kind === 'subscription' ? (a.prefix ?? a.label) : a.label;
}

/**
 * The line at the top of Refusal fallback: the marked plans and keys, in
 * Accounts order per vendor ("Tried first: personal-claude on Claude."), or
 * how to mark one.
 */
export function refusalMarkedLine(status: Pick<AccountsStatus, 'accounts' | 'routes'> | undefined): { marked: boolean; text: string } {
  const accounts = status?.accounts ?? [];
  const order = (a: AccountDto) => status?.routes.find((r) => r.vendor === a.vendor && !r.match)?.order.indexOf(a.id) ?? 0;
  const marked = accounts.filter((a) => a.refusal);
  if (!marked.length) return { marked: false, text: `No plan or key is marked yet. Turn on ${REFUSAL_SWITCH} on one in Accounts, and a refused reply is tried there first, same model, before this list.` };
  const vendors = [...new Set(marked.map((a) => a.vendor))];
  const parts = vendors.map((v) => {
    const list = marked.filter((a) => a.vendor === v).sort((x, y) => order(x) - order(y));
    const names = list.map(markedName);
    const joined = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    return `${joined} on ${list[0].vendorName}`;
  });
  return { marked: true, text: `Tried first: ${parts.join('; ')}.` };
}

/** The short names of the plans other than `except`. */
export function takenPrefixes(accounts: AccountDto[], except?: string): string[] {
  return accounts.filter((a) => a.id !== except && a.prefix).map((a) => a.prefix!);
}

/** A short name to offer each plan that has none, by account id. */
export function shortNameSuggestions(accounts: AccountDto[]): Map<string, string> {
  const plans = accounts.filter((a) => a.kind === 'subscription' && !a.prefix);
  return suggestPrefixes(plans, takenPrefixes(accounts));
}

/** Models two or more signed in plans list (Opus on Claude and Antigravity), account prefix and effort or thinking variant dropped (Antigravity's claude-opus-5-5-high), that have no order of their own yet: what "Per model" offers. */
export function sharedModels(status: Pick<AccountsStatus, 'accounts' | 'routes'>): Array<{ id: string; name: string }> {
  const taken = new Set(status.routes.filter((r) => r.match).map((r) => r.match!.toLowerCase()));
  const seen = new Map<string, { id: string; name: string; plans: Set<string> }>();
  for (const a of status.accounts) {
    if (a.kind !== 'subscription') continue;
    for (const m of a.models) {
      const own = m.id.slice(m.id.lastIndexOf('/') + 1);
      const id = variantBase(own);
      // a variant's name says its level ("Claude Opus 5.5 (High)"); the model's own entry names it when a plan lists it
      const name = id === own ? m.name || id : (m.name || id).replace(/\s*\([^)]*\)$/, '');
      const e = seen.get(id.toLowerCase()) ?? { id, name, plans: new Set<string>() };
      if (id === own && m.name) e.name = m.name;
      e.plans.add(a.id);
      seen.set(id.toLowerCase(), e);
    }
  }
  return [...seen.entries()].filter(([k, e]) => e.plans.size > 1 && !taken.has(k)).map(([, e]) => ({ id: e.id, name: e.name })).sort((x, y) => x.name.localeCompare(y.name));
}

/** Vendors with two or more signed in plans that have no short name: CLIProxyAPI picks among them. */
export function unnamedPlans(accounts: AccountDto[]): Array<{ vendor: string; vendorName: string; count: number; plans: AccountDto[] }> {
  const out: Array<{ vendor: string; vendorName: string; count: number; plans: AccountDto[] }> = [];
  for (const vendor of [...new Set(accounts.map((a) => a.vendor))]) {
    const subs = accounts.filter((a) => a.vendor === vendor && a.kind === 'subscription');
    const plans = subs.filter((a) => !a.prefix);
    if (plans.length >= 2) out.push({ vendor, vendorName: subs[0].vendorName, count: subs.length, plans });
  }
  return out;
}

/** "You have 2 Claude plans. Give each a short name so Conclave can pick one (Refusal fallback, Window starter)." */
export function unnamedLine(g: { vendorName: string; count: number }): string {
  return `You have ${g.count} ${g.vendorName} plans. Give each a short name so Conclave can pick one (Refusal fallback, Window starter).`;
}

// ---------------------------------------------------------------------------
// Window starter (core/src/accounts/starter.ts)
// ---------------------------------------------------------------------------

/** The note shown once, when the owner first turns a window starter on. */
export const STARTER_NOTE = 'Some providers limit automated use of subscription accounts. This sends one tiny request per window. Use at your own risk.';

/** "09:00" today, "yesterday 21:40", "22 Oct": when it last started a window. */
export function sinceWords(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hm(d);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${hm(d)}`;
  return `${d.getDate()} ${MONTH[d.getMonth()]}`;
}

/** "tomorrow", "07:00" later today, else the reset words: how long a stop lasts. */
function untilWords(ts: number, now: number): string {
  const d = new Date(ts);
  const t = new Date(now);
  if (d.toDateString() === t.toDateString()) return hm(d);
  t.setDate(t.getDate() + 1);
  if (d.toDateString() === t.toDateString()) return 'tomorrow';
  return resetWords(ts, now);
}

const SETUP_WORDS: Record<string, string> = {
  'Cannot pin a request to it': `Cannot reach this account alone. Give it a short name in ${SHORT_NAME_WHERE}.`,
  'Pick a model': 'No model to ask. Pick one.',
};

/**
 * The starter's line on an account row: "Next start 14:03. Started 09:00.",
 * "Stopped until tomorrow: 429.", "Paused: weekly limit used up until Tue
 * 10:00." Empty when it is off.
 */
export function starterLine(s: StarterDto | undefined, now = Date.now()): { text: string; tone: Tone } {
  if (!s?.enabled) return { text: '', tone: 'dim' };
  switch (s.state) {
    case 'scheduled': {
      // a time already past means it goes now
      const next = s.nextAt ? (s.nextAt <= now ? 'Starting now.' : `Next start ${resetWords(s.nextAt, now)}.`) : '';
      if (s.failures) return { text: `Failed: ${(s.reason ?? 'error').toLowerCase()}. Next try ${s.nextAt ? resetWords(s.nextAt, now) : 'soon'}.`, tone: 'warn' };
      return { text: [next, s.startedAt ? `Started ${sinceWords(s.startedAt, now)}.` : ''].filter(Boolean).join(' '), tone: 'ok' };
    }
    case 'checking':
      return { text: 'Sent its request. Checking that the window started.', tone: 'live' };
    case 'stopped':
      return { text: `Stopped until ${s.until ? untilWords(s.until, now) : 'tomorrow'}: ${s.reason ?? 'error'}.`, tone: 'fault' };
    case 'paused':
      return { text: `Paused: weekly limit used up${s.until ? ` until ${resetWords(s.until, now)}` : ''}.`, tone: 'warn' };
    case 'never':
      return { text: 'This plan has no 5-hour window, so there is nothing to start.', tone: 'dim' };
    case 'setup':
      return { text: SETUP_WORDS[s.reason ?? ''] ?? `${s.reason ?? 'Cannot run as set'}.`, tone: 'warn' };
    case 'waiting':
      if (s.reason === 'No usage read yet') return { text: 'Waiting for the first usage read.', tone: 'dim' };
      if (s.reason === 'Account paused') return { text: 'Waits while the account is paused.', tone: 'dim' };
      return { text: `Waiting: ${s.reason ?? 'not signed in'}.`, tone: 'dim' };
    default:
      return { text: '', tone: 'dim' };
  }
}
