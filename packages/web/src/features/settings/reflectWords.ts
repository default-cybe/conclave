/**
 * Settings > Reflect in words (docs/ASSISTANT.md, Nightly reflection). Pure,
 * so test/reflect-words.test.ts checks it.
 */
import type { RecapDto, RecapPeriod, ReflectDto, ReflectRunDto } from '@conclave/core/client';
import { compact, hhmm, shortDate } from '@/lib/format';

/** What it does and what it costs, in one line, from docs/ASSISTANT.md. */
export const REFLECT_LINE =
  'Each night it reads the chats you wrote in since the last run, only your words and the assistant\'s text, and keeps at most 3 notes on how to work with you. About $0.07 a night on the default model, about $0.005 on the small model; nights without chats cost nothing.';

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "02:40", or "Mon 02:40" and a date for an older run. */
function when(ts: number, now: number): string {
  const day = new Date(ts).toDateString();
  if (day === new Date(now).toDateString()) return hhmm(ts);
  if (day === new Date(now - 86_400_000).toDateString()) return `yesterday ${hhmm(ts)}`;
  return `${shortDate(ts)} ${hhmm(ts)}`;
}

/** "Last ran 02:40, saved 2 notes, retired 1", "Last ran 02:40, skipped: no chats since the last reflection", "Has not run yet". */
export function lastRunWords(last: ReflectRunDto | undefined, now = Date.now()): string {
  if (!last) return 'Has not run yet.';
  const at = when(last.startedAt, now);
  if (last.status === 'running') return `Running since ${at}.`;
  if (last.status === 'skipped') return `Last ran ${at}, skipped: ${(last.reason ?? 'nothing new').replace(/\.$/, '').replace(/^\w/, (c) => c.toLowerCase())}.`;
  if (last.status === 'error') return `Last ran ${at} and failed: ${(last.reason ?? 'error').replace(/\.$/, '')}.`;
  if (!last.saved && !last.retired) return `Last ran ${at}, nothing new to keep.`;
  const parts = [last.saved ? `saved ${n(last.saved, 'note', 'notes')}` : 'saved none', ...(last.retired ? [`retired ${last.retired}`] : [])];
  return `Last ran ${at}${last.trigger === 'manual' ? ' (Reflect now)' : ''}, ${parts.join(', ')}.`;
}

/** The model in words: the routine's own, "fast" as the small model, none as the default model. */
export function modelChoice(model: string | undefined): 'default' | 'fast' | 'other' {
  if (!model) return 'default';
  return model === 'fast' ? 'fast' : 'other';
}

/** "Every night at 02:40, Europe/Berlin. Next run 24 Oct 02:40." or, off, when it would run. */
export function timeWords(r: Pick<ReflectDto, 'enabled' | 'nextRunAt' | 'timezone' | 'time' | 'schedule'>): string {
  const at = r.time ? `Every night at ${r.time}, ${r.timezone}.` : `On the schedule ${r.schedule}, ${r.timezone}, set on Routines.`;
  if (!r.enabled) return `${at} Off for now.`;
  return r.nextRunAt ? `${at} Next run ${shortDate(r.nextRunAt)} ${hhmm(r.nextRunAt)}.` : at;
}

/** A valid time for the box: HH:MM, 24 hours. */
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// ----- the recap (GET /api/reflect/recap) ------------------------------------

const PERIOD_WORD: Record<RecapPeriod, string> = { week: 'This week', month: 'This month', year: 'This year' };

/** The page's one status line: "This week: 12 chats, 4 sessions and 1 workflow, 3.2M tokens." or the empty line. */
export function recapHeadline(r: Pick<RecapDto, 'period' | 'totals'>): string {
  const t = r.totals;
  const parts = [t.chats && n(t.chats, 'chat', 'chats'), t.sessions && n(t.sessions, 'session', 'sessions'), t.workflows && n(t.workflows, 'workflow', 'workflows')].filter(Boolean) as string[];
  if (!parts.length) return `${PERIOD_WORD[r.period]}: nothing yet. Chats, sessions and workflows show up here as you go.`;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `${PERIOD_WORD[r.period]}: ${list}${t.tokens ? `, ${compact(t.tokens)} tokens` : ''}.`;
}

/** "1 to 5 Nov", "Nov 2026", "2026": the range the tab covers, in the account's zone. */
export function recapRange(r: Pick<RecapDto, 'period' | 'start' | 'end' | 'timezone'>): string {
  const day = (ts: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: r.timezone, ...o }).format(ts);
  if (r.period === 'year') return day(r.start, { year: 'numeric' });
  if (r.period === 'month') return day(r.start, { month: 'long', year: 'numeric' });
  const a = day(r.start, { day: 'numeric', month: 'short' });
  const b = day(r.end - 1, { day: 'numeric', month: 'short' });
  return a === b ? a : `${a} to ${b}`;
}

/** "Tue 3 Nov" from the recap's YYYY-MM-DD. */
export function dayWords(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(Date.parse(`${date}T12:00:00Z`));
}

/** The last folder of a session's cwd, or the cwd when it has none. */
export function projectName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
}
