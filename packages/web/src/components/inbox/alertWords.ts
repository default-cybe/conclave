/**
 * The words of an alert (a file conflict, a stuck turn) in the Inbox. Pure,
 * so they are tested without a browser. The Android app has the same words
 * in packages/android/client/.../logic/Inbox.kt.
 */
import type { AlertAction, AlertItem } from '@conclave/core/client';
import { fileName } from '@/lib/format';

/** "6 min": whole minutes, at least 1. */
export function alertMinutes(ms: number): string {
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

function titleOf(a: AlertItem, id = a.sessionId): string {
  return a.sessions?.find((s) => s.id === id)?.title ?? 'A session';
}

/** The sentence: "No progress in 'Fix login' for 6 min" (the minutes keep counting), or the hub's own sentence. */
export function alertText(a: AlertItem, now: number): string {
  if (a.kind === 'stuck' && a.reason !== 'loop' && a.since) return `No progress in '${titleOf(a)}' for ${alertMinutes(now - a.since)}`;
  return a.text;
}

/** One line under the session's title in a phone row: "'Fix login' is editing redirect.ts too", "No progress for 6 min". */
export function alertLine(a: AlertItem, now: number): string {
  if (a.kind === 'fileConflict') {
    const other = a.sessions?.find((s) => s.id !== a.sessionId);
    const file = fileName(a.file ?? a.path ?? 'a file');
    return other ? `'${other.title}' is editing ${file} too` : `Another chat is editing ${file} too`;
  }
  if (a.reason === 'loop') return `${a.tool ?? 'A tool'} failed the same way ${a.count ?? 3} times`;
  return a.since ? `No progress for ${alertMinutes(now - a.since)}` : 'No progress';
}

/** The state word in a row's fixed place. */
export function alertWord(a: AlertItem): string {
  if (a.kind === 'fileConflict') return 'Conflict';
  return a.reason === 'loop' ? 'Loop' : 'No progress';
}

/** The answers an alert takes, in order. */
export function alertActions(a: AlertItem): Array<{ action: AlertAction; label: string }> {
  if (a.kind === 'fileConflict') return [{ action: 'dismiss', label: 'Dismiss' }];
  return [
    { action: 'stop', label: 'Stop' },
    { action: 'wait', label: 'Keep waiting' },
  ];
}

/** What Keep waiting gives: "Keep waiting gives it 10 min more." The doubled wait counts from the answer. */
export function waitHint(a: AlertItem): string | undefined {
  if (a.kind !== 'stuck') return undefined;
  if (a.reason === 'loop') return `Keep waiting flags it again after ${(a.count ?? 3) * 2} failures in a row.`;
  return a.thresholdMs ? `Keep waiting gives it ${alertMinutes(a.thresholdMs * 2)} more.` : undefined;
}
