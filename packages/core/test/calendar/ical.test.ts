/**
 * iCalendar expansion: repeating events in the owner's zone across a DST
 * change, overrides and EXDATEs, all-day and floating events, and writing
 * events back.
 */
import { describe, expect, test } from 'bun:test';
import { buildEvent, excludeOccurrence, expand, ianaZone, localToEpoch, updateEvent } from '../../src/calendar/ical';
import { BERLIN_VTIMEZONE, ics } from './fixtures';

const BERLIN = 'Europe/Berlin';
const utc = (s: string) => Date.parse(s);
const range = (a: string, b: string) => ({ start: utc(a), end: utc(b) });

describe('expand', () => {
  test('a weekly 18:00 Berlin workout stays at 18:00 local across the October DST change', () => {
    const data = ics([
      BERLIN_VTIMEZONE,
      'BEGIN:VEVENT',
      'UID:gym@test',
      'DTSTART;TZID=Europe/Berlin:20261014T180000',
      'DTEND;TZID=Europe/Berlin:20261014T190000',
      'RRULE:FREQ=WEEKLY;BYDAY=WE',
      'SUMMARY:Gym',
      'END:VEVENT',
    ]);
    const out = expand(data, range('2026-10-19T00:00:00Z', '2026-11-02T00:00:00Z'), BERLIN);
    expect(out.map((o) => new Date(o.start).toISOString())).toEqual(['2026-10-21T16:00:00.000Z', '2026-10-28T17:00:00.000Z']);
    expect(out.every((o) => o.end - o.start === 3_600_000)).toBe(true);
    expect(out[0]).toMatchObject({ title: 'Gym', recurring: true, busy: true, uid: 'gym@test' });
    expect(out[0].recurrenceId).toEqual({ value: '20261021T180000', tzid: 'Europe/Berlin' });
  });

  test('a TZID without a VTIMEZONE is read as the IANA zone it names', () => {
    const data = ics(['BEGIN:VEVENT', 'UID:a@test', 'DTSTART;TZID=America/New_York:20261101T090000', 'DTEND;TZID=America/New_York:20261101T100000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Standup', 'END:VEVENT']);
    // New York leaves DST on 2026-11-01 at 02:00
    const out = expand(data, range('2026-10-31T00:00:00Z', '2026-11-05T00:00:00Z'), BERLIN);
    expect(out.map((o) => new Date(o.start).toISOString())).toEqual(['2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z']);
  });

  test('a moved occurrence and an EXDATE', () => {
    const data = ics([
      BERLIN_VTIMEZONE,
      'BEGIN:VEVENT',
      'UID:s@test',
      'DTSTART;TZID=Europe/Berlin:20261019T100000',
      'DTEND;TZID=Europe/Berlin:20261019T110000',
      'RRULE:FREQ=DAILY;COUNT=5',
      'EXDATE;TZID=Europe/Berlin:20261021T100000',
      'SUMMARY:Lecture',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:s@test',
      'RECURRENCE-ID;TZID=Europe/Berlin:20261022T100000',
      'DTSTART;TZID=Europe/Berlin:20261022T140000',
      'DTEND;TZID=Europe/Berlin:20261022T150000',
      'SUMMARY:Lecture (moved)',
      'END:VEVENT',
    ]);
    const out = expand(data, range('2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z'), BERLIN);
    expect(out.map((o) => `${new Date(o.start).toISOString().slice(0, 16)} ${o.title}`)).toEqual([
      '2026-10-19T08:00 Lecture',
      '2026-10-20T08:00 Lecture',
      '2026-10-22T12:00 Lecture (moved)',
      '2026-10-23T08:00 Lecture',
    ]);
  });

  test('an override or EXDATE in another zone than its series takes the occurrence at the same instant, not the same clock time', () => {
    // a daily 09:00 New York call (13:00 UTC); the server wrote its changes in UTC and in London time
    const data = ics([
      'BEGIN:VEVENT',
      'UID:ny@test',
      'DTSTART;TZID=America/New_York:20261019T090000',
      'DTEND;TZID=America/New_York:20261019T093000',
      'RRULE:FREQ=DAILY;COUNT=5',
      'EXDATE:20261022T130000Z',
      'SUMMARY:Sync',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:ny@test',
      'RECURRENCE-ID:20261020T130000Z',
      'DTSTART;TZID=America/New_York:20261020T150000',
      'DTEND;TZID=America/New_York:20261020T153000',
      'SUMMARY:Sync (moved, UTC)',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:ny@test',
      'RECURRENCE-ID;TZID=Europe/London:20261021T140000',
      'DTSTART:20261021T200000Z',
      'DTEND:20261021T203000Z',
      'SUMMARY:Sync (moved, London)',
      'END:VEVENT',
      // 09:00 in London is 04:00 in New York: no occurrence of this series, whatever the clock text says
      'BEGIN:VEVENT',
      'UID:ny@test',
      'RECURRENCE-ID;TZID=Europe/London:20261023T090000',
      'DTSTART;TZID=Europe/London:20261023T090000',
      'DTEND;TZID=Europe/London:20261023T093000',
      'SUMMARY:Not this one',
      'END:VEVENT',
    ]);
    const out = expand(data, range('2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z'), BERLIN);
    expect(out.map((o) => `${new Date(o.start).toISOString().slice(0, 16)} ${o.title}`)).toEqual([
      '2026-10-19T13:00 Sync',
      '2026-10-20T19:00 Sync (moved, UTC)',
      '2026-10-21T20:00 Sync (moved, London)',
      '2026-10-23T13:00 Sync',
    ]);
    // each names its occurrence the way the series writes it, so a change can find it
    expect(out[1].recurrenceId).toEqual({ value: '20261020T090000', tzid: 'America/New_York' });
  });

  test('overrides in UTC and London meet their occurrences across DST changes, and times the clocks pass twice or skip', () => {
    const at = (data: string, a: string, b: string) => expand(data, range(a, b), BERLIN).map((o) => `${new Date(o.start).toISOString().slice(0, 16)} ${o.title}`);
    // weekly 09:00 New York: London is on GMT from 25 Oct and New York on EST from 1 Nov, 4 hours apart on 28 Oct and 5 after
    const weekly = ics([
      'BEGIN:VEVENT',
      'UID:w@test',
      'DTSTART;TZID=America/New_York:20261021T090000',
      'DTEND;TZID=America/New_York:20261021T100000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:Review',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:w@test',
      'RECURRENCE-ID;TZID=Europe/London:20261028T130000',
      'DTSTART;TZID=America/New_York:20261028T110000',
      'DTEND;TZID=America/New_York:20261028T120000',
      'SUMMARY:Review at 11',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:w@test',
      'RECURRENCE-ID:20261104T140000Z',
      'DTSTART;TZID=America/New_York:20261104T110000',
      'DTEND;TZID=America/New_York:20261104T120000',
      'SUMMARY:Review at 11',
      'END:VEVENT',
    ]);
    expect(at(weekly, '2026-10-19T00:00:00Z', '2026-11-09T00:00:00Z')).toEqual(['2026-10-21T13:00 Review', '2026-10-28T15:00 Review at 11', '2026-11-04T16:00 Review at 11']);

    // 01:30 happens twice in New York on 1 Nov; RFC 5545 means the first (EDT, 05:30 UTC)
    const twice = ics([
      'BEGIN:VEVENT',
      'UID:t@test',
      'DTSTART;TZID=America/New_York:20261031T013000',
      'DTEND;TZID=America/New_York:20261031T020000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Backup',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:t@test',
      'RECURRENCE-ID:20261101T053000Z',
      'DTSTART;TZID=America/New_York:20261101T040000',
      'DTEND;TZID=America/New_York:20261101T043000',
      'SUMMARY:Backup late',
      'END:VEVENT',
    ]);
    expect(at(twice, '2026-10-30T00:00:00Z', '2026-11-04T00:00:00Z')).toEqual(['2026-10-31T05:30 Backup', '2026-11-01T09:00 Backup late', '2026-11-02T06:30 Backup']);

    // 02:30 does not happen in New York on 14 Mar 2027; RFC 5545 reads it with the offset from before (03:30 EDT, 07:30 UTC)
    const skipped = ics([
      'BEGIN:VEVENT',
      'UID:s@test',
      'DTSTART;TZID=America/New_York:20270313T023000',
      'DTEND;TZID=America/New_York:20270313T030000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Backup',
      'END:VEVENT',
    ]);
    expect(at(skipped, '2027-03-12T00:00:00Z', '2027-03-17T00:00:00Z')).toEqual(['2027-03-13T07:30 Backup', '2027-03-14T07:30 Backup', '2027-03-15T06:30 Backup']);
    const movedSkipped = skipped.replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:s@test', 'RECURRENCE-ID:20270314T073000Z', 'DTSTART;TZID=America/New_York:20270314T050000', 'DTEND;TZID=America/New_York:20270314T053000', 'SUMMARY:Backup late', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    expect(at(movedSkipped, '2027-03-12T00:00:00Z', '2027-03-17T00:00:00Z')).toEqual(['2027-03-13T07:30 Backup', '2027-03-14T09:00 Backup late', '2027-03-15T06:30 Backup']);

    // east of UTC the same: in Berlin 02:30 on 25 Oct is the first one (CEST), on 28 Mar 2027 it is 03:30 CEST
    const berlin = ics(['BEGIN:VEVENT', 'UID:b1@test', 'DTSTART;TZID=Europe/Berlin:20261025T023000', 'DURATION:PT15M', 'SUMMARY:Night', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b2@test', 'DTSTART;TZID=Europe/Berlin:20270328T023000', 'DURATION:PT15M', 'SUMMARY:Night', 'END:VEVENT']);
    expect(at(berlin, '2026-10-01T00:00:00Z', '2027-04-01T00:00:00Z')).toEqual(['2026-10-25T00:30 Night', '2027-03-28T01:30 Night']);
  });

  test('all-day, floating, free and cancelled events', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:hol@test',
      'DTSTART;VALUE=DATE:20261021',
      'DTEND;VALUE=DATE:20261022',
      'SUMMARY:Holiday',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:float@test',
      'DTSTART:20261021T120000',
      'DURATION:PT30M',
      'SUMMARY:Lunch',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:free@test',
      'DTSTART:20261021T150000Z',
      'DTEND:20261021T160000Z',
      'TRANSP:TRANSPARENT',
      'SUMMARY:Maybe',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:gone@test',
      'DTSTART:20261021T170000Z',
      'DTEND:20261021T180000Z',
      'STATUS:CANCELLED',
      'SUMMARY:Cancelled',
      'END:VEVENT',
    ]);
    const out = expand(data, range('2026-10-20T22:00:00Z', '2026-10-21T22:00:00Z'), BERLIN);
    expect(out.map((o) => [o.title, o.allDay, o.busy])).toEqual([
      ['Holiday', true, false],
      ['Lunch', false, true],
      ['Maybe', false, false],
    ]);
    // floating 12:00 is 12:00 in the owner's zone (10:00 UTC in summer time)
    expect(new Date(out[1].start).toISOString()).toBe('2026-10-21T10:00:00.000Z');
    expect(out[1].end - out[1].start).toBe(30 * 60_000);
    expect(new Date(out[0].start).toISOString()).toBe('2026-10-20T22:00:00.000Z');
  });

  test('a series that never ends stops at the range', () => {
    const data = ics(['BEGIN:VEVENT', 'UID:x@test', 'DTSTART:19900101T080000Z', 'DTEND:19900101T081500Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Pills', 'END:VEVENT']);
    const out = expand(data, range('2026-10-21T00:00:00Z', '2026-10-26T00:00:00Z'), BERLIN);
    expect(out).toHaveLength(5);
  });

  test('an extra date given as a period (RDATE;VALUE=PERIOD) is an occurrence; one broken series does not hide the rest', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:p@test',
      'DTSTART:20261019T100000Z',
      'DTEND:20261019T110000Z',
      'RDATE;VALUE=PERIOD:20261022T150000Z/20261022T160000Z',
      'SUMMARY:Tutoring',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:broken@test',
      'DTSTART:20261019T080000Z',
      'DTEND:20261019T083000Z',
      'RRULE:FREQ=DAILY',
      'SUMMARY:Broken',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:broken@test',
      'RECURRENCE-ID:20261020T080000Z',
      'SUMMARY:Moved, but says nowhere to',
      'END:VEVENT',
    ]);
    const out = expand(data, range('2026-10-19T00:00:00Z', '2026-10-24T00:00:00Z'), BERLIN);
    expect(out.filter((o) => o.title === 'Tutoring').map((o) => new Date(o.start).toISOString().slice(0, 16))).toEqual(['2026-10-19T10:00', '2026-10-22T15:00']);
  });

  test('zone names', () => {
    expect(ianaZone('/mozilla.org/20050126_1/Europe/Berlin')).toBe('Europe/Berlin');
    expect(ianaZone('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(ianaZone('Nowhere/Land')).toBeUndefined();
  });
});

