/** Words for routine state, runs and times (spec 1.2: state is a word in a fixed place). */
import type { ReactNode } from 'react';
import type { Routine, RoutineRun, Session } from '@conclave/core/types';
import { hhmm, inTime, durationShort } from '@/lib/format';
import { dayStart, everyMs, parseCron } from '@/lib/schedule';
import type { StateTone } from '@/components/ui/List';
import { Elapsed } from '@/components/motion';

const DAY = 86_400_000;

/** The run's state as a word and its tone. A run whose session waits on the owner says so. */
export function runState(run: RoutineRun, session?: Session): { word: string; tone: StateTone } {
  if (run.status === 'running') {
    if (session?.status === 'waiting_approval' || session?.status === 'waiting_input') return { word: 'waiting on you', tone: 'warn' };
    return { word: 'running', tone: 'signal' };
  }
  if (run.status === 'error') return { word: 'failed', tone: 'fault' };
  if (run.status === 'skipped') return { word: 'skipped', tone: 'dim' };
  // the reply's STATUS line (ECOSYSTEM.md 5.3 item 9)
  if (run.outcome === 'problem') return { word: 'problem', tone: 'fault' };
  if (run.outcome === 'attention') return { word: 'needs a look', tone: 'warn' };
  return { word: 'done', tone: 'dim' };
}

/** The reply without its "STATUS: ..." first line, for run rows. */
export function withoutStatus(text: string | undefined): string | undefined {
  if (!text) return text;
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0 || !/^\W*status\s*:\s*(ok|attention|problem)\b/i.test(lines[i].trim())) return text;
  const rest = lines.slice(i + 1).join('\n').trim();
  return rest || undefined;
}

/** Notify setting in words. on_attention also covers failed runs. */
export const NOTIFY_WORD: Record<Routine['notify'], string> = { always: 'After every run', on_error: 'On failure', on_attention: 'On problems', never: 'Never' };

export const TRIGGER_WORD: Record<RoutineRun['trigger'], string> = { schedule: 'scheduled', manual: 'manual', webhook: 'webhook' };

/** "today", "yesterday", "Tue", "9 Oct" for when something happened. */
function dayWord(ts: number, now = Date.now()): string {
  const today = dayStart(now);
  if (ts >= today) return 'today';
  if (ts >= today - DAY) return 'yesterday';
  if (ts >= today - 6 * DAY) return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' });
  return `${new Date(ts).getDate()} ${new Date(ts).toLocaleDateString('en-GB', { month: 'short' })}`;
}

/** Group heading for a run timeline: "Today", "Yesterday", "Wednesday 14 October". */
export function dayHeading(ts: number, now = Date.now()): string {
  const today = dayStart(now);
  if (ts >= today) return 'Today';
  if (ts >= today - DAY) return 'Yesterday';
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}`;
}

/** When the next run is: "in 22 min", "18:00", "tomorrow 08:00", "Mon 08:00", "19 Oct 09:00". */
export function nextWords(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  if (ts - now < 3_600_000) return inTime(ts, now);
  const today = dayStart(now);
  if (ts < today + DAY) return hhmm(ts);
  if (ts < today + 2 * DAY) return `tomorrow ${hhmm(ts)}`;
  if (ts < today + 7 * DAY) return `${new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' })} ${hhmm(ts)}`;
  return `${new Date(ts).getDate()} ${new Date(ts).toLocaleDateString('en-GB', { month: 'short' })} ${hhmm(ts)}`;
}

const fmts = new Map<string, Intl.DateTimeFormat>();
/** Wall clock parts of an instant in a time zone. */
function zoned(ts: number, tz: string) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ts).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour % 24, mi: p.minute };
}
/** The instant a wall clock time happens in a time zone (two passes for DST). */
function fromZoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const off = (t: number) => {
    const z = zoned(t, tz);
    return Date.UTC(z.y, z.mo, z.d, z.h, z.mi) - Math.floor(t / 60_000) * 60_000;
  };
  let t = wall - off(wall);
  t = wall - off(t);
  return t;
}

/**
 * The next time a routine fires: the hub's nextRunAt while it is ahead.
 * Otherwise cron is worked out here in the routine's own zone. A routine on
 * the hub's zone is left to the hub, whose zone this device does not know.
 */
