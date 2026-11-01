/**
 * Alerts in the Inbox (docs/DESIGN.md 28): the words of a file conflict and
 * a stuck turn, and the store following alert.raised and alert.cleared.
 *
 *   bun test packages/web/test/alerts.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { AlertItem } from '@conclave/core/client';
import type { EngineEvent } from '@conclave/core/types';
import { alertActions, alertLine, alertMinutes, alertText, alertWord, waitHint } from '../src/components/inbox/alertWords';
import { applyEvent, useHub } from '../src/store/store';

const MIN = 60_000;
const t0 = 1_800_000_000_000;

const conflict: AlertItem = {
  id: 'alrt_c',
  kind: 'fileConflict',
  sessionId: 'ses_b',
  text: "'Fix login' and 'Refactor auth' are both editing src/auth/redirect.ts",
  createdAt: t0,
  updatedAt: t0,
  device: 'local',
  path: '/repo/src/auth/redirect.ts',
  file: 'src/auth/redirect.ts',
  sessions: [
    { id: 'ses_a', title: 'Fix login' },
    { id: 'ses_b', title: 'Refactor auth' },
  ],
};
const idle: AlertItem = { id: 'alrt_i', kind: 'stuck', reason: 'idle', sessionId: 'ses_a', text: "No progress in 'Fix login' for 5 min", createdAt: t0, updatedAt: t0, sessions: [{ id: 'ses_a', title: 'Fix login' }], since: t0 - 5 * MIN, thresholdMs: 5 * MIN };
const loop: AlertItem = { id: 'alrt_l', kind: 'stuck', reason: 'loop', sessionId: 'ses_a', text: "'Fix login' may be in a loop: Bash failed the same way 3 times", createdAt: t0, updatedAt: t0, sessions: [{ id: 'ses_a', title: 'Fix login' }], since: t0, tool: 'Bash', count: 3, error: 'Exit code 3' };

describe('alert words', () => {
  test('a stuck turn keeps counting its minutes; the rest keep the hub sentence', () => {
    expect(alertMinutes(20_000)).toBe('1 min');
    expect(alertMinutes(6 * MIN + 59_000)).toBe('6 min');
    expect(alertText(idle, t0 + MIN)).toBe("No progress in 'Fix login' for 6 min");
    expect(alertText(loop, t0 + MIN)).toBe(loop.text);
    expect(alertText(conflict, t0 + MIN)).toBe(conflict.text);
  });

  test('one line under the session title on a phone', () => {
    expect(alertLine(conflict, t0)).toBe("'Fix login' is editing redirect.ts too");
    expect(alertLine({ ...conflict, sessions: [] }, t0)).toBe('Another chat is editing redirect.ts too');
    expect(alertLine(idle, t0 + 2 * MIN)).toBe('No progress for 7 min');
    expect(alertLine(loop, t0)).toBe('Bash failed the same way 3 times');
  });

  test('the state word and the answers', () => {
    expect([conflict, idle, loop].map(alertWord)).toEqual(['Conflict', 'No progress', 'Loop']);
    expect(alertActions(conflict)).toEqual([{ action: 'dismiss', label: 'Dismiss' }]);
    expect(alertActions(idle).map((a) => a.label)).toEqual(['Stop', 'Keep waiting']);
    expect(alertActions(loop).map((a) => a.action)).toEqual(['stop', 'wait']);
  });

  test('what Keep waiting gives', () => {
    expect(waitHint(idle)).toBe('Keep waiting gives it 10 min more.');
    expect(waitHint(loop)).toBe('Keep waiting flags it again after 6 failures in a row.');
    expect(waitHint(conflict)).toBeUndefined();
  });
});

describe('the store', () => {
  let seq = 0;
  const send = (e: EngineEvent) => applyEvent({ ...e, seq: ++seq, ts: t0 + seq } as Parameters<typeof applyEvent>[0]);

  test('alert.raised adds or updates an alert, alert.cleared removes it', () => {
    send({ type: 'alert.raised', alert: conflict });
    send({ type: 'alert.raised', alert: idle });
    expect(Object.keys(useHub.getState().alerts).sort()).toEqual(['alrt_c', 'alrt_i']);
    send({ type: 'alert.raised', alert: { ...conflict, updatedAt: t0 + 5 } });
    expect(useHub.getState().alerts.alrt_c.updatedAt).toBe(t0 + 5);
    send({ type: 'alert.cleared', id: 'alrt_i', sessionId: 'ses_a' });
    expect(Object.keys(useHub.getState().alerts)).toEqual(['alrt_c']);
  });
});