describe('write', () => {
  test('a new event in UTC, with attendees and a project, reads back the same', () => {
    const { uid, ics: data } = buildEvent({ title: 'Plan, review; ship', start: '2026-10-28T09:00', end: '2026-10-28T10:30', attendees: ['ana@example.com'], project: 'Thesis', description: 'line one\nline two' }, { ownerZone: BERLIN, organizer: 'me@example.com', now: utc('2026-10-21T00:00:00Z') });
    expect(data).toContain('DTSTART:20261028T080000Z');
    expect(data).toContain('SUMMARY:Plan\\, review\\; ship');
    expect(data).toContain('ORGANIZER:mailto:me@example.com');
    const [o] = expand(data, range('2026-10-27T00:00:00Z', '2026-10-30T00:00:00Z'), BERLIN);
    expect(o).toMatchObject({ uid, title: 'Plan, review; ship', project: 'Thesis', description: 'line one\nline two', attendees: [{ email: 'ana@example.com', status: 'needs-action' }] });
    expect(o.end - o.start).toBe(90 * 60_000);
  });

  test('moving one occurrence adds an override; deleting one adds an EXDATE; the rest stay', () => {
    const data = ics([BERLIN_VTIMEZONE, 'BEGIN:VEVENT', 'UID:r@test', 'DTSTART;TZID=Europe/Berlin:20261019T070000', 'DTEND;TZID=Europe/Berlin:20261019T073000', 'RRULE:FREQ=DAILY;COUNT=4', 'SUMMARY:Run', 'END:VEVENT']);
    const r = range('2026-10-18T00:00:00Z', '2026-10-25T00:00:00Z');
    const before = expand(data, r, BERLIN);
    const moved = updateEvent(data, 'r@test', { title: 'Run (late)', start: '2026-10-20T19:00', end: '2026-10-20T19:30' }, { ownerZone: BERLIN }, before[1].recurrenceId);
    const after = expand(moved, r, BERLIN);
    expect(after.map((o) => o.title)).toEqual(['Run', 'Run (late)', 'Run', 'Run']);
    expect(new Date(after[1].start).toISOString()).toBe('2026-10-20T17:00:00.000Z');
    const cut = excludeOccurrence(moved, 'r@test', before[2].recurrenceId!);
    expect(expand(cut, r, BERLIN).map((o) => new Date(o.start).toISOString().slice(0, 10))).toEqual(['2026-10-19', '2026-10-20', '2026-10-22']);
  });

  test('changing or deleting an occurrence whose override is in another zone replaces that override instead of adding one', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:ny@test',
      'DTSTART;TZID=America/New_York:20261019T090000',
      'DTEND;TZID=America/New_York:20261019T093000',
      'RRULE:FREQ=DAILY;COUNT=4',
      'SUMMARY:Sync',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:ny@test',
      'RECURRENCE-ID:20261020T130000Z',
      'DTSTART;TZID=America/New_York:20261020T150000',
      'DTEND;TZID=America/New_York:20261020T153000',
      'SUMMARY:Sync (moved)',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:ny@test',
      'RECURRENCE-ID;TZID=Europe/London:20261021T140000',
      'DTSTART;TZID=America/New_York:20261021T160000',
      'DTEND;TZID=America/New_York:20261021T163000',
      'SUMMARY:Sync (moved too)',
      'END:VEVENT',
    ]);
    const r = range('2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z');
    const line = (o: { start: number; title: string }) => `${new Date(o.start).toISOString().slice(0, 16)} ${o.title}`;
    const before = expand(data, r, BERLIN);
    expect(before.map(line)).toEqual(['2026-10-19T13:00 Sync', '2026-10-20T19:00 Sync (moved)', '2026-10-21T20:00 Sync (moved too)', '2026-10-22T13:00 Sync']);
    // the owner in Berlin moves the moved one again, to 22:00 their time
    const changed = updateEvent(data, 'ny@test', { title: 'Sync (late)', start: '2026-10-20T22:00', end: '2026-10-20T22:30' }, { ownerZone: BERLIN }, before[1].recurrenceId);
    expect(changed.match(/^RECURRENCE-ID/gm)).toHaveLength(2);
    expect(changed).toContain('RECURRENCE-ID:20261020T130000Z');
    expect(expand(changed, r, BERLIN).map(line)).toEqual(['2026-10-19T13:00 Sync', '2026-10-20T20:00 Sync (late)', '2026-10-21T20:00 Sync (moved too)', '2026-10-22T13:00 Sync']);
    // deleting the other one takes its override out with it
    const cut = excludeOccurrence(changed, 'ny@test', before[2].recurrenceId!);
    expect(cut).not.toContain('Sync (moved too)');
    expect(cut).toContain('EXDATE;TZID=America/New_York:20261021T090000');
    expect(expand(cut, r, BERLIN).map(line)).toEqual(['2026-10-19T13:00 Sync', '2026-10-20T20:00 Sync (late)', '2026-10-22T13:00 Sync']);
  });

  test('all-day: an override and an EXDATE name their day, and a change or a delete finds it across the DST change', () => {
    // a weekly all-day market on Saturdays; Berlin goes to winter time in the night to Sunday 25 Oct
    const data = ics([
      'BEGIN:VEVENT',
      'UID:m@test',
      'DTSTART;VALUE=DATE:20261017',
      'DTEND;VALUE=DATE:20261018',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE;VALUE=DATE:20261107',
      'SUMMARY:Market',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:m@test',
      'RECURRENCE-ID;VALUE=DATE:20261024',
      'DTSTART;VALUE=DATE:20261025',
      'DTEND;VALUE=DATE:20261026',
      'SUMMARY:Market (Sunday)',
      'END:VEVENT',
    ]);
    const r = range('2026-10-12T00:00:00Z', '2026-11-12T00:00:00Z');
    const line = (o: { start: number; title: string }) => `${new Date(o.start).toISOString().slice(0, 16)} ${o.title}`;
    const before = expand(data, r, BERLIN);
    expect(before.map(line)).toEqual(['2026-10-16T22:00 Market', '2026-10-24T22:00 Market (Sunday)', '2026-10-30T23:00 Market']);
    expect(before.every((o) => o.allDay)).toBe(true);
    // the Sunday the clocks go back has 25 hours
    expect(before[1].end - before[1].start).toBe(25 * 3_600_000);
    expect(before[1].recurrenceId).toEqual({ value: '20261024', date: true });
    const changed = updateEvent(data, 'm@test', { title: 'Market (rain)', start: '2026-10-25', end: '2026-10-26', allDay: true }, { ownerZone: BERLIN }, before[1].recurrenceId);
    expect(changed.match(/^RECURRENCE-ID/gm)).toHaveLength(1);
    const cut = excludeOccurrence(changed, 'm@test', before[2].recurrenceId!);
    expect(expand(cut, r, BERLIN).map(line)).toEqual(['2026-10-16T22:00 Market', '2026-10-24T22:00 Market (rain)']);
  });

  test('moving a whole series keeps its zone and rule', () => {
    const data = ics([BERLIN_VTIMEZONE, 'BEGIN:VEVENT', 'UID:w@test', 'DTSTART;TZID=Europe/Berlin:20261014T180000', 'DTEND;TZID=Europe/Berlin:20261014T190000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Gym', 'END:VEVENT']);
    const next = updateEvent(data, 'w@test', { title: 'Gym', start: '2026-10-14T19:00', end: '2026-10-14T20:00' }, { ownerZone: BERLIN });
    expect(next).toContain('RRULE:FREQ=WEEKLY');
    const out = expand(next, range('2026-10-19T00:00:00Z', '2026-11-02T00:00:00Z'), BERLIN);
    expect(out.map((o) => new Date(o.start).toISOString())).toEqual(['2026-10-21T17:00:00.000Z', '2026-10-28T18:00:00.000Z']);
  });

  test('a series in another zone than the owner\'s moves by the change, in its own zone', () => {
    // a weekly 09:00 New York call on a Berlin owner's calendar; the owner moves it an hour later from the 28 Oct one
    const data = ics(['BEGIN:VEVENT', 'UID:ny@test', 'DTSTART;TZID=America/New_York:20261007T090000', 'DTEND;TZID=America/New_York:20261007T093000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Sync', 'END:VEVENT']);
    const r = range('2026-10-26T00:00:00Z', '2026-11-12T00:00:00Z');
    const before = expand(data, r, BERLIN);
    // 28 Oct 09:00 in New York (still summer time there) is 14:00 in Berlin (already winter time)
    expect(new Date(before[0].start).toISOString()).toBe('2026-10-28T13:00:00.000Z');
    const next = updateEvent(data, 'ny@test', { title: 'Sync', start: '2026-10-28T15:00', end: '2026-10-28T15:30' }, { ownerZone: BERLIN }, undefined, { before: before[0] });
    const after = expand(next, range('2026-10-01T00:00:00Z', '2026-11-12T00:00:00Z'), BERLIN);
    expect(next).toContain('DTSTART;TZID=America/New_York:20261007T100000');
    // every week at 10:00 New York time, across New York's own change on 1 Nov
    expect(after.map((o) => new Date(o.start).toISOString().slice(0, 16))).toEqual(['2026-10-07T14:00', '2026-10-14T14:00', '2026-10-21T14:00', '2026-10-28T14:00', '2026-11-04T15:00', '2026-11-11T15:00']);
  });

  test('local times', () => {
    expect(new Date(localToEpoch('2026-10-25T02:30', BERLIN)).toISOString()).toMatch(/^2026-10-25T0[01]:30/);
    expect(Number.isNaN(localToEpoch('tomorrow', BERLIN))).toBe(true);
    // a date that does not exist is not quietly the next one (2026 is not a leap year)
    expect(Number.isNaN(localToEpoch('2026-02-29', BERLIN))).toBe(true);
    expect(Number.isNaN(localToEpoch('2026-13-01T10:00', BERLIN))).toBe(true);
    expect(Number.isNaN(localToEpoch('2026-10-21T24:30', BERLIN))).toBe(true);
    expect(new Date(localToEpoch('2028-02-29', BERLIN)).toISOString()).toBe('2028-02-28T23:00:00.000Z');
  });
});
