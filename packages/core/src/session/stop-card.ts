/**
 * "Why did this turn stop": the reason a session is not working, from its
 * status, its last reply's stop reason and its newest notice, with the
 * evidence and the next step. Pure and tested (packages/web/test/stop-card.test.ts);
 * the web chat and the terminal app show it, and the Android app says the
 * same in packages/android/client/.../logic/StopCard.kt.
 * A stalled task is told apart from a live one by its last real activity:
 * `quiet` says how long its session has been silent.
 */
import type { Message, Session } from '../types';

export type StopKind = 'refusal' | 'limit' | 'provider' | 'stalled' | 'stopped' | 'interrupted';

export interface StopCard {
  kind: StopKind;
  title: string;
  /** What the hub said or did: the notice, the refused reply, the time of the last progress. */
  evidence: string;
  /** What to do now. */
  next: string;
}

/** A running task with no activity for this long is not shown as alive (the stuck alert's default is 5 min). */
export const QUIET_MS = 5 * 60_000;

/** "quiet for 7 min" for a task whose session has not moved for QUIET_MS, else "active 12s ago" style words. */
export function activity(updatedAt: number | undefined, now: number): { text: string; quiet: boolean } | undefined {
  if (!updatedAt) return undefined;
  const ms = Math.max(0, now - updatedAt);
  if (ms >= QUIET_MS) return { text: `No activity for ${Math.floor(ms / 60_000)} min`, quiet: true };
  return { text: ms < 45_000 ? 'Active now' : `Active ${Math.round(ms / 60_000)} min ago`, quiet: false };
}

const cut = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// hub context (transcript.ts isReminder) is left out; not imported, so the web bundle stays free of the engine
function msgText(m: Message): string {
  return m.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text' && !b.text.startsWith('<system-reminder>'))
    .map((b) => b.text)
    .join('\n\n');
}

/** The card for a session that stopped, or undefined while it works, waits on you or has nothing to say. */
export function stopCard(session: Session, messages: readonly Message[], opts: { stuckSince?: number } = {}): StopCard | undefined {
  const notices = messages.filter((m) => m.kind === 'notice');
  const noticeOf = (re: RegExp) => [...notices].reverse().find((m) => re.test(`${m.meta?.type ?? ''} ${msgText(m)}`));
  if (session.status === 'running' && opts.stuckSince) {
    return { kind: 'stalled', title: 'Stalled', evidence: `No progress since ${hhmm(opts.stuckSince)}.`, next: 'Stop it, or keep waiting, from the Inbox.' };
  }
  if (session.status === 'error') {
    const n = [...notices].reverse().find((m) => m.meta?.level === 'error' || m.meta?.type === 'provider_error' || /^error\b/i.test(msgText(m)));
    const evidence = cut((n ? msgText(n) : session.error ?? 'The provider failed.').replace(/^error:?\s*/i, ''));
    return { kind: 'provider', title: 'Provider error', evidence, next: n?.meta?.canRetry ? 'Retry with another model.' : 'Send a message to try again, or switch model.' };
  }
  if (session.status === 'waiting_reset') {
    const n = noticeOf(/limit/i);
    return {
      kind: 'limit',
      title: 'Usage limit',
      evidence: cut(n ? msgText(n) : 'The model hit its usage limit.'),
      next: session.resumeAt ? `It resumes at ${hhmm(session.resumeAt)}. Or switch model.` : 'It resumes when the limit resets. Or switch model.',
    };
  }
  if (session.status !== 'idle') return undefined;
  const last = [...messages].reverse().find((m) => m.kind === 'normal' && (m.role === 'assistant' || m.content.some((b) => b.type === 'text')));
  if (last?.role === 'assistant' && last.stopReason === 'refusal') {
    const next = [...notices].reverse().find((m) => m.seq > last.seq && m.meta?.type === 'refusal');
    return { kind: 'refusal', title: 'Refused', evidence: cut(msgText(last) || 'The model declined to continue.'), next: next?.meta?.canTryNext ? 'Try the next model.' : 'Rephrase, or switch model.' };
  }
  const stopped = { kind: 'stopped', title: 'Stopped by you', evidence: 'The turn was cut before it finished.', next: 'Send a message to go on.' } as const;
  // only the owner's Stop writes the "Stopped" notice; a hub restart also sets stoppedTurn but writes none
  const after = notices.filter((m) => !last || m.seq > last.seq);
  const stoppedByYou = after.some((m) => msgText(m) === 'Stopped');
  if (session.meta?.stoppedTurn) {
    return stoppedByYou ? stopped : { kind: 'interrupted', title: 'Interrupted', evidence: 'The hub restarted during this turn.', next: 'Resume to go on.' };
  }
  // a Stop mid tool run leaves the reply on tool_use; the notice is the proof either way
  if (stoppedByYou) return stopped;
  if (last?.role === 'assistant' && last.stopReason === 'aborted') {
    // the harness writes "aborted" for every stop that is not a clean end (output limit, ACP error), not only your Stop
    const n = [...after].reverse().find((m) => m.meta?.level === 'error' || m.meta?.level === 'warning');
    if (n) return { kind: 'provider', title: n.meta?.level === 'error' ? 'Provider error' : 'Stopped early', evidence: cut(msgText(n)), next: 'Send a message to try again, or switch model.' };
  }
  return undefined;
}
