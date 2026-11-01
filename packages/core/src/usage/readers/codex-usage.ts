/**
 * ChatGPT plan limits from the backend's usage endpoint
 * (chatgpt.com/backend-api/wham/usage), the numbers Codex shows. The hub
 * reaches it only through CLIProxyAPI's api-call, so the token stays there
 * (server/src/cliproxy/management.ts usageCall).
 *
 * { plan_type, rate_limit: { allowed, limit_reached, primary_window:
 * { used_percent, limit_window_seconds, reset_after_seconds, reset_at },
 * secondary_window }, code_review_rate_limit: {...} }
 */
import type { LimitWindow } from '../../types';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const HOUR_S = 3600;

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** "5h", "7d", "30d" from a window length in seconds. */
function lengthName(seconds: number | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % HOUR_S === 0) return `${seconds / HOUR_S}h`;
  return `${Math.round(seconds / 60)}m`;
}

function resetOf(w: Record<string, unknown>, now: number): number | undefined {
  const at = num(w.reset_at ?? w.resetAt);
  if (at) return at > 1e12 ? at : at * 1000;
  const after = num(w.reset_after_seconds ?? w.resetAfterSeconds);
  return after !== undefined ? now + after * 1000 : undefined;
}

function windowsOf(limit: Record<string, any> | undefined, now: number, scope = ''): LimitWindow[] {
  if (!limit || typeof limit !== 'object') return [];
  const out: LimitWindow[] = [];
  const reached = limit.limit_reached === true || limit.allowed === false;
  for (const [key, fallback] of [['primary_window', '5h'], ['secondary_window', '7d']] as const) {
    const w = limit[key] ?? limit[key === 'primary_window' ? 'primaryWindow' : 'secondaryWindow'];
    if (!w || typeof w !== 'object') continue;
    const seconds = num(w.limit_window_seconds ?? w.limitWindowSeconds);
    const resetsAt = resetOf(w, now);
    let used = num(w.used_percent ?? w.usedPercent);
    if (used === undefined && reached && resetsAt) used = 100;
    if (used === undefined && resetsAt === undefined) continue;
    out.push({
      name: `${lengthName(seconds, fallback)}${scope ? ` ${scope}` : ''}`,
      ...(used !== undefined ? { usedPercent: Math.round(used * 10) / 10 } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(seconds ? { windowMs: seconds * 1000 } : {}),
    });
  }
  return out;
}

const PLANS: Record<string, string> = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free', go: 'Go' };

/** Windows and plan from the usage JSON. Code review limits come as "5h code review", which limits no model. */
export function mapWhamUsage(json: Record<string, any> | undefined, now = Date.now()): { plan?: string; windows: LimitWindow[] } {
  if (!json || typeof json !== 'object') return { windows: [] };
  const raw = String(json.plan_type ?? json.planType ?? '').toLowerCase();
  const plan = raw ? (PLANS[raw] ?? raw[0].toUpperCase() + raw.slice(1)) : undefined;
  const windows = [...windowsOf(json.rate_limit ?? json.rateLimit, now), ...windowsOf(json.code_review_rate_limit ?? json.codeReviewRateLimit, now, 'code review')];
  return { ...(plan ? { plan } : {}), windows };
}
