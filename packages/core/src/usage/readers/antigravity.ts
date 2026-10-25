/**
 * Google AI plan (Antigravity) tier and paid-credit balance from loadCodeAssist
 * (cloudcode-pa.googleapis.com/v1internal:loadCodeAssist). The hub reaches it only through
 * CLIProxyAPI's api-call, so the token stays there (server/src/cliproxy/
 * management.ts usageCall). The fields are the ones CLIProxyAPI's own credits
 * check reads (internal/runtime/executor/antigravity_executor_credits.go):
 *
 *   { currentTier: { id }, paidTier: { id, availableCredits: [
 *       { creditType: "GOOGLE_ONE_AI", creditAmount, minimumCreditAmountForUsage } ] } }
 *
 * Credits govern optional paid-credit spending, not ordinary model access.
 * Keep the raw balance informational; it is not a subscription quota.
 *
 * The 5-hour and weekly quota come from retrieveUserQuotaSummary on the daily
 * and prod hosts (as CLIProxyAPI's management center and AIUsage read it):
 *
 *   { groups: [{ buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction, resetTime, disabled }] }] }
 *
 * gemini-* buckets limit Gemini models; 3p-* buckets limit the Claude and GPT
 * models of the same account.
 */
import type { LimitWindow } from '../../types';

export const ANTIGRAVITY_USAGE_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
/** Matches CLIProxyAPI's loadCodeAssist credits request. */
export const ANTIGRAVITY_USAGE_BODY = '{"metadata":{"ideType":"ANTIGRAVITY"}}';

const PLANS: Record<string, string> = {
  GOOGLE_ONE_AI_STANDARD: 'AI Standard',
  GOOGLE_ONE_AI_PREMIUM: 'AI Pro',
  GOOGLE_ONE_AI_ULTIMATE: 'AI Ultra',
  INDIVIDUAL_STANDARD: 'Standard',
  INDIVIDUAL_STANDARD_NOCC: 'Standard',
};

export const ANTIGRAVITY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
] as const;

const PROJECT = /^[\w.:-]{1,128}$/;

/** The Cloud Code project from loadCodeAssist (a string or { id }), when it is an id. */
export function antigravityProject(json: Record<string, any> | undefined): string | undefined {
  const p = json?.cloudaicompanionProject;
  const id = typeof p === 'string' ? p : typeof p?.id === 'string' ? p.id : undefined;
  return id && PROJECT.test(id) ? id : undefined;
}

const WINDOWS: Record<string, string> = { '5h': '5h', weekly: '7d' };

/**
 * Quota windows from retrieveUserQuotaSummary answers (daily and prod). Per
 * bucket the lower remaining wins: one host may leave the Gemini group out.
 * Disabled buckets are skipped (the 5h one reads full while the week is spent).
 */
export function mapAntigravityQuota(answers: Array<Record<string, any> | undefined>): LimitWindow[] {
  const best = new Map<string, { name: string; left: number; resetsAt?: number }>();
  for (const json of answers) {
    if (!json || typeof json !== 'object') continue;
    const buckets: unknown[] = [
      ...(Array.isArray(json.buckets) ? json.buckets : []),
      ...(Array.isArray(json.groups) ? json.groups.flatMap((g: any) => (Array.isArray(g?.buckets) ? g.buckets : [])) : []),
    ];
    for (const b of buckets as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object' || b.disabled === true || typeof b.bucketId !== 'string') continue;
      const id = b.bucketId.toLowerCase();
      const win = typeof b.window === 'string' ? b.window.toLowerCase() : /-(5h|weekly)$/.exec(id)?.[1];
      const len = win ? WINDOWS[win] : undefined;
      const scope = id.replace(/-(5h|weekly)$/, '');
      if (!len || !scope) continue;
      const reset = typeof b.resetTime === 'string' ? Date.parse(b.resetTime) : NaN;
      // proto3 leaves a zero fraction out: with a reset ahead, nothing is left
      const left = num(b.remainingFraction) ?? (Number.isFinite(reset) ? 0 : undefined);
      if (left === undefined) continue;
      const prev = best.get(id);
      if (prev && prev.left <= left) continue;
      // a full window has not started: its reset time means nothing yet
      best.set(id, { name: `${len} ${scope}`, left, ...(left < 1 && Number.isFinite(reset) ? { resetsAt: reset } : {}) });
    }
  }
  return [...best.values()].map((b) => ({
    name: b.name,
    usedPercent: Math.round((1 - Math.min(1, Math.max(0, b.left))) * 10_000) / 100,
    ...(b.resetsAt !== undefined ? { resetsAt: b.resetsAt } : {}),
  }));
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * Plan and informational balances from loadCodeAssist. Missing balances stay unknown.
 */
export function mapAntigravityUsage(json: Record<string, any> | undefined): { plan?: string; windows: LimitWindow[] } {
  if (!json || typeof json !== 'object') return { windows: [] };
  const tier = String(json.paidTier?.id ?? json.currentTier?.id ?? '').toUpperCase();
  const plan = tier ? (PLANS[tier] ?? tier.toLowerCase().replace(/_/g, ' ')) : undefined;
  const credits: unknown[] = Array.isArray(json.paidTier?.availableCredits) ? json.paidTier.availableCredits : [];
  const windows: LimitWindow[] = [];
  for (const c of credits) {
    if (!c || typeof c !== 'object') continue;
    const amount = num((c as Record<string, unknown>).creditAmount);
    if (amount === undefined) continue;
    windows.push({
      name: (c as Record<string, unknown>).creditType === 'GOOGLE_ONE_AI' ? 'credits' : String((c as Record<string, unknown>).creditType ?? 'credits').toLowerCase(),
      kind: 'extra',
      remaining: amount,
    });
  }
  return { ...(plan ? { plan } : {}), windows };
}
