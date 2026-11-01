/**
 * Z.ai (GLM) Coding Plan quota.
 *
 * GET https://api.z.ai/api/monitor/usage/quota/limit with the raw API key in
 * the Authorization header (no "Bearer"). The Chinese platform serves the same
 * at open.bigmodel.cn. Response:
 *   { code: 200, success: true, data: { limits: [
 *       { type: "TOKENS_LIMIT", unit: 3, number: 5, usage, currentValue, remaining, percentage, nextResetTime },
 *       { type: "TIME_LIMIT", ... } ] } }
 * TOKENS_LIMIT entries are prompt windows (unit 3 = hours, so 3/5 is the 5h
 * window; unit 6 is reported as the weekly window). `usage` is the window's
 * total, `currentValue` what is used, `percentage` 0..100, `nextResetTime` ms.
 * TIME_LIMIT is the monthly quota for MCP tools (web search, reader).
 * Since Oct 2026 the plan answers CREDIT_LIMIT entries instead of
 * TOKENS_LIMIT: the 5 hour window first (no nextResetTime until a prompt
 * starts it), then the weekly one. They are told apart by size, not order:
 * the smaller limit (or a reset within 6 hours) is 5h, the larger 7d.
 * Field meanings are community documented, not official.
 */
import type { LimitState, LimitWindow } from '../../types';

export const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit';

export interface ZaiOptions {
  /** Provider base URL from config; only its origin is used. Default https://api.z.ai */
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}

/** Origin for the quota endpoint from a provider base URL like https://api.z.ai/api/anthropic. */
export function zaiQuotaUrl(baseUrl?: string): string {
  let origin = 'https://api.z.ai';
  if (baseUrl) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      // keep default
    }
  }
  if (/bigmodel\.cn$/.test(new URL(origin).hostname)) origin = 'https://open.bigmodel.cn';
  return origin + ZAI_QUOTA_PATH;
}

function tokensWindowName(unit: unknown, number: unknown, index: number): string {
  const n = typeof number === 'number' && number > 0 ? number : 1;
  switch (unit) {
    case 1:
      return `${n}d`;
    case 3:
      return `${n}h`;
    case 5:
      return `${n}m`;
    case 6:
      return n === 1 ? '7d' : `${n}w`;
    default:
      return index === 0 ? '5h' : index === 1 ? '7d' : `tokens ${index + 1}`;
  }
}

/** Two CREDIT_LIMIT entries: the 5 hour one is the smaller (or resets within 6 hours), the other the week, whatever their order. */
function nameCredits(limits: unknown, windows: LimitWindow[], now: number): void {
  const list = Array.isArray(limits) ? limits.filter((l) => l && typeof l === 'object') : [];
  const credits = windows.filter((_, i) => list[i]?.type === 'CREDIT_LIMIT' && list[i]?.unit === undefined);
  if (credits.length !== 2) return;
  const soon = (w: LimitWindow) => w.resetsAt !== undefined && w.resetsAt - now <= 6 * 3_600_000;
  const [a, b] = credits;
  const aFirst = soon(a) !== soon(b) ? soon(a) : (a.limit ?? 0) <= (b.limit ?? 0);
  (aFirst ? a : b).name = '5h';
  (aFirst ? b : a).name = '7d';
}

export function mapZaiQuota(json: Record<string, any>, now = Date.now()): LimitState {
  const limits: Array<Record<string, any>> = json?.data?.limits ?? json?.limits ?? [];
  const windows: LimitWindow[] = [];
  let tokenIndex = 0;
  for (const l of Array.isArray(limits) ? limits : []) {
    if (!l || typeof l !== 'object') continue;
    const base: LimitWindow = { name: '' };
    if (typeof l.percentage === 'number') base.usedPercent = l.percentage;
    if (typeof l.usage === 'number') base.limit = l.usage;
    if (typeof l.remaining === 'number') base.remaining = l.remaining;
    else if (typeof l.usage === 'number' && typeof l.currentValue === 'number') base.remaining = Math.max(0, l.usage - l.currentValue);
    if (base.usedPercent === undefined && typeof l.usage === 'number' && l.usage > 0 && typeof l.currentValue === 'number') {
      base.usedPercent = Math.round((l.currentValue / l.usage) * 1000) / 10;
    }
    if (typeof l.nextResetTime === 'number' && l.nextResetTime > 0) base.resetsAt = l.nextResetTime < 1e12 ? l.nextResetTime * 1000 : l.nextResetTime;
    if (l.type === 'TOKENS_LIMIT' || l.type === 'CREDIT_LIMIT') base.name = tokensWindowName(l.unit, l.number, tokenIndex++);
    else if (l.type === 'TIME_LIMIT') base.name = 'MCP monthly';
    else base.name = String(l.type ?? 'limit').toLowerCase().replace(/_/g, ' ');
    windows.push(base);
  }
  nameCredits(limits, windows, now);
  return {
    provider: 'zai',
    label: 'Z.ai Coding Plan',
    windows,
    updatedAt: now,
    blocked: windows.some((w) => w.name !== 'MCP monthly' && (w.usedPercent ?? 0) >= 100),
    source: 'api',
  };
}

export async function fetchZaiLimits(apiKey: string, opts: ZaiOptions = {}): Promise<LimitState> {
  const doFetch = opts.fetch ?? fetch;
  const url = zaiQuotaUrl(opts.baseUrl);
  const call = (auth: string) =>
    doFetch(url, {
      method: 'GET',
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  let res = await call(apiKey);
  if (res.status === 401) res = await call(`Bearer ${apiKey}`);
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Z.ai quota endpoint returned ${res.status}${body ? `: ${body}` : ''}`);
  }
  const json = (await res.json()) as Record<string, any>;
  if (json.success === false || (typeof json.code === 'number' && json.code !== 200)) {
    throw new Error(`Z.ai quota endpoint error ${json.code ?? ''}: ${json.msg ?? 'unknown'}`);
  }
  return mapZaiQuota(json, opts.now ?? Date.now());
}
