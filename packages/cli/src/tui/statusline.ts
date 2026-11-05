/**
 * The one hint row under the input. Left: the permission mode when it is not
 * the default, the hub when it is not connected, a remote device, else a short
 * hint. Right: model, effort, agent, mode, context left, cost and a limit that
 * is running out. Pure so it can be tested.
 */
import type { LimitState, LimitWindow, PermissionMode, Session, Usage } from '@conclave/core/types.ts';
import { truncate, width as strWidth, type Painter } from '../ansi';
import { formatCost, formatDuration } from '../render/format';
import { providerOf, shortModel } from '../render/models';

export interface StatusInput {
  model?: string;
  /** Effort label ("high"); empty runs at the agent's. */
  effort?: string;
  agent?: string;
  mode?: string;
  permissionMode?: PermissionMode;
  device?: string;
  hubStatus?: 'connecting' | 'open' | 'closed';
  session?: Session;
  lastUsage?: Usage;
  contextWindow?: number;
  limits: LimitState[];
  subscriptions: Record<string, string>;
  now: number;
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

/** The permission mode when it is not the default; the default needs no words. */
export function permissionLabel(m: PermissionMode | undefined, p: Painter): string {
  switch (m) {
    case 'acceptEdits':
      return p.magenta('⏵⏵ accept edits on');
    case 'plan':
      return p.cyan('⏸ plan mode on');
    case 'bypass':
      return p.red('⚠ bypass permissions on');
    default:
      return '';
  }
}

export function statusLine(s: StatusInput, p: Painter, width: number): string {
  const sep = p.dim(' · ');
  const mode = permissionLabel(s.permissionMode, p);
  const hub = s.hubStatus === 'connecting' ? p.yellow('◌ connecting') : s.hubStatus === 'closed' ? p.red('● hub offline') : '';
  const device = s.device && s.device !== 'local' ? p.dim(`on ${s.device}`) : '';
  const state = [hub, mode ? mode + (width >= 80 ? p.dim(' (shift+tab to cycle)') : '') : '', device].filter(Boolean).join(sep);
  const left = state || p.dim('? for shortcuts');
  const who = [
    s.model ? shortModel(s.model) : '',
    s.effort ?? '',
    s.agent && s.agent !== 'assistant' ? '@' + s.agent : '',
    s.mode && s.mode !== 'agent' ? s.mode : '',
  ].filter(Boolean);
  const right = [p.dim(who.join(' · ')), usageLine(s, p)].filter(Boolean).join(sep);
  if (strWidth(left) + strWidth(right) + 2 <= width) return spread(left, right, width);
  // too narrow: the hint goes first; a real state (mode, hub, device) stays and the right side is cut
  if (!state) return spread('', truncate(right, width), width);
  return spread(truncate(left, width), truncate(right, width - Math.min(strWidth(left), width) - 2), width);
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

/** Limit countdown, context left, cost and a limit window past 70%. Empty before any usage. */
export function usageLine(f: Pick<StatusInput, 'session' | 'lastUsage' | 'contextWindow' | 'limits' | 'subscriptions' | 'now' | 'model'>, p: Painter): string {
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
    parts.push(c(`${Math.max(0, Math.round(100 - ctx))}% context left`));
  }
  if (s?.stats.costUsd) parts.push(p.dim(formatCost(s.stats.costUsd)));
  const t = tightestLimit(f.limits, f.model, f.subscriptions);
  if (t && t.pct >= 70) {
    const label = (t.limit.label && t.limit.label.length <= 14 ? t.limit.label : t.limit.provider).toLowerCase();
    const c = t.pct >= 90 ? p.red : t.pct >= 70 ? p.yellow : p.dim;
    const reset = t.window.resetsAt ? ` · resets ${formatDuration(t.window.resetsAt - f.now)}` : '';
    parts.push(c(`${label} ${t.window.name} ${Math.round(t.pct)}%${reset}`));
  }
  return parts.join(sep);
}
