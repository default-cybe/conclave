/**
 * The words on Settings > Models > Accounts (src/lib/accounts.ts): window
 * names, reset times, budgets, and the "Now using Account 2 (resets Tue
 * 10:00, 45% left)" line.
 *
 *   bun test packages/web/test/accounts-words.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { AccountDto, AccountNowDto } from '@conclave/core/client';
import { budgetWords, nowLine, resetWords, rowWindows, sharedModels, usedOf, windowName } from '../src/lib/accounts';

// Monday 19 October 2026, 09:00 local
const NOW = new Date(2026, 9, 19, 9, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

const acct = (id: string, label: string, extra: Partial<AccountDto> = {}): AccountDto => ({ id, label, vendor: 'anthropic', vendorName: 'Claude', kind: 'subscription', enabled: true, state: 'ready', windows: [], models: [], saved: true, ...extra });

describe('account words', () => {
  test('window names', () => {
    expect(['5h', '7d', '7d opus', '7d sonnet', '7d fable', 'budget'].map((name) => windowName({ name }))).toEqual(['5 hours', 'Week', 'Week, Opus', 'Week, Sonnet', 'Fable', 'Budget']);
  });

  test('reset times: today as a time, this week with the day, later as a date', () => {
    expect(resetWords(at(19, 14, 10), NOW)).toBe('14:10');
    expect(resetWords(at(20, 10), NOW)).toBe('Tue 10:00');
    expect(resetWords(at(26, 6), NOW)).toBe('Mon 06:00');
    expect(resetWords(at(29, 10), NOW)).toBe('29 Oct');
  });

  test('a budget in dollars, unknown windows stay unknown', () => {
    expect(budgetWords({ name: 'budget', kind: 'budget', limit: 100, remaining: 61.6 })).toBe('$38.40 of $100');
    expect(budgetWords({ name: '5h', usedPercent: 3 })).toBeUndefined();
    expect(usedOf({ name: '5h' })).toBeUndefined();
    expect(usedOf({ name: '5h', usedPercent: 44.6 })).toBe(45);
    expect(rowWindows(acct('a', 'A', { windows: [{ name: '5h' }, { name: 'requests', kind: 'rate' }, { name: '7d oauth apps' }, { name: 'budget', kind: 'budget' }] })).map((w) => w.name)).toEqual(['5h', 'budget']);
  });

  test("the owner's line: Account 1 at its 5 hour limit, Account 2 takes the call", () => {
    const accounts = [acct('a1', 'Account 1', { state: 'limited', until: at(19, 10, 23) }), acct('a2', 'Account 2')];
    const n: AccountNowDto = { vendor: 'anthropic', vendorName: 'Claude', account: 'a2', window: { name: '7d', usedPercent: 55, resetsAt: at(20, 10) }, skipped: [{ account: 'a1', reason: '5 hour limit reached' }] };
    expect(nowLine(n, accounts, NOW)).toEqual({ lead: 'Now using Account 2 (resets Tue 10:00, 45% left).', why: ['Account 1: 5 hour limit reached until 10:23.'], tone: 'warn' });
    expect(nowLine({ vendor: 'anthropic', vendorName: 'Claude', skipped: [], until: at(19, 10, 23) }, accounts, NOW)).toMatchObject({ lead: 'No Claude account can take a call until 10:23.', tone: 'fault' });
    expect(nowLine({ vendor: 'anthropic', vendorName: 'Claude', account: 'a2', skipped: [] }, accounts, NOW)).toEqual({ lead: 'Now using Account 2.', why: [], tone: 'ok' });
  });

  test('Per model offers models two or more plans list, from any vendor, until they have an order', () => {
    const opus = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
    const accounts = [
      acct('c', 'Claude', { models: [opus, { id: 'claude-sonnet-5-5', name: 'Sonnet' }] }),
      acct('g', 'Antigravity', { vendor: 'gemini', vendorName: 'Gemini', models: [{ id: 'ag/claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'gemini-3-pro', name: 'Gemini 3 Pro' }] }),
      acct('k', 'Claude API key', { kind: 'api', models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet' }] }),
    ];
    expect(sharedModels({ accounts, routes: [] })).toEqual([opus]);
    expect(sharedModels({ accounts, routes: [{ vendor: 'anthropic', vendorName: 'Claude', match: 'claude-opus-5-5', order: ['g', 'c'] }] })).toEqual([]);
  });
});
