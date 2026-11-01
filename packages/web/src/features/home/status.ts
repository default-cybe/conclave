/**
 * The Home status sentence (spec 11.1), built from data. Counts one to nine
 * as words. Only the waiting clause is amber.
 *
 *   "Two sessions running. Two are waiting on you."
 *   "Claude Max is blocked until 15:04."  /  "Claude's 5 hour window is at 72%."
 */
import type { LimitState, LimitWindow, Routine } from '@conclave/core/types';
import { countWord, hhmm } from '@/lib/format';
import { dayStart } from '@/lib/schedule';
import { isRateWindow, planParts, windowLabel } from '@/components/ui/Meter';

export interface Clause {
  text: string;
  tone?: 'warn';
}

export interface StatusInput {
  running: number;
  waiting: number;
  /** No session has ever existed (the first day after setup). */
  firstDay: boolean;
  /** Phones: "Two running. Two waiting on you." */
  short?: boolean;
  limits: LimitState[];
  thresholds: { warn: number; fault: number };
  routines: Routine[];
  now: number;
  /** The hub does not answer: what is known, and from when. */
  offline?: Offline;
}

/** The hub is offline. `at`: when the counts on screen were last known good; none when this app never had them. */
export interface Offline {
  name: string;
  at?: number;
}

/** "Can't tell what needs you while madx is offline." Nothing on screen came from the hub. */
export function unknownWords(name: string): string {
  return `Can't tell what needs you while ${name} is offline.`;
}

/** "madx is offline, so this is from 10:37." After counts that were last good at `at`. */
function staleWords(o: Offline & { at: number }): string {
  return `${o.name} is offline, so this is from ${hhmm(o.at)}.`;
}

/** True for API keys read from rate limit headers, as opposed to plans and subscriptions. */
export function isApiLimit(l: LimitState): boolean {
  return l.source === 'headers';
}

/** Windows worth showing on Home: plans always, API windows only when they matter. */
export function homeWindows(l: LimitState): LimitWindow[] {
  return l.windows.filter((w) => {
    const pct = w.usedPercent ?? 0;
    if (isRateWindow(w)) return pct > 50;
    if (isApiLimit(l)) return pct > 50;
    return true;
  });
}

function windowPhrase(name: string): string {
  const label = windowLabel(name);
  const map: Record<string, string> = { '5 hours': '5 hour window', Week: 'weekly limit', Day: 'daily limit', Hour: 'hourly limit', Month: 'monthly limit' };
  if (map[label]) return map[label];
  const m = label.match(/^(Week|Day|Month), (.+)$/);
  if (m) return `${{ Week: 'weekly', Day: 'daily', Month: 'monthly' }[m[1]]} ${m[2]} limit`;
  return `${label.toLowerCase()} limit`;
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

/** The limit closest to stopping work: blocked first, then the highest window at or over the warn threshold. */
export function pressingLimit(limits: LimitState[], warn: number): { limit: LimitState; window: LimitWindow; pct: number } | undefined {
  let best: { limit: LimitState; window: LimitWindow; pct: number } | undefined;
  for (const l of limits) {
    for (const w of homeWindows(l)) {
      const blocked = !!l.blocked && (w.usedPercent ?? 0) >= 99;
      const pct = blocked ? 100 : Math.round(w.usedPercent ?? 0);
      if (pct < warn) continue;
      const score = pct + (blocked ? 1000 : 0);
      const cur = best ? best.pct + (best.limit.blocked && (best.window.usedPercent ?? 0) >= 99 ? 1000 : 0) : -1;
      if (score > cur) best = { limit: l, window: w, pct };
    }
  }
  return best;
}

export function nextRoutine(routines: Routine[], now: number): Routine | undefined {
  return routines.filter((r) => r.enabled && r.nextRunAt && r.nextRunAt > now).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
}

function whenWords(ts: number, now: number): string {
  const start = dayStart(now);
  if (ts < start + 86_400_000) return `at ${hhmm(ts)}`;
  if (ts < start + 2 * 86_400_000) return `tomorrow at ${hhmm(ts)}`;
  return `${new Date(ts).toLocaleDateString('en-GB', { weekday: 'long' })} at ${hhmm(ts)}`;
}

/** Line one: running and waiting. Line two: the limit, or else the next routine. */
export function statusClauses(i: StatusInput): { first: Clause[]; second?: Clause } {
  if (i.offline && i.offline.at === undefined) return { first: [{ text: unknownWords(i.offline.name) }] };
  const first: Clause[] = [];
  if (i.running === 0) first.push({ text: i.firstDay ? 'Nothing running yet.' : 'Nothing running.' });
  else if (i.short) first.push({ text: `${countWord(i.running, true)} running.` });
  else first.push({ text: `${countWord(i.running, true)} ${i.running === 1 ? 'session' : 'sessions'} running.` });
  if (i.waiting > 0) first.push({ text: i.short ? `${countWord(i.waiting, true)} waiting on you.` : `${countWord(i.waiting, true)} ${i.waiting === 1 ? 'is' : 'are'} waiting on you.`, tone: 'warn' });

  if (i.offline?.at !== undefined) return { first, second: { text: staleWords({ ...i.offline, at: i.offline.at }) } };

  const p = pressingLimit(i.limits, i.thresholds.warn);
  if (p) {
    const [brand] = planParts(p.limit.label);
    if (p.limit.blocked && p.pct >= 100 && p.window.resetsAt) return { first, second: { text: `${p.limit.label.replace(/\s*·.*$/, '')} ${i.short ? 'blocked' : 'is blocked'} until ${hhmm(p.window.resetsAt)}.` } };
    return { first, second: { text: `${possessive(brand)} ${windowPhrase(p.window.name)} is at ${p.pct}%.` } };
  }
  const next = nextRoutine(i.routines, i.now);
  if (next?.nextRunAt) return { first, second: { text: `Next routine ${whenWords(next.nextRunAt, i.now)}, ${next.name}.` } };
  return { first };
}
