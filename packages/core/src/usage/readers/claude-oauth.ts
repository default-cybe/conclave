/**
 * Claude subscription limits from Anthropic's OAuth usage endpoint, the same
 * numbers Claude Code shows in /usage. Opt-in: it reads Claude Code's OAuth
 * token from the device (~/.claude/.credentials.json, or the macOS keychain)
 * and calls api.anthropic.com with it. The token is never refreshed here,
 * since rotating it would log Claude Code out.
 */
import type { LimitState, LimitWindow } from '../../types';
import type { Machine } from '../../machine/types';
import { claudeRootOn, joinPath, parseTime } from '../../importers/files';

export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** kv flag the engine or settings page sets to enable this reader. */
export const CLAUDE_OAUTH_FLAG = 'usage.claudeOAuth.enabled';

export interface ClaudeOAuthToken {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
}

export interface ClaudeOAuthOptions {
  fetch?: typeof fetch;
  now?: number;
  /** Override ~/.claude. */
  root?: string;
  timeoutMs?: number;
}

function parseCredentials(text: string): ClaudeOAuthToken | undefined {
  try {
    const j = JSON.parse(text);
    const o = j?.claudeAiOauth ?? j;
    if (typeof o?.accessToken !== 'string' || !o.accessToken) return undefined;
    return {
      accessToken: o.accessToken,
      ...(typeof o.expiresAt === 'number' ? { expiresAt: o.expiresAt } : {}),
      ...(typeof o.subscriptionType === 'string' ? { subscriptionType: o.subscriptionType } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Find Claude Code's OAuth token on a device. */
export async function readClaudeOAuthToken(machine: Machine, root?: string): Promise<ClaudeOAuthToken | undefined> {
  const file = joinPath(root ?? claudeRootOn(machine), '.credentials.json');
  try {
    const tok = parseCredentials(await machine.readText(file));
    if (tok) return tok;
  } catch {
    // not there; try the keychain
  }
  if (root) return undefined;
  try {
    const info = await machine.info();
    if (info.platform !== 'darwin') return undefined;
    const res = await machine.exec('security find-generic-password -s "Claude Code-credentials" -w', { cwd: info.home, timeoutMs: 10_000 });
    if (res.exitCode === 0) return parseCredentials(res.stdout.trim());
  } catch {
    // no keychain access
  }
  return undefined;
}

/**
 * The endpoint's windows. iguana_necktie is the weekly Fable window (the
 * official management panel labels it so); seven_day_oauth_apps and
 * seven_day_cowork only inform, they limit no model of their own.
 */
const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d opus',
  seven_day_sonnet: '7d sonnet',
  iguana_necktie: '7d fable',
  seven_day_oauth_apps: '7d oauth apps',
  seven_day_cowork: '7d cowork',
};

const dollars = (w: Record<string, unknown>) => ['limit_dollars', 'used_dollars', 'remaining_dollars'].some((k) => typeof w[k] === 'number');

/** The weekly Fable window from the newer limits[] list ({kind: weekly_scoped, scope: {model: {display_name: Fable}}}). */
function fableLimit(json: Record<string, any>): { percent: number; resetsAt?: unknown } | undefined {
  if (!Array.isArray(json?.limits)) return undefined;
  const all = (json.limits as Array<Record<string, any>>).filter(
    (l) => l?.kind === 'weekly_scoped' && /^fable( \d+)?$/i.test(String(l?.scope?.model?.display_name ?? '').trim()) && typeof l?.percent === 'number',
  );
  const l = all.find((x) => x.is_active === true) ?? all[0];
  return l ? { percent: l.percent, resetsAt: l.resets_at } : undefined;
}

/** Map the endpoint's JSON ({five_hour: {utilization, resets_at}, ...}) to a LimitState. */
export function mapClaudeOAuthUsage(json: Record<string, any>, now = Date.now(), subscriptionType?: string): LimitState {
  const windows: LimitWindow[] = [];
  const fable = fableLimit(json);
  for (const [key, name] of Object.entries(WINDOW_NAMES)) {
    const w = json?.[key];
    if (!w || typeof w !== 'object' || typeof w.utilization !== 'number') continue;
    const resetsAt = w.resets_at ? parseTime(w.resets_at, 0) : 0;
    // a Fable window counted in dollars is a credit pool, not a weekly limit
    if (key === 'iguana_necktie' && dollars(w)) {
      windows.push({ name: 'fable credits', usedPercent: Math.round(w.utilization * 10) / 10, ...(resetsAt ? { resetsAt } : {}), ...(typeof w.limit_dollars === 'number' ? { limit: w.limit_dollars } : {}), ...(typeof w.remaining_dollars === 'number' ? { remaining: w.remaining_dollars } : {}) });
      continue;
    }
    if (key === 'iguana_necktie' && fable) continue;
    windows.push({ name, usedPercent: Math.round(w.utilization * 10) / 10, ...(resetsAt ? { resetsAt } : {}) });
  }
  if (fable) {
    const resetsAt = fable.resetsAt ? parseTime(fable.resetsAt as string, 0) : 0;
    windows.push({ name: '7d fable', usedPercent: Math.round(fable.percent * 10) / 10, ...(resetsAt ? { resetsAt } : {}) });
  }
  const extra = json?.extra_usage;
  if (extra && typeof extra === 'object' && extra.is_enabled && typeof extra.utilization === 'number') {
    const limit = typeof extra.monthly_limit === 'number' ? extra.monthly_limit : undefined;
    const used = typeof extra.used_credits === 'number' ? extra.used_credits : undefined;
    windows.push({
      name: 'extra usage',
      usedPercent: Math.round(extra.utilization * 10) / 10,
      ...(limit !== undefined ? { limit } : {}),
      ...(limit !== undefined && used !== undefined ? { remaining: Math.max(0, limit - used) } : {}),
    });
  }
  const plan = subscriptionType ? subscriptionType[0].toUpperCase() + subscriptionType.slice(1) : 'subscription';
  return {
    provider: 'claude-max',
    label: `Claude ${plan} (OAuth)`,
    windows,
    updatedAt: now,
    // a full model window (7d opus) limits that model only, not the plan
    blocked: windows.some((w) => (w.name === '5h' || w.name === '7d') && (w.usedPercent ?? 0) >= 100),
    source: 'oauth',
  };
}

/**
 * The plan from the OAuth profile endpoint (/api/oauth/profile): "Max 20x",
 * "Max 5x", "Max", "Pro", "Team", "Free". Undefined when it does not say.
 */
export function mapClaudeProfile(json: Record<string, any> | undefined): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const org = json.organization ?? {};
  const acct = json.account ?? {};
  const tier = String(org.rate_limit_tier ?? acct.rate_limit_tier ?? '').toLowerCase();
  const x = /max_(\d+)x/.exec(tier);
  if (String(org.organization_type ?? '').toLowerCase() === 'claude_team' && String(org.subscription_status ?? '').toLowerCase() === 'active') return 'Team';
  if (x) return `Max ${x[1]}x`;
  const flag = (v: unknown) => v === true || v === 1 || v === 'true';
  if (flag(acct.has_claude_max)) return 'Max';
  if (flag(acct.has_claude_pro)) return 'Pro';
  if (acct.has_claude_max === false && acct.has_claude_pro === false) return 'Free';
  return undefined;
}

/** Read the token from the device and fetch current limits. Throws with a readable message on failure. */
export async function fetchClaudeOAuthLimits(machine: Machine, opts: ClaudeOAuthOptions = {}): Promise<LimitState> {
  const now = opts.now ?? Date.now();
  const tok = await readClaudeOAuthToken(machine, opts.root);
  if (!tok) throw new Error(`No Claude Code login found on ${machine.name}`);
  if (tok.expiresAt && tok.expiresAt < now) throw new Error(`Claude Code's login token on ${machine.name} expired; run claude there to refresh it`);
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(CLAUDE_OAUTH_USAGE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${tok.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      accept: 'application/json',
      'user-agent': 'conclave/0.1',
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Claude usage endpoint returned ${res.status}${body ? `: ${body}` : ''}`);
  }
  return mapClaudeOAuthUsage((await res.json()) as Record<string, any>, now, tok.subscriptionType);
}
