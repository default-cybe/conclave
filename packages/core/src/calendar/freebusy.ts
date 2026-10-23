/**
 * Free and busy time: merge busy blocks from many calendars and people, cut
 * the free time inside daily windows in the owner's zone, and pick meeting
 * slots that fit everyone.
 */
import { addDays, atLocal, localDate } from '../assistant/time';
import type { BusyBlock, FreeSlot } from './types';

export interface Interval {
  start: number;
  end: number;
}

/** Sorted, overlapping and touching intervals joined. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** Busy blocks merged per person, then all together, keeping who was busy. */
export function mergeBusy(blocks: BusyBlock[]): Array<Interval & { who: string[] }> {
  const merged = mergeIntervals(blocks);
  return merged.map((m) => ({ ...m, who: [...new Set(blocks.filter((b) => b.start < m.end && b.end > m.start).map((b) => b.who))] }));
}

export interface WindowOptions {
  zone: string;
  /** Daily window, local "HH:MM-HH:MM". Default 08:00-20:00. */
  within?: string;
  /** Weekdays allowed, 0 Sunday to 6 Saturday. Default every day. */
  days?: number[];
  /** Shortest slot worth listing, minutes. Default 30. */
  minMinutes?: number;
}

function parseWindow(w: string | undefined): { start: string; end: string } {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(w ?? '');
  if (!m) return { start: '08:00', end: '20:00' };
  const p = (h: string, mi: string) => `${h.padStart(2, '0')}:${mi}`;
  return { start: p(m[1], m[2]), end: p(m[3], m[4]) };
}

function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Free time inside the daily windows of [range.start, range.end), with the busy intervals cut out. */
export function freeSlots(busy: Interval[], range: Interval, o: WindowOptions): FreeSlot[] {
  const win = parseWindow(o.within);
  const min = (o.minMinutes ?? 30) * 60_000;
  const merged = mergeIntervals(busy);
  const out: FreeSlot[] = [];
  let date = localDate(range.start, o.zone);
  const last = localDate(range.end - 1, o.zone);
  for (let guard = 0; guard < 400 && date <= last; guard++, date = addDays(date, 1)) {
    if (o.days?.length && !o.days.includes(weekday(date))) continue;
    let ws = Math.max(atLocal(date, win.start, o.zone), range.start);
    const endDate = win.end <= win.start ? addDays(date, 1) : date;
    const we = Math.min(atLocal(endDate, win.end, o.zone), range.end);
    if (we <= ws) continue;
    for (const b of merged) {
      if (b.end <= ws || b.start >= we) continue;
      if (b.start - ws >= min) out.push({ start: ws, end: b.start, minutes: Math.round((b.start - ws) / 60_000) });
      ws = Math.max(ws, b.end);
      if (ws >= we) break;
    }
    if (we - ws >= min) out.push({ start: ws, end: we, minutes: Math.round((we - ws) / 60_000) });
  }
  return out;
}

/**
 * Up to count start times for a meeting of the given length inside the free
 * slots: the earliest fit on each day first, so the choices spread over
 * days, then more on the same days. Starts are on the half hour.
 */
export function suggestSlots(free: FreeSlot[], minutes: number, zone: string, count = 3, step = 30): Interval[] {
  const len = minutes * 60_000;
  const stepMs = step * 60_000;
  const fits: Interval[] = [];
  for (const f of free) {
    let s = Math.ceil(f.start / stepMs) * stepMs;
    for (; s + len <= f.end; s += stepMs) fits.push({ start: s, end: s + len });
  }
  const byDay = new Map<string, Interval[]>();
  for (const f of fits) {
    const day = localDate(f.start, zone);
    byDay.set(day, [...(byDay.get(day) ?? []), f]);
  }
  const out: Interval[] = [];
  // one pick per day per round, days in order; a later pick keeps an hour away from the earlier ones
  while (out.length < count) {
    let added = false;
    for (const list of byDay.values()) {
      if (out.length >= count) break;
      const pick = list.find((x) => !out.some((o) => Math.abs(o.start - x.start) < Math.max(len, 3_600_000)));
      if (!pick) continue;
      out.push(pick);
      added = true;
    }
    if (!added) break;
  }
  return out.sort((a, b) => a.start - b.start);
}
