/**
 * The Meetings page's pure parts (docs/design/MEETING-MODE.md 11.2, 11.10):
 * the Now / Upcoming / Past split for every status, 0.4.51 rows included;
 * the countdown table, DST weekend included; the second-time hint; the
 * form's wall-clock to instant conversion; and the sidebar's hint.
 */
import { describe, expect, test } from 'bun:test';
import { countdown, fromInputs, placeOf, prepWord, sections, sideHint, toInputs, yourTime, when } from '../src/features/meeting/time';
import type { Meeting } from '../src/overlay/wire';

const LA = 'America/Los_Angeles';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-31T17:00:00Z'); // Sat 31 Oct 10:00 in LA (PDT)
const mtg = (p: Partial<Meeting>): Meeting => ({ id: 'm', accountId: 'owner', sessionId: 's', device: 'd', cwd: '/p', title: 'T', status: 'scheduled', createdAt: NOW - HOUR, autoAnswer: 'questions', ...p });

describe('sections', () => {
  test('every status lands in its section', () => {
    const at = (s: Meeting['status'], p: Partial<Meeting> = {}) => placeOf(mtg({ status: s, ...p }), NOW);
    expect(at('live')).toBe('now');
    expect(at('paused')).toBe('now');
    expect(at('ending')).toBe('now');
    expect(at('preparing')).toBe('now');
    expect(at('ended')).toBe('past');
    expect(at('failed')).toBe('past');
    expect(at('scheduled', { scheduledAt: NOW + 3 * 24 * HOUR })).toBe('upcoming');
    // ready: Now within 15 minutes either way, Upcoming further ahead
    expect(at('ready', { scheduledAt: NOW + 10 * MIN })).toBe('now');
    expect(at('ready', { scheduledAt: NOW - 10 * MIN })).toBe('now');
    expect(at('ready', { scheduledAt: NOW + 20 * MIN })).toBe('upcoming');
  });

  test('0.4.51 rows with no scheduledAt keep their old places', () => {
    expect(placeOf(mtg({ status: 'ready' }), NOW)).toBe('now');
    expect(placeOf(mtg({ status: 'live', startedAt: NOW - MIN }), NOW)).toBe('now');
    expect(placeOf(mtg({ status: 'ended', startedAt: NOW - HOUR }), NOW)).toBe('past');
  });

  test('a meeting never started goes to Past 3 h after its end', () => {
    const m = mtg({ scheduledAt: NOW - 3 * HOUR - 31 * MIN, durationMin: 30 });
    expect(placeOf(m, NOW)).toBe('past');
    expect(placeOf({ ...m, scheduledAt: NOW - 3 * HOUR - 29 * MIN }, NOW)).toBe('upcoming');
  });

  test('sorts: upcoming soonest first, past newest first', () => {
    const s = sections(
      [
        mtg({ id: 'b', scheduledAt: NOW + 2 * HOUR }),
        mtg({ id: 'a', scheduledAt: NOW + HOUR }),
        mtg({ id: 'old', status: 'ended', startedAt: NOW - 5 * HOUR }),
        mtg({ id: 'new', status: 'ended', startedAt: NOW - HOUR }),
        mtg({ id: 'noheld', scheduledAt: NOW - 2 * 24 * HOUR }),
      ],
      NOW,
    );
    expect(s.upcoming.map((m) => m.id)).toEqual(['a', 'b']);
    expect(s.past.map((m) => m.id)).toEqual(['new', 'old', 'noheld']);
    expect(s.now).toEqual([]);
  });
});

describe('countdown (the 11.2 table)', () => {
  const c = (ms: number) => countdown(NOW + ms, NOW, LA);
  test('each row', () => {
    expect(c(3 * 24 * HOUR + 5 * HOUR)).toBe('in 3 days');
    // 24.5 h on: the clocks fall back overnight, so 09:30
    expect(c(24 * HOUR + 30 * MIN)).toBe('tomorrow 09:30');
    expect(c(14 * HOUR + 5 * MIN)).toBe('in 14h 05m');
    expect(c(42 * MIN)).toBe('in 42m');
    expect(c(4 * MIN + 12_000)).toBe('in 4:12');
    expect(c(-5 * MIN)).toBe('now');
    expect(c(0)).toBe('now');
    expect(c(-22 * MIN)).toBe('started 22m ago');
  });

  test('the DST weekend: Monday 10:00 PST is 48 h 1 h away, and the form reads it right', () => {
    // 2026-11-01 02:00 PDT falls back to 01:00 PST
    const mon = fromInputs('2026-11-02', '10:00', LA)!;
    expect(new Date(mon).toISOString()).toBe('2026-11-02T18:00:00.000Z');
    expect(countdown(mon, NOW, LA)).toBe('in 2 days');
    // Sunday 10:00 PST, 25 h after Saturday 10:00 PDT
    const sun = fromInputs('2026-11-01', '10:00', LA)!;
    expect(sun - NOW).toBe(25 * HOUR);
    expect(countdown(sun, NOW, LA)).toBe('tomorrow 10:00');
    expect(toInputs(mon, LA)).toEqual({ date: '2026-11-02', time: '10:00' });
  });
});

describe('times in the owner zone', () => {
  const mon = Date.parse('2026-11-02T18:00:00Z');
  test('the meta line', () => {
    expect(when(mon, 60, LA)).toBe('Mon 2 Nov, 10:00 to 11:00');
    expect(when(mon, undefined, LA)).toBe('Mon 2 Nov, 10:00');
  });
  test('a second time when the browser zone differs', () => {
    expect(yourTime(mon, LA, 'America/New_York')).toBe('(13:00 your time)');
    expect(yourTime(mon, LA, LA)).toBe('');
    expect(yourTime(mon, LA, 'Asia/Tokyo')).toBe('(Tue 3 Nov 03:00 your time)');
  });
});

test('prep words', () => {
  expect(prepWord({})).toEqual(['Not prepared', 'dim']);
  expect(prepWord({ prepState: 'running', prepProgress: { phase: 'map', done: 34, total: 120, startedAt: 0 } })).toEqual(['Preparing 34/120', 'signal']);
  expect(prepWord({ prepState: 'done' })).toEqual(['Prepared', 'neutral']);
  expect(prepWord({ prepState: 'done', prepEditedAt: 1 })).toEqual(['Edited', 'neutral']);
  expect(prepWord({ prepState: 'failed' })).toEqual(['Prep failed', 'fault']);
});

test('the sidebar names a live meeting first, else one within the hour', () => {
  const soon = mtg({ id: 'soon', scheduledAt: NOW + 42 * MIN });
  const later = mtg({ id: 'later', scheduledAt: NOW + 2 * HOUR });
  expect(sideHint([later, soon], NOW).next?.id).toBe('soon');
  expect(sideHint([later], NOW).next).toBeUndefined();
  expect(sideHint([soon, mtg({ id: 'l', status: 'live' })], NOW).live?.id).toBe('l');
});
