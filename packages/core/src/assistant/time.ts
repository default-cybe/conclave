/**
 * Local time for the owner: dates, minutes since midnight and message hours
 * in an IANA zone. No node imports.
 */
import { parseOnceDate } from '../scheduler/schedule';

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function parts(ts: number, tz: string): Record<string, string> {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' });
    fmtCache.set(tz, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts))) out[p.type] = p.value;
  return out;
}

export function validZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The hub's own zone. */
export function hubZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** YYYY-MM-DD in the zone. */
export function localDate(ts: number, tz: string): string {
  const p = parts(ts, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes since local midnight. */
export function localMinutes(ts: number, tz: string): number {
  const p = parts(ts, tz);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** "HH:MM" local. */
export function localHhmm(ts: number, tz: string): string {
  const p = parts(ts, tz);
  return `${p.hour}:${p.minute}`;
}

/** "Saturday 17 October, 14:30". */
export function localLong(ts: number, tz: string): string {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ts));
  return `${d.replace(',', '')}, ${localHhmm(ts, tz)}`;
}

/** The instant a local wall time happens. */
export function atLocal(date: string, hhmm: string, tz: string): number {
  return parseOnceDate(`${date}T${hhmm}`, tz);
}

/** Add days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Days from one YYYY-MM-DD date to another. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Start and end (exclusive) of a local day. */
export function dayRange(date: string, tz: string, days = 1): { start: number; end: number } {
  return { start: atLocal(date, '00:00', tz), end: atLocal(addDays(date, days), '00:00', tz) };
}

export function validHhmm(s: unknown): s is string {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * True when ts falls inside the message hours. A window whose end is before
 * its start runs over midnight. Equal start and end means always.
 */
export function insideHours(ts: number, hours: { start: string; end: string }, tz: string): boolean {
  const s = minutesOf(hours.start);
  const e = minutesOf(hours.end);
  if (s === e) return true;
  const m = localMinutes(ts, tz);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** When the next message window opens after ts (the end of quiet hours). */
export function nextOpening(ts: number, hours: { start: string; end: string }, tz: string): number {
  const today = localDate(ts, tz);
  for (let i = 0; i <= 2; i++) {
    const at = atLocal(addDays(today, i), hours.start, tz);
    if (at > ts) return at;
  }
  return ts + 86_400_000;
}

/** Cron hours field for a heartbeat every 30 minutes inside the hours: "9-21", "22-23,0-1". */
export function cronHours(hours: { start: string; end: string }): string {
  const s = Math.floor(minutesOf(hours.start) / 60);
  // a window ending at 21:30 still has a tick at 21:00; one ending at 21:00 has its last at 20:30
  const endMin = minutesOf(hours.end);
  const e = Math.floor((endMin - 1 + 1440) % 1440 / 60);
  if (minutesOf(hours.start) === endMin) return '*';
  if (s <= e) return s === e ? String(s) : `${s}-${e}`;
  const a = s === 23 ? '23' : `${s}-23`;
  const b = e === 0 ? '0' : `0-${e}`;
  return `${a},${b}`;
}

const ZONE_RE = /\b((?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/;

/** The first valid IANA zone named in some text ("Timezone: Europe/Berlin"), or UTC when the text says UTC as its zone. */
export function zoneIn(text: string): string | undefined {
  const m = ZONE_RE.exec(text);
  if (m && validZone(m[1])) return m[1];
  if (/\b(?:time ?zone|tz)\b[^.\n]{0,20}\bUTC\b/i.test(text)) return 'UTC';
  return undefined;
}
