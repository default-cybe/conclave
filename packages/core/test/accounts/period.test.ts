import { describe, expect, test } from 'bun:test';
import { budgetPeriod, daysInMonth, zonedTime } from '../../src/accounts/period';

const Z = (iso: string) => Date.parse(iso);

describe('budget periods with a reset day', () => {
  test('the 22nd at midnight in Berlin, before and after the reset, across the October clock change', () => {
    const b = { period: 'month' as const, resetDay: 22, tz: 'Europe/Berlin' };
    // 20 October: the period started 22 September (CEST, UTC+2)
    expect(budgetPeriod(b, Z('2026-10-20T12:00:00Z'))).toEqual({ start: Z('2026-09-21T22:00:00Z'), end: Z('2026-10-21T22:00:00Z') });
    // one minute before midnight on the 22nd: still the old period
    expect(budgetPeriod(b, Z('2026-10-21T21:59:00Z')).end).toBe(Z('2026-10-21T22:00:00Z'));
    // 00:30 on the 22nd: a new period, ending 22 November in CET (UTC+1) after the 25 October change
    expect(budgetPeriod(b, Z('2026-10-21T22:30:00Z'))).toEqual({ start: Z('2026-10-21T22:00:00Z'), end: Z('2026-11-21T23:00:00Z') });
  });

  test('the same reset day in other zones', () => {
    const la = { resetDay: 22, tz: 'America/Los_Angeles' };
    // 05:00 UTC on the 22nd is still the 21st in Los Angeles (PDT, UTC-7)
    expect(budgetPeriod(la, Z('2026-10-22T05:00:00Z'))).toEqual({ start: Z('2026-09-22T07:00:00Z'), end: Z('2026-10-22T07:00:00Z') });
    const tokyo = { resetDay: 22, tz: 'Asia/Tokyo' };
    // 15:30 UTC on the 21st is already 00:30 on the 22nd in Tokyo
    expect(budgetPeriod(tokyo, Z('2026-10-21T15:30:00Z')).start).toBe(Z('2026-10-21T15:00:00Z'));
    const utc = { resetDay: 22, tz: 'UTC', resetHour: 9 };
    expect(budgetPeriod(utc, Z('2026-12-25T00:00:00Z'))).toEqual({ start: Z('2026-12-22T09:00:00Z'), end: Z('2027-01-22T09:00:00Z') });
  });

  test('a reset day past a short month lands on its last day', () => {
    const b = { resetDay: 31, tz: 'UTC' };
    expect(budgetPeriod(b, Z('2027-02-15T00:00:00Z'))).toEqual({ start: Z('2027-01-31T00:00:00Z'), end: Z('2027-02-28T00:00:00Z') });
    expect(budgetPeriod(b, Z('2027-03-01T00:00:00Z'))).toEqual({ start: Z('2027-02-28T00:00:00Z'), end: Z('2027-03-31T00:00:00Z') });
    // April has 30 days: the 31st reset falls on the 30th, then May 31st
    expect(budgetPeriod(b, Z('2027-04-29T12:00:00Z'))).toEqual({ start: Z('2027-03-31T00:00:00Z'), end: Z('2027-04-30T00:00:00Z') });
    expect(budgetPeriod(b, Z('2027-04-30T12:00:00Z'))).toEqual({ start: Z('2027-04-30T00:00:00Z'), end: Z('2027-05-31T00:00:00Z') });
    // leap February
    expect(budgetPeriod({ resetDay: 30, tz: 'UTC' }, Z('2028-03-10T00:00:00Z')).start).toBe(Z('2028-02-29T00:00:00Z'));
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
  });

  test('the 22nd across a year of months', () => {
    const b = { resetDay: 22, tz: 'UTC' };
    for (let m = 1; m <= 12; m++) {
      const now = Date.UTC(2027, m - 1, 10);
      const p = budgetPeriod(b, now);
      expect(new Date(p.start).getUTCDate()).toBe(22);
      expect(new Date(p.end).getUTCDate()).toBe(22);
      expect(p.start).toBeLessThanOrEqual(now);
      expect(p.end).toBeGreaterThan(now);
      expect(new Date(p.end).getUTCMonth()).toBe(m - 1);
    }
  });

  test('weekly and daily periods', () => {
    // Tuesday 10:00 in Berlin; now is Tuesday 20 October 09:00 Berlin, before the reset
    const week = { period: 'week' as const, resetDay: 2, resetHour: 10, tz: 'Europe/Berlin' };
    expect(budgetPeriod(week, Z('2026-10-20T07:00:00Z'))).toEqual({ start: Z('2026-10-13T08:00:00Z'), end: Z('2026-10-20T08:00:00Z') });
    expect(budgetPeriod(week, Z('2026-10-20T08:00:00Z')).start).toBe(Z('2026-10-20T08:00:00Z'));
    const day = { period: 'day' as const, resetHour: 3, tz: 'UTC' };
    expect(budgetPeriod(day, Z('2026-10-20T02:00:00Z'))).toEqual({ start: Z('2026-10-19T03:00:00Z'), end: Z('2026-10-20T03:00:00Z') });
    expect(budgetPeriod(day, Z('2026-10-20T03:00:00Z'))).toEqual({ start: Z('2026-10-20T03:00:00Z'), end: Z('2026-10-21T03:00:00Z') });
  });

  test('an unknown zone falls back to the default; wall times convert both ways', () => {
    expect(budgetPeriod({ resetDay: 1, tz: 'Mars/Olympus' }, Z('2026-10-20T00:00:00Z'), 'UTC').start).toBe(Z('2026-10-01T00:00:00Z'));
    expect(zonedTime('Europe/Berlin', 2026, 7, 1, 12)).toBe(Z('2026-07-01T10:00:00Z'));
    expect(zonedTime('Europe/Berlin', 2026, 12, 1, 12)).toBe(Z('2026-12-01T11:00:00Z'));
    // day 0 is the last day of the month before
    expect(zonedTime('UTC', 2026, 3, 0)).toBe(Z('2026-02-28T00:00:00Z'));
  });
});
