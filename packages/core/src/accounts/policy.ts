/**
 * Which account takes the next call: the owner's order, skipping accounts
 * that are hard blocked (paused, signed out, a full window, a CLIProxyAPI
 * cooldown, a spent budget). Pure: the clock and every number come in, so
 * the tests can play the owner's week at fixed times.
 *
 * This is phase 2 of the accounts plan (docs/research/2026-10-20-next-features.md
 * section 1): a static order. Phase 4, the Router, adds soft skips (a weekly
 * window above 90% with a far reset), use before reset, and cache aware
 * stickiness on top of assess() and the order; the hard blocks stay as here.
 */
import type { AccountState } from '../client/accounts';
import type { AccountRoute } from '../config/schema';
import type { LimitWindow } from '../types';
import { wirePattern } from '../providers/split';
import { variantBase } from '../providers/model-id';
import { annotateWindow, governing, windowFull, windowScope } from './windows';

export interface AccountView {
  id: string;
  kind: 'subscription' | 'api';
  enabled: boolean;
  /** Signed out, refused, or no key: in words. */
  error?: string;
  windows: LimitWindow[];
  cooldowns?: Array<{ model?: string; reason: string; until: number }>;
  /** Model ids it reaches. Undefined when not known yet: then any. */
  models?: string[];
  budget?: { usd: number; spentUsd: number; periodEnd: number; hardStop?: boolean };
  /** A block the hub saw itself (a 429 a moment ago), until then. */
  blockedUntil?: number;
}

export interface Verdict {
  id: string;
  state: AccountState;
  /** Why it is not usable, in words. */
  reason?: string;
  /** When it is usable again. */
  until?: number;
  /** The fullest window that applies, for "resets Tue 10:00, 45% left". */
  window?: LimitWindow;
}

export interface PickResult {
  /** The account to use, or undefined when none can take the call. */
  account?: string;
  verdicts: Verdict[];
  /** Accounts before it in the order and why each was passed over. */
  skipped: Array<{ account: string; reason: string }>;
  /** Nothing usable: when the first account opens again. */
  until?: number;
}

export const usable = (v: Pick<Verdict, 'state'>): boolean => v.state === 'ready' || v.state === 'unknown';

const COOLDOWN_WORDS: Record<string, string> = {
  quota: 'Hit its limit',
  credential_quota: 'Hit its limit',
  unauthorized: 'Signed out',
  invalid_grant: 'Signed out',
  payment_required: 'The plan refused',
  model_not_supported: 'Does not offer this model',
  transient_error: 'Resting after provider errors',
  cloudflare_challenge: 'Blocked by a challenge page',
};

function fullWords(w: LimitWindow): string {
  const scope = windowScope(w.name);
  const name = w.kind === 'session' ? '5 hour' : w.kind === 'weekly' ? 'Weekly' : w.kind === 'monthly' ? 'Monthly' : w.kind === 'rate' ? 'Rate' : w.name;
  const of = scope ? ` ${scope[0].toUpperCase()}${scope.slice(1)}` : '';
  return `${name}${of} limit reached`;
}

/** Strip a CLIProxyAPI account prefix: "neu/claude-opus-5-5" -> "claude-opus-5-5". */
export function bareModel(model: string): string {
  const i = model.lastIndexOf('/');
  return i < 0 ? model : model.slice(i + 1);
}

/** The plan's own id for a model: the id, else an effort or thinking variant it lists instead (Antigravity's "claude-opus-5-5-high"). With exact, only the id. */
export function ownModel(models: string[], model: string, exact = false): string | undefined {
  const want = bareModel(model).toLowerCase();
  return models.find((m) => bareModel(m).toLowerCase() === want) ?? (exact ? undefined : models.find((m) => variantBase(bareModel(m)).toLowerCase() === want));
}

/** Whether the account offers the model, or a variant of it. Unknown lists offer everything. */
export function reaches(a: Pick<AccountView, 'models'>, model?: string): boolean {
  if (!model || !a.models) return true;
  return ownModel(a.models, model) !== undefined;
}

