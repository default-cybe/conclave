/**
 * The window starter's line on an account row (src/lib/accounts.ts
 * starterLine): "Next start 14:03", "Started 09:00", "Stopped until
 * tomorrow: 429", and the note shown once.
 *
 *   bun test packages/web/test/starter-words.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { StarterDto } from '@conclave/core/client';
import { STARTER_NOTE, sinceWords, starterLine } from '../src/lib/accounts';

// Friday 23 October 2026, 12:00 local
const NOW = new Date(2026, 9, 23, 12, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const s = (extra: Partial<StarterDto>): StarterDto => ({ enabled: true, start: '07:00', end: '22:30', zone: 'Europe/Berlin', state: 'scheduled', ...extra });

describe('window starter words', () => {
  test('off says nothing', () => {
    expect(starterLine(s({ enabled: false, state: 'off' }), NOW).text).toBe('');
    expect(starterLine(undefined, NOW).text).toBe('');
  });

  test('the next start, and when it last started a window', () => {
    expect(starterLine(s({ nextAt: at(23, 14, 3) }), NOW)).toEqual({ text: 'Next start 14:03.', tone: 'ok' });
    expect(starterLine(s({ nextAt: at(23, 14, 3), startedAt: at(23, 9, 0) }), NOW).text).toBe('Next start 14:03. Started 09:00.');
    expect(starterLine(s({ nextAt: at(24, 7, 0), startedAt: at(22, 21, 40) }), NOW).text).toBe('Next start Sat 07:00. Started yesterday 21:40.');
    expect(sinceWords(at(19, 8, 0), NOW)).toBe('19 Oct');
    // a time already past: it goes now
    expect(starterLine(s({ nextAt: at(23, 11, 0) }), NOW).text).toBe('Starting now.');
    expect(starterLine(s({ nextAt: at(23, 12, 5), failures: 1, reason: 'Server error' }), NOW)).toEqual({ text: 'Failed: server error. Next try 12:05.', tone: 'warn' });
  });

  test('stopped until tomorrow, paused for the week, and the rest', () => {
    expect(starterLine(s({ state: 'stopped', until: at(24, 7, 0), reason: '429' }), NOW)).toEqual({ text: 'Stopped until tomorrow: 429.', tone: 'fault' });
    expect(starterLine(s({ state: 'stopped', until: at(23, 22, 0), reason: 'Sign-in failed' }), NOW).text).toBe('Stopped until 22:00: Sign-in failed.');
    expect(starterLine(s({ state: 'paused', until: at(27, 10, 0), reason: 'Weekly limit used up' }), NOW)).toEqual({ text: 'Paused: weekly limit used up until Tue 10:00.', tone: 'warn' });
    expect(starterLine(s({ state: 'checking' }), NOW).text).toBe('Sent its request. Checking that the window started.');
    expect(starterLine(s({ state: 'never', reason: 'No 5 hour window' }), NOW).text).toBe('This plan has no 5-hour window, so there is nothing to start.');
    expect(starterLine(s({ state: 'setup', reason: 'Cannot pin a request to it' }), NOW).text).toBe('Cannot reach this account alone. Give it a short name in Settings > Models > Accounts.');
    expect(starterLine(s({ state: 'waiting', reason: 'No usage read yet' }), NOW).text).toBe('Waiting for the first usage read.');
    expect(starterLine(s({ state: 'waiting', reason: 'Account paused' }), NOW).text).toBe('Waits while the account is paused.');
  });

  test('the note, in the house words', () => {
    expect(STARTER_NOTE).toBe('Some providers limit automated use of subscription accounts. This sends one tiny request per window. Use at your own risk.');
    for (const t of [STARTER_NOTE, starterLine(s({ nextAt: at(23, 14, 3) }), NOW).text]) expect(t).not.toMatch(/—/);
  });
});
