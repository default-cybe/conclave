/**
 * Budget periods in the owner's time zone: "resets on the 22nd at 00:00 in
 * Europe/Berlin". Pure, with the clock passed in, so the tests can walk it
 * across month ends, short months and daylight saving changes.
 */
import type { AccountBudget } from '../config/schema';

export interface Period {
  start: number;
  end: number;
}

interface Wall {
  y: number;
  /** 1 to 12 */
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(tz, f);
  }
  return f;
}

/** A time zone Intl knows, else undefined. */
export function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    format(tz);
    return tz;
  } catch {
    return undefined;
  }
}

/** The hub's own zone. */
export function hubZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Wall clock of an instant in a zone. */
export function wallAt(ms: number, tz: string): Wall {
  const p = format(tz).formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Milliseconds the zone is ahead of UTC at an instant. */
function offsetAt(ms: number, tz: string): number {
  const w = wallAt(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant of a wall clock time in a zone. Day and month overflow the
 * way Date.UTC does (day 0 is the last day of the month before). A time a
 * spring change skips lands just after the gap.
 */
export function zonedTime(tz: string, y: number, mo: number, d: number, h = 0, mi = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  return second;
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** 0 Sunday to 6 Saturday, of a wall date. */
function weekday(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** The reset in a month: the reset day, or the month's last day when it is shorter. */
function monthReset(tz: string, y: number, mo: number, day: number, hour: number): number {
  // normalize the month (0 and 13 roll over the year)
  const n = new Date(Date.UTC(y, mo - 1, 1));
  const yy = n.getUTCFullYear();
  const mm = n.getUTCMonth() + 1;
  return zonedTime(tz, yy, mm, Math.min(day, daysInMonth(yy, mm)), hour);
}

/**
 * The budget period that holds `now`: from the last reset to the next.
 * month: on resetDay (default 1) at resetHour (default 0). week: on weekday
 * resetDay (0 Sunday, default 1 Monday). day: every day at resetHour.
 */
export function budgetPeriod(b: Pick<AccountBudget, 'period' | 'resetDay' | 'resetHour' | 'tz'>, now: number, defaultTz = hubZone()): Period {
  const tz = validZone(b.tz) ?? validZone(defaultTz) ?? 'UTC';
  const hour = clampInt(b.resetHour, 0, 23, 0);
  const w = wallAt(now, tz);
  const period = b.period ?? 'month';
  if (period === 'day') {
    let start = zonedTime(tz, w.y, w.mo, w.d, hour);
    if (start > now) start = zonedTime(tz, w.y, w.mo, w.d - 1, hour);
    const sw = wallAt(start, tz);
    return { start, end: zonedTime(tz, sw.y, sw.mo, sw.d + 1, hour) };
  }
  if (period === 'week') {
    const day = clampInt(b.resetDay, 0, 6, 1);
    const back = (weekday(w.y, w.mo, w.d) - day + 7) % 7;
    let start = zonedTime(tz, w.y, w.mo, w.d - back, hour);
    if (start > now) start = zonedTime(tz, w.y, w.mo, w.d - back - 7, hour);
    const sw = wallAt(start, tz);
    return { start, end: zonedTime(tz, sw.y, sw.mo, sw.d + 7, hour) };
  }
  const day = clampInt(b.resetDay, 1, 31, 1);
  const here = monthReset(tz, w.y, w.mo, day, hour);
  if (here <= now) return { start: here, end: monthReset(tz, w.y, w.mo + 1, day, hour) };
  return { start: monthReset(tz, w.y, w.mo - 1, day, hour), end: here };
}
