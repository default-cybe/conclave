/**
 * The two status rows under the input, each with a left and a right side.
 * Row one: model, effort, agent and mode; the permission mode on the right.
 * Row two: where tools run (and the hub, when it is not connected); context,
 * tokens, cost and the nearest limit on the right. Pure so they can be tested.
 */
import type { LimitState, LimitWindow, PermissionMode, Session, Usage } from '@conclave/core/types.ts';
import { truncate, width as strWidth, type Painter } from '../ansi';
import { formatCost, formatDuration, formatTokens, shortenPath } from '../render/format';
import { modelColor, providerOf, shortModel } from '../render/models';

export interface HeaderInput {
  model?: string;
  /** Effort label ("high"); empty runs at the agent's. */
  effort?: string;
  agent?: string;
  mode?: string;
  permissionMode?: PermissionMode;
}

/** Left and right on one row; on a narrow terminal the right side keeps its room and the left is cut. */
export function spread(left: string, right: string, width: number): string {
  const lw = strWidth(left);
  const rw = strWidth(right);
  if (!right) return truncate(left, width);
  if (!left) return ' '.repeat(Math.max(0, width - rw)) + truncate(right, width);
  if (lw + rw + 2 <= width) return left + ' '.repeat(width - lw - rw) + right;
  const room = width - rw - 2;
  if (room >= 12) return truncate(left, room) + '  ' + right;
  return truncate(left, width);
}

export function permissionLabel(m: PermissionMode | undefined, p: Painter): string {
  switch (m) {
    case 'acceptEdits':
      return p.magenta('⏵⏵ accept edits');
    case 'plan':
      return p.cyan('⏸ plan mode');
    case 'bypass':
      return p.red('⚠ bypass permissions');
    default:
      return p.dim('ask before edits');
  }
}

export function headerLine(h: HeaderInput, p: Painter, width: number): string {
  const sep = p.dim(' · ');
  const left = [
    p.fg(modelColor(h.model))('●') + ' ' + p.bold(shortModel(h.model)),
    h.effort ? p.dim(h.effort) : '',
    h.agent ? p.dim('@') + h.agent : '',
    h.mode && h.mode !== 'agent' ? p.yellow(h.mode) : '',
  ].filter(Boolean);
  const right = permissionLabel(h.permissionMode, p) + (width >= 70 ? p.dim(' (shift+tab)') : '');
  return spread(left.join(sep), right, width);
}

export interface FooterInput {
  device?: string;
  cwd?: string;
  hubStatus?: 'connecting' | 'open' | 'closed';
  session?: Session;
  model?: string;
  lastUsage?: Usage;
  contextWindow?: number;
  limits: LimitState[];
  subscriptions: Record<string, string>;
  now: number;
}

export function contextPercent(u: Usage | undefined, window: number | undefined): number | undefined {
  if (!u || !window) return undefined;
  const used = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + u.outputTokens;
  return Math.min(100, (used / window) * 100);
}

function windowPercent(w: LimitWindow): number | undefined {
  if (w.usedPercent !== undefined) return w.usedPercent;
  if (w.limit && w.remaining !== undefined) return ((w.limit - w.remaining) / w.limit) * 100;
  return undefined;
}

/** The fullest window, preferring limits for the current model's provider or subscription. */
export function tightestLimit(limits: LimitState[], model: string | undefined, subs: Record<string, string>): { limit: LimitState; window: LimitWindow; pct: number } | undefined {
  const provider = providerOf(model);
  const relevant = limits.filter((l) => l.provider === provider || (subs[provider] && l.provider === subs[provider]));
  const pool = relevant.length ? relevant : limits;
  let best: { limit: LimitState; window: LimitWindow; pct: number } | undefined;
  for (const l of pool) {
    for (const w of l.windows) {
      const pct = l.blocked ? 100 : windowPercent(w);
      if (pct === undefined) continue;
      if (!best || pct > best.pct) best = { limit: l, window: w, pct };
    }
  }
  if (best && !relevant.length && best.pct < 50) return undefined;
  return best;
}

export function footerLine(f: FooterInput, p: Painter, width: number): string {
  const sep = p.dim(' · ');
  const hub = f.hubStatus === 'connecting' ? p.yellow('◌ connecting') : f.hubStatus === 'closed' ? p.red('● hub offline') : '';
  const where = f.cwd ? p.dim(`${f.device ?? 'local'}:`) + shortenPath(f.cwd, 40) : '';
  const left = [hub, where].filter(Boolean).join(sep);
  return spread(left, usageLine(f, p), width);
}

/** The right side of row two: limit countdown, context, tokens, cost, cache and the nearest limit. */
export function usageLine(f: FooterInput, p: Painter): string {
  const sep = p.dim(' · ');
  const parts: string[] = [];
  const s = f.session;
  if (s?.status === 'waiting_reset') {
    const left = s.resumeAt ? formatDuration(s.resumeAt - f.now) : '?';
    parts.push(p.magenta(`⏸ limit reached · resumes in ${left}`));
  }
  const ctx = contextPercent(f.lastUsage, f.contextWindow);
  if (ctx !== undefined) {
    const c = ctx >= 80 ? p.red : ctx >= 60 ? p.yellow : p.dim;
    parts.push(c(`ctx ${Math.round(ctx)}%`));
  }
  if (s) {
    const st = s.stats;
    parts.push(p.dim(`${formatTokens(st.inputTokens + st.cacheReadTokens)} in / ${formatTokens(st.outputTokens)} out`));
    parts.push(st.costUsd ? formatCost(st.costUsd) : p.dim('$0'));
    const totalIn = st.inputTokens + st.cacheReadTokens;
    if (totalIn > 0 && st.cacheReadTokens > 0) parts.push(p.dim(`cache ${Math.round((st.cacheReadTokens / totalIn) * 100)}%`));
  }
  const t = tightestLimit(f.limits, f.model, f.subscriptions);
  if (t) {
    const label = (t.limit.label && t.limit.label.length <= 14 ? t.limit.label : t.limit.provider).toLowerCase();
    const c = t.pct >= 90 ? p.red : t.pct >= 70 ? p.yellow : p.dim;
    const reset = t.window.resetsAt ? ` · resets ${formatDuration(t.window.resetsAt - f.now)}` : '';
    parts.push(c(`${label} ${t.window.name} ${Math.round(t.pct)}%${reset}`));
  }
  if (!parts.length) return p.dim('/help for commands');
  return parts.join(sep);
}
