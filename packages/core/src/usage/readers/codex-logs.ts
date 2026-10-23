/**
 * Codex usage and rate limits from its rollout logs
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 *
 * `event_msg` lines of type `token_count` carry info.total_token_usage (running
 * total for the session), info.last_token_usage (the latest API call) and
 * rate_limits (primary 5h window and secondary weekly window). Codex repeats
 * token_count events without new usage, so records are keyed by the running
 * total, which only grows when a new call happened.
 */
import type { LimitState, LimitWindow } from '../../types';
import { baseName, codexRootOn, joinPath, parseTime, walkFiles } from '../../importers/files';
import { codexIdFromPath } from '../../importers/codex';
import { num, scanIncremental, type ExtUsage, type ReaderContext } from './common';

export const CODEX_SOURCE = 'codex';
const DEFAULT_MODEL = 'gpt-5';

export interface CodexRateWindow {
  used_percent?: number;
  window_minutes?: number | null;
  resets_at?: number | null;
  resets_in_seconds?: number | null;
}

/** The latest rate limit snapshot seen, with absolute reset times already resolved. */
export interface CodexRateSnapshot {
  ts: number;
  limitId?: string;
  limitName?: string;
  planType?: string;
  reached?: string;
  primary?: { usedPercent: number; windowMinutes?: number; resetsAt?: number };
  secondary?: { usedPercent: number; windowMinutes?: number; resetsAt?: number };
}

export async function readCodexUsage(ctx: ReaderContext): Promise<{ records: ExtUsage[]; snapshots: CodexRateSnapshot[]; files: number }> {
  const root = joinPath(ctx.root ?? codexRootOn(ctx.machine), 'sessions');
  const files = await walkFiles(ctx.machine, root, { match: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), maxDepth: 3 });
  const records: ExtUsage[] = [];
  const latest = new Map<string, CodexRateSnapshot>();
  const read = await scanIncremental(
    ctx,
    CODEX_SOURCE,
    files,
    (file, lines, state) => {
      const x = (state.x ??= {}) as { sid?: string; model?: string; total?: number; totals?: TokenUsage; cwd?: string };
      x.sid ??= codexIdFromPath(file.path) ?? baseName(file.path);
      for (const { value: l } of lines) {
        const p = l.payload ?? {};
        if (l.type === 'session_meta' && typeof p.id === 'string') {
          x.sid = p.id;
          if (typeof p.cwd === 'string' && p.cwd) x.cwd = p.cwd;
        } else if (l.type === 'turn_context') {
          if (typeof p.model === 'string') x.model = p.model;
          if (typeof p.cwd === 'string' && p.cwd) x.cwd = p.cwd;
        } else if (l.type === 'event_msg' && p.type === 'token_count') {
          const ts = parseTime(l.timestamp, 0);
          const info = p.info;
          if (info?.total_token_usage) {
            const total = info.total_token_usage as TokenUsage;
            const totalTokens = num(total.total_tokens) || sumTokens(total);
            if (totalTokens > (x.total ?? 0)) {
              const last: TokenUsage | undefined = info.last_token_usage ?? (x.totals ? diff(total, x.totals) : total);
              // a turn Conclave ran over ACP and counted then is not counted again (ReaderContext.counted)
              if (last && ts && num(last.input_tokens) + num(last.output_tokens) > 0 && !ctx.counted?.(x.sid!, ts)) {
                const rec = toRecord(`${x.sid}:${totalTokens}`, ts, x.model ?? DEFAULT_MODEL, last);
                rec.record.device = ctx.machine.id;
                if (x.cwd) rec.record.cwd = x.cwd;
                records.push(rec);
              }
              x.total = totalTokens;
              x.totals = pick(total);
            }
          }
          if (p.rate_limits && ts) {
            const snap = toSnapshot(p.rate_limits, ts);
            const key = snap.limitId ?? 'codex';
            const prev = latest.get(key);
            if (!prev || snap.ts >= prev.ts) latest.set(key, snap);
          }
        }
      }
    },
    (raw) => raw.includes('"token_count"') || raw.includes('"session_meta"') || raw.includes('"turn_context"'),
  );
  return { records, snapshots: [...latest.values()], files: read };
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

