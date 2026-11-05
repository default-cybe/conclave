/**
 * Settings > Reflect in words (docs/ASSISTANT.md, Nightly reflection). Pure,
 * so test/reflect-words.test.ts checks it.
 */
import type { ReflectDto, ReflectRange, ReflectReport, ReflectRunDto } from '@conclave/core/client';
import { compact, hhmm, shortDate } from '@/lib/format';
import { modelName } from '@/lib/models';

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

// ----- the report (GET /api/reflect/report) ----------------------------------

export const RANGES: Array<{ value: ReflectRange; label: string }> = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: '3m', label: '3 mo' },
  { value: '6m', label: '6 mo' },
  { value: '12m', label: '12 mo' },
];

/** "30 Oct to 5 Nov", "6 Nov 2025 to 5 Nov 2026": the dates the report covers, in the account's zone. */
export function reportRange(r: Pick<ReflectReport, 'start' | 'end' | 'timezone'>): string {
  const sameYear = new Date(r.start).getUTCFullYear() === new Date(r.end - 1).getUTCFullYear();
  const day = (ts: number) => new Intl.DateTimeFormat('en-GB', { timeZone: r.timezone, day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(ts);
  return `${day(r.start)} to ${day(r.end - 1)}`;
}

/** "Made 2 h ago with your small model." or "Made today 09:12 from the numbers only." */
export function madeWords(r: Pick<ReflectReport, 'generatedAt' | 'insights'>, now = Date.now()): string {
  const mins = Math.round((now - r.generatedAt) / 60_000);
  const at = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 24 * 60 ? `${Math.round(mins / 60)} h ago` : `on ${shortDate(r.generatedAt)}`;
  return `Made ${at}${r.insights === 'model' ? ' with your small model' : ' from the numbers only'}. It is made again each week, or when you press Refresh.`;
}

/** The big numbers: chats and sessions, hours active, tokens and cost, projects. */
export function bigNumbers(t: ReflectReport['totals']): Array<{ value: string; label: string }> {
  return [
    { value: String(t.chats + t.sessions), label: `${n(t.chats, 'chat', 'chats')}, ${n(t.sessions, 'session', 'sessions')}` },
    { value: t.hoursActive >= 10 ? String(Math.round(t.hoursActive)) : String(t.hoursActive), label: 'hours active' },
    { value: compact(t.tokens), label: t.costUsd ? `tokens, $${t.costUsd >= 100 ? Math.round(t.costUsd) : t.costUsd.toFixed(2)}` : 'tokens' },
    { value: String(t.projects), label: t.projects === 1 ? 'project' : 'projects' },
  ];
}

export const HABIT_WORDS: Record<string, { title: string; what: string }> = {
  delegation: { title: 'Delegation', what: 'What you hand off, and to whom' },
  description: { title: 'Description', what: 'How clearly you set up the work' },
  discernment: { title: 'Discernment', what: 'How you judge what comes back' },
  diligence: { title: 'Diligence', what: 'How you check before it counts' },
};

/** The heatmap's cells: 0 to 4, against the busiest hour. */
export function heatLevel(v: number, max: number): number {
  return !v || !max ? 0 : Math.min(4, Math.ceil((v / max) * 4));
}

/** A late-night share worth a gentle line: a fifth or more of your messages between 23:00 and 05:00. */
export function lateLine(share: number, messages: number): string | undefined {
  if (share < 0.2 || messages < 20) return undefined;
  return `${Math.round(share * 100)}% of your messages came between 23:00 and 05:00. Quiet hours below keep the hub from pinging you then.`;
}

/** "4 active days, longest streak 2 days, busiest Tue 3 Nov with 40 messages." The late-night share only when lateLine does not say it already. */
export function rhythmWords(r: ReflectReport['rhythm']): string {
  const busiest = r.busiestDay ? `, busiest ${dayWords(r.busiestDay.date)} with ${r.busiestDay.count} messages` : '';
  const late = lateLine(r.lateNightShare, r.messages) ? '' : ` ${Math.round(r.lateNightShare * 100)}% late at night.`;
  return `${n(r.activeDays, 'active day', 'active days')}, longest streak ${n(r.longestStreak, 'day', 'days')}${busiest}.${late}`;
}

/** "3 fallbacks, most often Opus 5.5 to Sonnet 5.5." with the model picker's names, or nothing. */
export function fallbackWords(m: Pick<ReflectReport['models'], 'fallbacks' | 'topFallback'>): string {
  if (!m.fallbacks) return '';
  const top = m.topFallback ? `, most often ${m.topFallback.split(' to ').map(modelName).join(' to ')}` : '';
  return `${n(m.fallbacks, 'fallback', 'fallbacks')}${top}. `;
}

/** Home's line after the count: "learnings wait for review in Reflect". */
export function learningsWaitWords(n: number): string {
  return `${n === 1 ? 'learning waits' : 'learnings wait'} for review in Reflect`;
}

/** The footnote on what was left out, or nothing. */
export function excludedWords(e: ReflectReport['excluded']): string | undefined {
  const parts = [e.health && `${n(e.health, 'health-related session', 'health-related sessions')} (found by topic)`, e.incognito && n(e.incognito, 'incognito chat', 'incognito chats')].filter(Boolean) as string[];
  if (!parts.length) return undefined;
  return `Left out: ${parts.join(' and ')}. Only titles and short summaries are read, never mail, files or tool output.`;
}

/** "Tue 3 Nov" from the report's YYYY-MM-DD. */
export function dayWords(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(Date.parse(`${date}T12:00:00Z`));
}