/** One account's state now, for a model when given (a weekly Opus window only blocks Opus). */
export function assess(a: AccountView, now: number, model?: string): Verdict {
  const v: Verdict = { id: a.id, state: 'ready' };
  const windows = governing(a.windows.map((w) => (w.kind ? w : annotateWindow(w))), model);
  const known = windows.filter((w) => w.usedPercent !== undefined && w.kind !== 'rate' && w.kind !== 'extra' && !(w.resetsAt !== undefined && w.resetsAt <= now));
  const fullest = [...known].sort((x, y) => (y.usedPercent ?? 0) - (x.usedPercent ?? 0))[0];
  if (fullest) v.window = fullest;
  if (!a.enabled) return { ...v, state: 'paused', reason: 'Paused' };
  if (a.error) return { ...v, state: 'error', reason: a.error };
  if (a.budget && a.budget.hardStop !== false && a.budget.usd > 0 && a.budget.spentUsd >= a.budget.usd) {
    return { ...v, state: 'budget', reason: 'Budget spent', until: a.budget.periodEnd };
  }
  const cooling = (a.cooldowns ?? []).filter((c) => c.until > now && (!c.model || !model || bareModel(c.model) === bareModel(model)));
  if (cooling.length) {
    const last = cooling.reduce((x, y) => (y.until > x.until ? y : x));
    return { ...v, state: 'cooldown', reason: COOLDOWN_WORDS[last.reason] ?? 'Resting after errors', until: last.until };
  }
  const full = windows.filter((w) => windowFull(w, now));
  if (full.length) {
    // every full window must reset before a call goes through
    const resets = full.map((w) => w.resetsAt).filter((t): t is number => t !== undefined);
    const worst = full.reduce((x, y) => ((y.resetsAt ?? Infinity) > (x.resetsAt ?? Infinity) ? y : x));
    return { ...v, state: 'limited', reason: fullWords(worst), window: worst, ...(resets.length === full.length ? { until: Math.max(...resets) } : {}) };
  }
  if (a.blockedUntil && a.blockedUntil > now) return { ...v, state: 'limited', reason: 'Refused the last call', until: a.blockedUntil };
  // a subscription with no numbers yet is usable, but says so; missing windows are unknown, not zero
  if (a.kind === 'subscription' && !known.length) return { ...v, state: 'unknown' };
  return v;
}

/** The first usable account in the order that offers the model. */
export function pickAccount(ordered: AccountView[], now: number, model?: string): PickResult {
  const verdicts = ordered.map((a) => assess(a, now, model));
  const skipped: PickResult['skipped'] = [];
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const v = verdicts[i];
    if (!reaches(a, model)) {
      skipped.push({ account: a.id, reason: 'Does not offer this model' });
      continue;
    }
    if (usable(v)) return { account: a.id, verdicts, skipped };
    skipped.push({ account: a.id, reason: v.reason ?? 'Not usable' });
  }
  const opens = verdicts.filter((v, i) => v.until && v.state !== 'paused' && reaches(ordered[i], model)).map((v) => v.until!);
  return { verdicts, skipped, ...(opens.length ? { until: Math.min(...opens) } : {}) };
}

/** The order for a vendor: the route's ids first (unknown ids dropped), then the rest, subscriptions before API keys. */
export function orderIds(accounts: Array<{ id: string; kind: 'subscription' | 'api' }>, order?: string[]): string[] {
  const known = new Set(accounts.map((a) => a.id));
  const head = [...new Set((order ?? []).filter((id) => known.has(id)))];
  const rest = accounts.filter((a) => !head.includes(a.id));
  return [...head, ...rest.filter((a) => a.kind === 'subscription').map((a) => a.id), ...rest.filter((a) => a.kind === 'api').map((a) => a.id)];
}

/** The route for a model: one whose match picks it, else the vendor's default. */
export function routeFor(routes: AccountRoute[] | undefined, vendor: string, model?: string): AccountRoute | undefined {
  const mine = (routes ?? []).filter((r) => r.vendor === vendor && Array.isArray(r.order));
  if (model) {
    const bare = bareModel(model);
    const hit = mine.find((r) => r.match && wirePattern(r.match).test(bare));
    if (hit) return hit;
  }
  return mine.find((r) => !r.match);
}

/**
 * CLIProxyAPI priorities from an order of subscription credentials: the
 * first gets the highest. Only the highest ready tier is used, so this is
 * "Account 1, then Account 2".
 */
export function priorities(orderedCredentials: string[]): Map<string, number> {
  const n = orderedCredentials.length;
  return new Map(orderedCredentials.map((name, i) => [name, n - i]));
}
