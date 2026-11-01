/**
 * A finished goal says the day it was finished on this device's calendar
 * (src/features/goals/words.ts dayOf, used by the goal row and panel).
 * Finished at 01:00 in Berlin is that day there, though it is the day
 * before in UTC.
 *
 *   bun test packages/web/test/goals-done-date.test.tsx
 */
import { afterAll, expect, test } from 'bun:test';
import { dayOf } from '../src/features/goals/words';

const tz = process.env.TZ;
afterAll(() => {
  process.env.TZ = tz;
});

test('the done day is the local day', () => {
  process.env.TZ = 'Europe/Berlin';
  // 18 Oct 2026 01:00 in Berlin, 17 Oct 23:00 in UTC
  expect(dayOf(Date.parse('2026-10-17T23:00:00Z'))).toBe('18 Oct');
});
