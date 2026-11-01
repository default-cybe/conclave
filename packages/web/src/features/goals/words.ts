/** Words for goals: areas, target dates and who wrote an entry. */
import type { Goal, GoalArea, GoalEntry } from '@conclave/core/client';
import { GOAL_AREA_LABEL, GOAL_AREAS } from '@conclave/core/assistant/types';

export { GOAL_AREA_LABEL, GOAL_AREAS };

/** Today in this device's zone, YYYY-MM-DD. */
export function todayLocal(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysUntil(date: string, today = todayLocal()): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** "1 Dec" for a YYYY-MM-DD date. */
export function dayWords(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const sameYear = y === new Date().getFullYear();
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "18 Oct" for a time, on this device's calendar (a goal finished at 01:00 is that day, not the day before in UTC). */
export function dayOf(ts: number): string {
  return dayWords(todayLocal(ts));
}

export type Tone = 'dim' | 'warn' | 'fault' | 'ok';

/** The target date in words and its tone: amber within 3 days, red once it passed. */
export function targetWords(g: Pick<Goal, 'targetDate' | 'status'>, today = todayLocal()): { text: string; tone: Tone } | undefined {
  if (!g.targetDate || g.status === 'done') return undefined;
  const d = daysUntil(g.targetDate, today);
  const when = dayWords(g.targetDate);
  if (d < 0) return { text: `${when}, ${-d === 1 ? '1 day' : `${-d} days`} past`, tone: 'fault' };
  if (d === 0) return { text: 'due today', tone: 'warn' };
  if (d === 1) return { text: 'due tomorrow', tone: 'warn' };
  return { text: `due ${when}, in ${d} days`, tone: d <= 3 ? 'warn' : 'dim' };
}

export function sourceWords(e: Pick<GoalEntry, 'source'>): string {
  return e.source === 'owner' ? 'you' : e.source === 'routine' ? 'a routine' : 'the assistant';
}

export function areaLabel(a: GoalArea): string {
  return GOAL_AREA_LABEL[a] ?? 'Something else';
}

export const AREA_OPTIONS = GOAL_AREAS.map((a) => ({ value: a, label: GOAL_AREA_LABEL[a] }));
