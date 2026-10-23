import { Cron } from 'croner';
import { parseDuration } from '../util/text';

/**
 * Schedule strings:
 *   cron, 5 or 6 fields ("30 7 * * 1-5", "0 *\/5 * * * *")
 *   @hourly @daily @weekly @monthly @yearly (croner nicknames)
 *   @every 30m / @every 1h30m (minimum 1 minute)
 *   @once 2026-10-20T09:00 (local time in the routine timezone unless the ISO string has an offset)
 */
export type ParsedSchedule =
  | { kind: 'cron'; expr: string }
  | { kind: 'every'; ms: number }
  | { kind: 'once'; at: number; raw: string };

const NICKNAMES = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@yearly', '@annually', '@midnight']);
const MIN_EVERY = 60_000;

export function validateTimezone(tz?: string): void {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
}

function cronFor(expr: string, tz?: string): Cron {
  const e = expr === '@midnight' ? '@daily' : expr;
  return new Cron(e, { timezone: tz, mode: '5-or-6-parts', paused: true });
}

/** Offset of `tz` from UTC in ms at instant `t` (positive east of Greenwich). */
function tzOffset(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Parse an ISO-ish date. Without an explicit offset it is wall time in `tz` (or the host zone). */
export function parseOnceDate(s: string, tz?: string): number {
  const raw = s.trim();
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (hasOffset || !tz) {
    // Date.parse reads a bare date as UTC midnight but a date and time as host time: give it a time
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00` : raw);
    if (Number.isNaN(t)) throw new Error(`Invalid date in @once: ${raw}`);
    return t;
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`Invalid date in @once: ${raw}`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  // two passes settle DST edges
  let t = wall - tzOffset(wall, tz);
  t = wall - tzOffset(t, tz);
  return t;
}

export function parseSchedule(schedule: string, tz?: string): ParsedSchedule {
  const s = schedule.trim().replace(/\s+/g, ' ');
  if (!s) throw new Error('Schedule is empty');
  validateTimezone(tz);
  const lower = s.toLowerCase();
  if (lower.startsWith('@every')) {
    const ms = parseDuration(s.slice(6).trim());
    if (!ms) throw new Error(`Invalid interval in "${s}". Use e.g. "@every 30m" or "@every 1h30m".`);
    if (ms < MIN_EVERY) throw new Error('Intervals shorter than 1 minute are not allowed');
    return { kind: 'every', ms };
  }
  if (lower.startsWith('@once')) {
    const raw = s.slice(5).trim();
    if (!raw) throw new Error('@once needs a date, e.g. "@once 2026-10-20T09:00"');
    return { kind: 'once', at: parseOnceDate(raw, tz), raw };
  }
  if (s.startsWith('@') && !NICKNAMES.has(lower)) throw new Error(`Unknown schedule keyword: ${s.split(' ')[0]}`);
  const expr = s.startsWith('@') ? lower : s;
  if (!s.startsWith('@')) {
    const fields = s.split(' ').length;
    if (fields !== 5 && fields !== 6) throw new Error(`Cron needs 5 or 6 fields, got ${fields}`);
  }
  try {
    cronFor(expr, tz);
  } catch (err) {
    throw new Error(`Invalid cron "${s}": ${(err as Error).message}`);
  }
  return { kind: 'cron', expr };
}

/**
 * First fire time strictly after `after`.
 * For @every the interval counts from `anchor` (last scheduled time) when given,
 * stepping forward past `after`, so cadence does not drift.
 */
export function nextRun(schedule: string | ParsedSchedule, opts: { after?: number; timezone?: string; anchor?: number } = {}): number | undefined {
  const p = typeof schedule === 'string' ? parseSchedule(schedule, opts.timezone) : schedule;
  const after = opts.after ?? Date.now();
  switch (p.kind) {
    case 'once':
      return p.at > after ? p.at : undefined;
    case 'every': {
      if (opts.anchor === undefined) return after + p.ms;
      let t = opts.anchor + p.ms;
      if (t <= after) t += Math.ceil((after - t + 1) / p.ms) * p.ms;
      return t;
    }
    case 'cron': {
      const d = cronFor(p.expr, opts.timezone).nextRun(new Date(after));
      return d ? d.getTime() : undefined;
    }
  }
}

/** Most recent fire time at or before `before`, if the schedule can tell. */
export function previousRun(schedule: string | ParsedSchedule, opts: { before?: number; timezone?: string; anchor?: number } = {}): number | undefined {
  const p = typeof schedule === 'string' ? parseSchedule(schedule, opts.timezone) : schedule;
  const before = opts.before ?? Date.now();
  switch (p.kind) {
    case 'once':
      return p.at <= before ? p.at : undefined;
    case 'every': {
      if (opts.anchor === undefined || opts.anchor > before) return undefined;
      return opts.anchor + Math.floor((before - opts.anchor) / p.ms) * p.ms;
    }
    case 'cron': {
      const [d] = cronFor(p.expr, opts.timezone).previousRuns(1, new Date(before + 1000));
      return d && d.getTime() <= before ? d.getTime() : undefined;
    }
  }
}

/** Next `count` fire times from `from` (for the UI preview). */
export function previewRuns(schedule: string, timezone?: string, count = 5, from = Date.now()): number[] {
  const p = parseSchedule(schedule, timezone);
  const out: number[] = [];
  let after = from;
  let anchor: number | undefined;
  for (let i = 0; i < count; i++) {
    const t = nextRun(p, { after, timezone, anchor });
    if (t === undefined) break;
    out.push(t);
    after = t;
    anchor = p.kind === 'every' ? t : undefined;
  }
  return out;
}
