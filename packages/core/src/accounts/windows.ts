/**
 * Limit windows by name: how long each is, what kind it is, and which
 * models it limits. "5h" is the rolling session window, "7d" the weekly one
 * for every model, "7d opus", "7d sonnet" and "7d fable" weekly windows for
 * one model family, "budget" a money budget, requests and tokens per-minute
 * API rates.
 */
import type { LimitState, LimitWindow, LimitWindowKind } from '../types';

const HOUR = 3_600_000;

/** Where a limit state is kept: its provider, or provider:account for one account's windows. */
export function limitKey(l: Pick<LimitState, 'provider' | 'account'>): string {
  return l.account ? `${l.provider}:${l.account}` : l.provider;
}
const DAY = 24 * HOUR;

/** Model families a weekly window may be scoped to. Other scopes (oauth apps, cowork) only inform. */
const MODEL_SCOPES = ['opus', 'sonnet', 'fable', 'haiku'];

const RATE = /^(requests|tokens|input-tokens|output-tokens)$|\/\s*(min|minute)\b|per[- ]minute/i;

/** "7d opus" -> "opus"; "5h" -> undefined. */
export function windowScope(name: string): string | undefined {
  const m = /^\s*\d+[hdm]\s+(.+)$/i.exec(name);
  return m ? m[1].trim().toLowerCase() : undefined;
}

/** What a window is, from its name, when the reader did not say. */
export function windowKind(name: string): LimitWindowKind | undefined {
  const n = name.trim().toLowerCase();
  if (n === 'budget') return 'budget';
  if (n === 'extra usage' || n === 'extra') return 'extra';
  if (RATE.test(n)) return 'rate';
  const m = /^(\d+)([hdm])\b/.exec(n);
  if (m) {
    const ms = Number(m[1]) * (m[2] === 'h' ? HOUR : m[2] === 'd' ? DAY : 60_000);
    if (ms <= 6 * HOUR) return 'session';
    if (ms <= 8 * DAY) return 'weekly';
    return 'monthly';
  }
  if (/week/.test(n)) return 'weekly';
  if (/month/.test(n)) return 'monthly';
  return undefined;
}

/** Length of a window from its name ("5h", "7d opus", "30d"), when it says. */
export function windowLength(name: string): number | undefined {
  const m = /^(\d+)([hdm])\b/.exec(name.trim().toLowerCase());
  if (m) return Number(m[1]) * (m[2] === 'h' ? HOUR : m[2] === 'd' ? DAY : 60_000);
  if (RATE.test(name)) return 60_000;
  return undefined;
}

/** Fill kind, windowMs, source and observedAt where a reader left them out. */
export function annotateWindow(w: LimitWindow, extra: { source?: LimitWindow['source']; observedAt?: number } = {}): LimitWindow {
  const out: LimitWindow = { ...w };
  out.kind ??= windowKind(w.name);
  out.windowMs ??= windowLength(w.name);
  if (extra.source && !out.source) out.source = extra.source;
  if (extra.observedAt && !out.observedAt) out.observedAt = extra.observedAt;
  for (const k of Object.keys(out) as Array<keyof LimitWindow>) if (out[k] === undefined) delete out[k];
  return out;
}

/** Whether a window limits calls to this model. Without a model, only windows for every model do. */
export function windowApplies(w: LimitWindow, model?: string): boolean {
  if (w.kind === 'extra') return false;
  const scope = windowScope(w.name);
  if (!scope) return true;
  if (!MODEL_SCOPES.includes(scope)) return false;
  return !!model && model.toLowerCase().includes(scope);
}

/** Full now: at 100% with a reset still ahead. A full window whose reset passed is unknown again. */
export function windowFull(w: LimitWindow, now: number): boolean {
  if ((w.usedPercent ?? 0) < 100 && !(w.limit && w.remaining === 0)) return false;
  return w.resetsAt === undefined || w.resetsAt > now;
}

/** Merge newer windows over older ones by name. */
export function mergeWindows(old: LimitWindow[], fresh: LimitWindow[]): LimitWindow[] {
  const by = new Map(old.map((w) => [w.name, w]));
  for (const w of fresh) {
    const prev = by.get(w.name);
    if (!prev || (w.observedAt ?? 0) >= (prev.observedAt ?? 0)) by.set(w.name, w);
  }
  return [...by.values()];
}

/** Display order: 5h, 7d, then model weeks, budget, the rest, rates last. */
export function windowOrder(w: LimitWindow): number {
  const kind = w.kind ?? windowKind(w.name);
  const n = w.name.toLowerCase();
  if (kind === 'session') return 0;
  if (kind === 'weekly') return n === '7d' ? 1 : 2;
  if (kind === 'monthly') return 3;
  if (kind === 'budget') return 4;
  if (kind === 'extra') return 6;
  if (kind === 'rate') return 7;
  return 5;
}
