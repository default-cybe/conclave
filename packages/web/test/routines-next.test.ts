/**
 * When a routine runs next (src/features/routines/words.tsx nextRun and
 * upcoming): the hub's nextRunAt wins, a routine on the hub's zone is never
 * worked out in this device's zone, and cron in a routine's own zone agrees
 * with the hub's scheduler.
 *
 *   bun test packages/web/test/routines-next.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Routine } from '@conclave/core/types';
import { nextRun as hubNext } from '@conclave/core/scheduler/schedule';
import { nextRun, upcoming } from '../src/features/routines/words';

const routine = (p: Partial<Routine>): Routine => ({ id: 'r1', name: 'r', agent: 'assistant', mode: 'agent', prompt: '', schedule: '0 9 * * *', enabled: true, sessionPolicy: 'new', notify: 'never', createdAt: 0, updatedAt: 0, ...p });
const NOW = Date.parse('2026-10-14T10:00:00Z');

describe('next run', () => {
  test("a routine on the hub's zone takes the hub's time", () => {
    // minute 17 cannot come from 0 9 * * * in any zone, so this is the hub's answer
    const at = NOW + 3 * 3_600_000 + 17 * 60_000;
    expect(nextRun(routine({ nextRunAt: at }), NOW)).toBe(at);
    expect(upcoming(routine({ nextRunAt: at }), 5, NOW)).toBeUndefined();
  });

  test("the hub's time wins on a day the clocks change", () => {
    // 02:30 does not exist in New York on 8 March 2026; the hub runs it at 03:30
    const now = Date.parse('2026-03-08T06:30:00Z');
    const r = routine({ schedule: '30 2 * * *', timezone: 'America/New_York', nextRunAt: Date.parse('2026-03-08T07:30:00Z') });
    expect(nextRun(r, now)).toBe(r.nextRunAt);
  });

  test("cron in the routine's own zone matches the hub", () => {
    for (const [schedule, timezone] of [
      ['30 7 * * 1-5', 'Europe/Berlin'],
      ['0 9 * * *', 'Asia/Kolkata'],
      ['15 1 * * 0', 'America/New_York'],
      ['0 0 1 * *', 'Australia/Sydney'],
    ]) {
      const r = routine({ schedule, timezone });
      expect(nextRun(r, NOW)).toBe(hubNext(schedule, { after: NOW, timezone })!);
    }
  });
});