function pick(t: TokenUsage): TokenUsage {
  return {
    input_tokens: num(t.input_tokens),
    cached_input_tokens: num(t.cached_input_tokens),
    cache_write_input_tokens: num(t.cache_write_input_tokens),
    output_tokens: num(t.output_tokens),
    reasoning_output_tokens: num(t.reasoning_output_tokens),
    total_tokens: num(t.total_tokens),
  };
}

function sumTokens(t: TokenUsage): number {
  return num(t.input_tokens) + num(t.output_tokens);
}

function diff(a: TokenUsage, b: TokenUsage): TokenUsage {
  const pa = pick(a);
  const pb = pick(b);
  const out: TokenUsage = {};
  for (const k of Object.keys(pa) as Array<keyof TokenUsage>) out[k] = Math.max(0, num(pa[k]) - num(pb[k]));
  return out;
}

/**
 * OpenAI counts cached tokens inside input_tokens. Conclave stores input as
 * the uncached part (Anthropic style) so cost math stays the same everywhere.
 */
function toRecord(extKey: string, ts: number, model: string, u: TokenUsage): ExtUsage {
  const cached = num(u.cached_input_tokens);
  const cacheWrite = num(u.cache_write_input_tokens);
  return {
    extKey,
    record: {
      ts,
      source: CODEX_SOURCE,
      provider: 'openai',
      model,
      inputTokens: Math.max(0, num(u.input_tokens) - cached - cacheWrite),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: num(u.reasoning_output_tokens),
    },
  };
}

function resolveWindow(w: CodexRateWindow | null | undefined, ts: number): CodexRateSnapshot['primary'] {
  if (!w || typeof w !== 'object') return undefined;
  let resetsAt: number | undefined;
  if (typeof w.resets_at === 'number') resetsAt = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;
  else if (typeof w.resets_in_seconds === 'number') resetsAt = ts + w.resets_in_seconds * 1000;
  return {
    usedPercent: num(w.used_percent),
    ...(typeof w.window_minutes === 'number' ? { windowMinutes: w.window_minutes } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

export function toSnapshot(rl: Record<string, any>, ts: number): CodexRateSnapshot {
  return {
    ts,
    ...(typeof rl.limit_id === 'string' ? { limitId: rl.limit_id } : {}),
    ...(typeof rl.limit_name === 'string' ? { limitName: rl.limit_name } : {}),
    ...(typeof rl.plan_type === 'string' ? { planType: rl.plan_type } : {}),
    ...(typeof rl.rate_limit_reached_type === 'string' ? { reached: rl.rate_limit_reached_type } : {}),
    primary: resolveWindow(rl.primary, ts),
    secondary: resolveWindow(rl.secondary, ts),
  };
}

/** "5h", "7d" and so on from a window length in minutes. */
export function windowName(minutes: number | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes >= 1440 - 30) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60 - 5) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

export function codexLimit(s: CodexRateSnapshot, now = Date.now()): LimitState {
  const windows: LimitWindow[] = [];
  for (const [w, fallback] of [
    [s.primary, '5h'],
    [s.secondary, '7d'],
  ] as const) {
    if (!w) continue;
    const expired = w.resetsAt !== undefined && w.resetsAt <= now;
    windows.push({
      name: windowName(w.windowMinutes, fallback),
      usedPercent: expired ? 0 : w.usedPercent,
      ...(w.resetsAt && !expired ? { resetsAt: w.resetsAt } : {}),
    });
  }
  const id = !s.limitId || s.limitId === 'codex' ? 'codex' : `codex-${s.limitId}`;
  const plan = s.planType ? ` ${s.planType[0].toUpperCase()}${s.planType.slice(1)}` : '';
  return {
    provider: id,
    label: `Codex${s.limitName ? ` ${s.limitName}` : ''}${plan ? ` (ChatGPT${plan})` : ''}`,
    windows,
    updatedAt: s.ts,
    blocked: windows.some((w) => (w.usedPercent ?? 0) >= 100) || (!!s.reached && windows.some((w) => w.resetsAt !== undefined)),
    source: 'logs',
  };
}
