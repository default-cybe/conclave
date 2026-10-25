/**
 * Google AI plan (Antigravity) numbers from loadCodeAssist
 * (cloudcode-pa.googleapis.com/v1internal:loadCodeAssist), the call the
 * Antigravity editor makes on start. The hub reaches it only through
 * CLIProxyAPI's api-call, so the token stays there (server/src/cliproxy/
 * management.ts usageCall). The fields are the ones CLIProxyAPI's own credits
 * check reads (internal/runtime/executor/antigravity_executor_credits.go):
 *
 *   { currentTier: { id }, paidTier: { id, availableCredits: [
 *       { creditType: "GOOGLE_ONE_AI", creditAmount, minimumCreditAmountForUsage } ] } }
 *
 * Google does not expose the 5-hour and weekly windows to these clients: the
 * responses carry no quota headers and there is no usage endpoint. The credits
 * balance and the plan tier are the real numbers it does give; a 429 body
 * (QUOTA_EXHAUSTED or RATE_LIMIT_EXCEEDED with a retry delay) reaches the hub
 * as the credential's cooldown, which is how "blocked" shows.
 */
import type { LimitWindow } from '../../types';

export const ANTIGRAVITY_USAGE_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
/** The body the Antigravity editor sends: without it the endpoint answers 404. */
export const ANTIGRAVITY_USAGE_BODY = '{"metadata":{"ideType":"ANTIGRAVITY"}}';

const PLANS: Record<string, string> = {
  GOOGLE_ONE_AI_STANDARD: 'AI Standard',
  GOOGLE_ONE_AI_PREMIUM: 'AI Pro',
  GOOGLE_ONE_AI_ULTIMATE: 'AI Ultra',
  INDIVIDUAL_STANDARD: 'Standard',
  INDIVIDUAL_STANDARD_NOCC: 'Standard',
};

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * Windows and plan from the loadCodeAssist JSON. No credits on the answer:
 * no windows, and the accounts page keeps saying Google reports no usage.
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
    const minimum = num((c as Record<string, unknown>).minimumCreditAmountForUsage) ?? 0;
    windows.push({
      name: (c as Record<string, unknown>).creditType === 'GOOGLE_ONE_AI' ? 'credits' : String((c as Record<string, unknown>).creditType ?? 'credits').toLowerCase(),
      // what the plan can still spend before it hits its minimum for use
      remaining: Math.max(0, Math.round((amount - minimum) * 100) / 100),
      ...(amount < minimum ? { usedPercent: 100 } : {}),
    });
  }
  return { ...(plan ? { plan } : {}), windows };
}
