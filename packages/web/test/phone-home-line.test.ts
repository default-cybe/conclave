/**
 * Home on a phone says one line under the greeting, not a stack of four
 * (features/home/PhoneHome.tsx homeLine).
 *
 *   bun test packages/web/test/phone-home-line.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { homeLine } from '../src/features/home/PhoneHome';

describe('phone Home line', () => {
  test('what waits on you comes first, in amber, with proposals on the same line', () => {
    expect(homeLine({ waiting: 4, proposals: 2, next: 'Now: standup', learnings: 3 })).toEqual({ text: '4 need you, 2 proposals', href: '/approvals', warn: true });
    expect(homeLine({ waiting: 1, proposals: 0, learnings: 0 })).toEqual({ text: '1 needs you', href: '/approvals', warn: true });
    expect(homeLine({ waiting: 0, proposals: 1, learnings: 0 })).toEqual({ text: '1 proposal to approve', href: '/today', warn: true });
  });

  test('else the next event, else the learnings, quiet; else nothing', () => {
    expect(homeLine({ waiting: 0, proposals: 0, next: 'Now: standup', learnings: 3 })).toEqual({ text: 'Now: standup', href: '/today', warn: false });
    expect(homeLine({ waiting: 0, proposals: 0, learnings: 3 })).toEqual({ text: '3 learnings wait for review in Reflect', href: '/settings/reflect', warn: false });
    expect(homeLine({ waiting: 0, proposals: 0, learnings: 0 })).toBeUndefined();
  });

  test('what setup left for later comes last, quiet, to Settings, About', () => {
    expect(homeLine({ waiting: 0, proposals: 0, learnings: 0, later: 3 })).toEqual({ text: '3 things to set up later', href: '/settings/about#setup-later', warn: false });
    expect(homeLine({ waiting: 0, proposals: 0, learnings: 0, later: 1 })?.text).toBe('1 thing to set up later');
    expect(homeLine({ waiting: 0, proposals: 0, learnings: 2, later: 3 })?.href).toBe('/settings/reflect');
    expect(homeLine({ waiting: 0, proposals: 0, learnings: 0, later: 0 })).toBeUndefined();
  });
});