export function nextRun(r: Routine, now = Date.now()): number | undefined {
  if (!r.enabled) return undefined;
  if (r.nextRunAt && r.nextRunAt > now) return r.nextRunAt;
  const s = r.schedule.trim();
  const c = s.startsWith('@') || !r.timezone ? null : parseCron(s);
  if (!c) return r.nextRunAt;
  const tz = r.timezone!;
  try {
    const domOnly = c.raw[2] !== '*';
    const dowOnly = c.raw[4] !== '*';
    const hours = [...c.hour].sort((a, b) => a - b);
    const mins = [...c.minute].sort((a, b) => a - b);
    const today = zoned(now, tz);
    for (let i = 0; i < 400; i++) {
      const day = new Date(Date.UTC(today.y, today.mo, today.d + i));
      const dom = c.dom.has(day.getUTCDate());
      const dow = c.dow.has(day.getUTCDay());
      const hit = c.month.has(day.getUTCMonth() + 1) && (domOnly && dowOnly ? dom || dow : dom && dow);
      if (!hit) continue;
      for (const h of hours) {
        // on the first day, skip wall clock times already past
        if (i === 0 && h < today.h) continue;
        for (const m of mins) {
          if (i === 0 && h === today.h && m < today.mi) continue;
          const t = fromZoned(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, tz);
          if (t > now) return t;
        }
      }
    }
  } catch {
    // an unknown zone name: trust the hub
  }
  return r.nextRunAt;
}

/**
 * The next n runs worked out here when that is reliable: intervals step from
 * the hub's next run, cron in this zone repeats nextRun. Undefined means ask
 * the hub (previewSchedule), for one time runs and other zones.
 */
export function upcoming(r: Routine, n = 5, now = Date.now()): number[] | undefined {
  const every = everyMs(r.schedule);
  if (every && r.nextRunAt) {
    let t = r.nextRunAt;
    while (t <= now) t += every;
    return Array.from({ length: n }, (_, i) => t + i * every);
  }
  if (r.schedule.trim().startsWith('@')) return undefined;
  const out: number[] = [];
  let at = now;
  for (let i = 0; i < n; i++) {
    const t = nextRun({ ...r, enabled: true, nextRunAt: undefined }, at);
    if (!t) return out.length ? out : undefined;
    out.push(t);
    at = t;
  }
  return out;
}

/** The routine's zone as a city name when it is not this device's zone ("Berlin"), else undefined. */
export function otherZone(tz: string | undefined): string | undefined {
  if (!tz || tz === Intl.DateTimeFormat().resolvedOptions().timeZone) return undefined;
  return tz.split('/').pop()!.replace(/_/g, ' ');
}

/** The first line of a prompt, for list rows. */
export function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
}

/** "took 3m", "took 41s" */
export function tookWords(run: RoutineRun): string | undefined {
  if (!run.finishedAt) return undefined;
  return `took ${durationShort(run.finishedAt - run.startedAt)}`;
}

/** The newest run, if any. */
function latestRun(runs: RoutineRun[] | undefined): RoutineRun | undefined {
  if (!runs?.length) return undefined;
  return runs.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
}

/**
 * The last outcome for a list: "done 14:16", "failed yesterday",
 * "running 52m", "waiting on you", "never ran".
 */
export function LastOutcome({ routine, runs, sessions, now }: { routine: Routine; runs: RoutineRun[] | undefined; sessions: Record<string, Session>; now: number }): ReactNode {
  const run = latestRun(runs);
  if (!run) {
    if (routine.lastRunAt) return <span className="text-fg-3">done {when(routine.lastRunAt, now)}</span>;
    return <span className="text-fg-3">never ran</span>;
  }
  const st = runState(run, run.sessionId ? sessions[run.sessionId] : undefined);
  if (st.word === 'running')
    return (
      <span className="text-signal">
        running <Elapsed since={run.startedAt} format="short" />
      </span>
    );
  if (st.word === 'waiting on you') return <span className="text-warn">waiting on you</span>;
  const loud = st.tone === 'fault' ? 'text-fault' : st.tone === 'warn' ? 'text-warn' : undefined;
  return (
    <span className={loud ?? 'text-fg-3'}>
      {st.word} <span className={loud ? '' : 'text-fg-2'}>{when(run.startedAt, now)}</span>
    </span>
  );
}

/** "14:16" today, otherwise the day word. */
function when(ts: number, now: number): string {
  return ts >= dayStart(now) ? hhmm(ts) : dayWord(ts, now);
}
