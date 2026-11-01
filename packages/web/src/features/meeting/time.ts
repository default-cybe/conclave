/**
 * Times, countdowns and the Now / Upcoming / Past split of the Meetings page
 * (docs/design/MEETING-MODE.md 11.2). Pure functions: the page, the sidebar
 * row and the tests share them. Every time shows in the owner's zone.
 */
import type { StateTone } from '@/components/ui/List';
import type { Meeting } from '@/overlay/wire';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Now and Upcoming split 15 minutes either side of the start. */
export const NOW_WINDOW = 15 * MIN;
/** A meeting never started moves to Past this long after it should have ended. */
export const STALE_AFTER = 3 * HOUR;

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Parts = { y: number; mo: number; d: number; h: number; mi: number; wd: string; mon: string };

const fmts = new Map<string, Intl.DateTimeFormat>();
function parts(ts: number, zone: string): Parts {
  let f = fmts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    fmts.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const mo = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'numeric' }).format(new Date(ts));
  return { y: +p.year, mo: +mo, d: +p.day, h: +p.hour, mi: +p.minute, wd: p.weekday, mon: p.month };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "10:00" in the zone. */
export function hm(ts: number, zone: string): string {
  const p = parts(ts, zone);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** "Mon 2 Nov" in the zone. */
export function day(ts: number, zone: string): string {
  const p = parts(ts, zone);
  return `${p.wd} ${p.d} ${p.mon}`;
}

/** "Mon 2 Nov, 10:00 to 11:00" (no end without a duration). */
export function when(start: number, durationMin: number | undefined, zone: string): string {
  return `${day(start, zone)}, ${hm(start, zone)}${durationMin ? ` to ${hm(start + durationMin * MIN, zone)}` : ''}`;
}

/** "(13:00 your time)" when the browser's zone shows another clock time, else "". */
export function yourTime(ts: number, zone: string, local = browserZone()): string {
  if (local === zone || hm(ts, local) === hm(ts, zone)) return '';
  const other = day(ts, local) === day(ts, zone) ? hm(ts, local) : `${day(ts, local)} ${hm(ts, local)}`;
  return `(${other} your time)`;
}

/** "Pacific time (America/Los_Angeles)" */
export function zoneLabel(zone: string): string {
  let name = '';
  try {
    name =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')
        ?.value.replace(/ Time$/, ' time') ?? '';
  } catch {
    /* an engine without longGeneric: the id alone */
  }
  return name && name !== zone ? `${name} (${zone})` : zone;
}

/** The form's date and time inputs ("2026-11-02", "10:00") for an instant, in the zone. */
export function toInputs(ts: number, zone: string): { date: string; time: string } {
  const p = parts(ts, zone);
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` };
}

/** The instant a wall-clock date and time in the zone names, DST included. undefined when unreadable. */
export function fromInputs(date: string, time: string, zone: string): number | undefined {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return undefined;
  const wall = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
  const offset = (ts: number) => {
    const p = parts(ts, zone);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ts / MIN) * MIN;
  };
  // twice: the first guess may sit across a DST change from the answer
  let ts = wall - offset(wall);
  ts = wall - offset(ts);
  return ts;
}

/** The calendar day's bounds in the zone, for the event picker. */
export function dayBounds(date: string, zone: string): { from: number; to: number } | undefined {
  const from = fromInputs(date, '00:00', zone);
  if (from === undefined) return undefined;
  const [y, mo, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const to = fromInputs(`${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`, '00:00', zone)!;
  return { from, to };
}

/**
 * The countdown of 11.2's table, for a start time seen at `now`:
 * "in 3 days", "tomorrow 10:00", "in 14h 05m", "in 42m", "in 4:12", "now",
 * "started 22m ago".
 */
export function countdown(start: number, now: number, zone: string): string {
  const ms = start - now;
  if (ms <= 0) {
    const late = -ms;
    if (late <= NOW_WINDOW) return 'now';
    return late < HOUR ? `started ${Math.floor(late / MIN)}m ago` : `started ${Math.floor(late / HOUR)}h ${pad(Math.floor((late % HOUR) / MIN))}m ago`;
  }
  if (ms > 2 * DAY) return `in ${Math.floor(ms / DAY)} days`;
  if (ms > DAY) {
    // "tomorrow" only when it is the next calendar day in the zone; 47 hours ahead can be the day after
    const t = parts(now + DAY, zone);
    const s = parts(start, zone);
    return t.y === s.y && t.mo === s.mo && t.d === s.d ? `tomorrow ${hm(start, zone)}` : `${s.wd} ${hm(start, zone)}`;
  }
  if (ms >= HOUR) return `in ${Math.floor(ms / HOUR)}h ${pad(Math.floor((ms % HOUR) / MIN))}m`;
  if (ms >= 10 * MIN) return `in ${Math.floor(ms / MIN)}m`;
  const s = Math.floor(ms / 1000);
  return `in ${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** How often a countdown must re-render: each second in the last 10 minutes (each minute with reduced motion). */
export function tickFor(start: number | undefined, now: number, reduced = false): number {
  return !reduced && start !== undefined && start - now < 10 * MIN && start - now > -MIN ? 1000 : 60_000;
}

const RUNNING = new Set(['live', 'paused', 'ending', 'preparing']);

/** The moment a never-started meeting counts as not held. */
export function staleAt(m: Pick<Meeting, 'scheduledAt' | 'durationMin'>): number | undefined {
  return m.scheduledAt === undefined ? undefined : m.scheduledAt + (m.durationMin ?? 0) * MIN + STALE_AFTER;
}

/** Scheduled or armed, never started, and past its time (the "Not held" rows). */
export function notHeld(m: Meeting, now: number): boolean {
  const stale = staleAt(m);
  return (m.status === 'scheduled' || m.status === 'ready') && !m.startedAt && stale !== undefined && now > stale;
}

export type Place = 'now' | 'upcoming' | 'past';

/** Which section of the page a meeting sits in (11.2). 0.4.51 rows, with no scheduledAt, keep their old places. */
export function placeOf(m: Meeting, now: number): Place {
  if (m.status === 'ended' || m.status === 'failed' || notHeld(m, now)) return 'past';
  if (RUNNING.has(m.status)) return 'now';
  if (m.status === 'ready') return m.scheduledAt === undefined || m.scheduledAt - now <= NOW_WINDOW ? 'now' : 'upcoming';
  return 'upcoming';
}

const pastKey = (m: Meeting) => m.startedAt ?? m.scheduledAt ?? m.createdAt;

export function sections(list: Meeting[], now: number): Record<Place, Meeting[]> {
  const out: Record<Place, Meeting[]> = { now: [], upcoming: [], past: [] };
  for (const m of list) out[placeOf(m, now)].push(m);
  out.now.sort((a, b) => (a.scheduledAt ?? a.createdAt) - (b.scheduledAt ?? b.createdAt));
  out.upcoming.sort((a, b) => (a.scheduledAt ?? Infinity) - (b.scheduledAt ?? Infinity));
  out.past.sort((a, b) => pastKey(b) - pastKey(a));
  return out;
}

export { pastKey };

/** The prep's word on a row (11.2): "Not prepared", "Preparing 34/120", "Prepared", "Edited", "Prep failed". */
export function prepWord(m: Pick<Meeting, 'prepState' | 'prepProgress' | 'prepEditedAt'>): [string, StateTone] {
  switch (m.prepState) {
    case 'queued':
      return ['Preparing', 'signal'];
    case 'running': {
      const p = m.prepProgress;
      return [p && p.total && (p.phase === 'map' || p.phase === 'merge') ? `Preparing ${p.done}/${p.total}` : 'Preparing', 'signal'];
    }
    case 'waiting':
      return ['Needs your OK', 'warn'];
    case 'done':
      return m.prepEditedAt ? ['Edited', 'neutral'] : ['Prepared', 'neutral'];
    case 'failed':
      return ['Prep failed', 'fault'];
    default:
      return ['Not prepared', 'dim'];
  }
}

/** The soonest meeting the sidebar names: a live one first, else one due within the hour. */
export function sideHint(list: Meeting[], now: number): { live?: Meeting; next?: Meeting } {
  const live = list.find((m) => m.status === 'live' || m.status === 'paused');
  if (live) return { live };
  const next = list
    .filter((m) => (m.status === 'scheduled' || m.status === 'ready') && m.scheduledAt !== undefined && m.scheduledAt > now && m.scheduledAt - now <= HOUR)
    .sort((a, b) => a.scheduledAt! - b.scheduledAt!)[0];
  return { next };
}

/** "in 42m" for the sidebar (always minutes: it is within the hour). */
export function sideCountdown(start: number, now: number): string {
  return `in ${Math.max(1, Math.ceil((start - now) / MIN))}m`;
}
