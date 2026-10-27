/**
 * Kiro plan usage from the kiro4cpa plugin's quota provider, which CLIProxyAPI
 * serves at GET /v8/management/plugins/kiro4cpa/quota?auth_index= (server/src/
 * cliproxy/management.ts pluginQuota). The plugin calls Kiro's
 * q.<region>.amazonaws.com/getUsageLimits with the account's own token and
 * answers in CLIProxyAPI's normalized quota shape (kiro4cpa 1.0.5
 * internal/kiro/quota.go quotaResponse, sdk/pluginapi QuotaFetchResponse):
 *
 *   { subscription: { plan: "KIRO PRO" },
 *     summary: [{ key: "agentic_request_used", value }, { key: "agentic_request_limit", value }],
 *     groups: [{ displayName: "Credits", buckets: [
 *       { window: "monthly", remainingFraction, resetTime, description: "used / limit" },
 *       { window: "free_trial", ... }, { window: "<bonus>", ... } ] }] }
 *
 * The summary is the total usable credit (monthly plus the active free trial
 * and bonuses), two entries per group in group order; Kiro answers until that
 * runs out, so it is the window. The reset is the monthly bucket's.
 */
import type { LimitWindow } from '../../types';

/** "KIRO PRO+" -> "Pro+"; the vendor name already says Kiro. */
function planName(title: string): string {
  return title
    .replace(/^kiro\s+/i, '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function mapKiroQuota(json: Record<string, any> | undefined): { plan?: string; windows: LimitWindow[] } {
  if (!json || typeof json !== 'object') return { windows: [] };
  const title = typeof json.subscription?.plan === 'string' ? json.subscription.plan.trim() : '';
  const summary: Array<Record<string, any>> = Array.isArray(json.summary) ? json.summary.filter((m: unknown) => !!m && typeof m === 'object') : [];
  const used = summary.filter((m) => typeof m.key === 'string' && m.key.endsWith('_used'));
  const limits = summary.filter((m) => typeof m.key === 'string' && m.key.endsWith('_limit'));
  const groups: Array<Record<string, any>> = Array.isArray(json.groups) ? json.groups.filter((g: unknown) => !!g && typeof g === 'object') : [];
  const windows: LimitWindow[] = [];
  groups.forEach((g, i) => {
    const buckets: Array<Record<string, any>> = Array.isArray(g.buckets) ? g.buckets.filter((b: unknown) => !!b && typeof b === 'object') : [];
    const monthly = buckets.find((b) => b.window === 'monthly');
    const reset = typeof monthly?.resetTime === 'string' ? Date.parse(monthly.resetTime) : NaN;
    const u = num(used[i]?.value);
    const l = num(limits[i]?.value);
    const fraction = num(monthly?.remainingFraction);
    const usedPercent = u !== undefined && l ? (u / l) * 100 : fraction !== undefined ? (1 - fraction) * 100 : undefined;
    if (usedPercent === undefined) return;
    windows.push({
      // one group in practice (the plugin asks for AGENTIC_REQUEST only); any other gets its own name
      name: i === 0 ? 'monthly' : `monthly ${String(g.displayName ?? i).toLowerCase()}`,
      usedPercent: Math.round(Math.min(100, Math.max(0, usedPercent)) * 100) / 100,
      ...(u !== undefined && l ? { remaining: Math.max(0, l - u), limit: l } : {}),
      ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
    });
  });
  return { ...(title ? { plan: planName(title) } : {}), windows };
}
