/**
 * Settings > Reflect in words (docs/ASSISTANT.md, Nightly reflection). Pure,
 * so test/reflect-words.test.ts checks it.
 */
import type { ReflectDto, ReflectRunDto } from '@conclave/core/client';
import { hhmm, shortDate } from '@/lib/format';

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
