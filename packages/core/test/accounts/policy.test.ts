/**
 * The owner's week at fixed times: Account 1 has a 5 hour limit only,
 * Account 2 is a 20x plan whose weekly limit resets Tuesday 10:00 UTC, and
 * the API key's budget resets on the 22nd.
 */
import { describe, expect, test } from 'bun:test';
import { assess, orderIds, pickAccount, priorities, routeFor, type AccountView } from '../../src/accounts/policy';
import { windowApplies, windowKind, windowLength } from '../../src/accounts/windows';
import type { LimitWindow } from '../../src/types';

const Z = (iso: string) => Date.parse(iso);
const H = 3_600_000;

function acct1(w: LimitWindow[] = []): AccountView {
  return { id: 'account-1', kind: 'subscription', enabled: true, windows: w };
}
function acct2(w: LimitWindow[] = []): AccountView {
  return { id: 'account-2', kind: 'subscription', enabled: true, windows: w };
}
function api(spentUsd: number, periodEnd = Z('2026-10-22T00:00:00Z')): AccountView {
  return { id: 'api-anthropic', kind: 'api', enabled: true, windows: [], budget: { usd: 100, spentUsd, periodEnd, hardStop: true } };
}
const w5h = (used: number, resetsAt: number): LimitWindow => ({ name: '5h', usedPercent: used, resetsAt, kind: 'session', windowMs: 5 * H });
const w7d = (used: number, resetsAt = Z('2026-10-20T10:00:00Z')): LimitWindow => ({ name: '7d', usedPercent: used, resetsAt, kind: 'weekly', windowMs: 7 * 24 * H });

describe("the owner's order: Account 1, Account 2, then the API key", () => {
  test('Monday 09:00: Account 1 has room, so it takes the call', () => {
    const now = Z('2026-10-19T09:00:00Z');
    const r = pickAccount([acct1([w5h(40, Z('2026-10-19T11:00:00Z'))]), acct2([w7d(60)]), api(40)], now);
    expect(r.account).toBe('account-1');
    expect(r.skipped).toEqual([]);
    expect(r.verdicts[0]).toMatchObject({ state: 'ready', window: { name: '5h', usedPercent: 40 } });
  });

  test('Monday 10:30: Account 1 hit its 5 hour limit until 12:00, Account 2 takes over', () => {
    const now = Z('2026-10-19T10:30:00Z');
    const r = pickAccount([acct1([w5h(100, Z('2026-10-19T12:00:00Z'))]), acct2([w7d(60)]), api(40)], now);
    expect(r.account).toBe('account-2');
    expect(r.skipped).toEqual([{ account: 'account-1', reason: '5 hour limit reached' }]);
    expect(r.verdicts[0]).toMatchObject({ state: 'limited', until: Z('2026-10-19T12:00:00Z') });
    expect(r.verdicts[1].window).toMatchObject({ name: '7d', usedPercent: 60, resetsAt: Z('2026-10-20T10:00:00Z') });
  });

  test('Monday 13:00: the 5 hour window reset, so Account 1 is first again (its old numbers are unknown, not full)', () => {
    const now = Z('2026-10-19T13:00:00Z');
    const r = pickAccount([acct1([w5h(100, Z('2026-10-19T12:00:00Z'))]), acct2([w7d(60)]), api(40)], now);
    expect(r.account).toBe('account-1');
    expect(r.verdicts[0].state).toBe('unknown');
  });

  test('Monday 20:00: both plans are full, the API key takes the call', () => {
    const now = Z('2026-10-19T20:00:00Z');
    const r = pickAccount([acct1([w5h(100, Z('2026-10-19T23:00:00Z'))]), acct2([w7d(100)]), api(40)], now);
    expect(r.account).toBe('api-anthropic');
    expect(r.skipped.map((s) => s.reason)).toEqual(['5 hour limit reached', 'Weekly limit reached']);
  });

  test('Monday 20:00 with the budget spent: nothing takes the call; it says when the first opens', () => {
    const now = Z('2026-10-19T20:00:00Z');
    const r = pickAccount([acct1([w5h(100, Z('2026-10-19T23:00:00Z'))]), acct2([w7d(100)]), api(100)], now);
    expect(r.account).toBeUndefined();
    expect(r.verdicts[2]).toMatchObject({ state: 'budget', reason: 'Budget spent', until: Z('2026-10-22T00:00:00Z') });
    expect(r.until).toBe(Z('2026-10-19T23:00:00Z'));
  });

  test('Tuesday 10:30: the weekly reset passed; Account 2 is usable again', () => {
    const now = Z('2026-10-20T10:30:00Z');
    const r = pickAccount([acct1([w5h(100, Z('2026-10-20T14:00:00Z'))]), acct2([w7d(100)]), api(100)], now);
    expect(r.account).toBe('account-2');
    expect(r.verdicts[1].state).toBe('unknown');
  });

  test('the 22nd: the budget period ended, the API key is usable with a new spend', () => {
    const now = Z('2026-10-22T08:00:00Z');
    const r = pickAccount([acct1([w5h(100, Z('2026-10-22T09:00:00Z'))]), acct2([w7d(100, Z('2026-10-27T10:00:00Z'))]), api(0, Z('2026-11-22T00:00:00Z'))], now);
    expect(r.account).toBe('api-anthropic');
  });
});

describe('what blocks an account', () => {
  const now = Z('2026-10-19T12:00:00Z');

  test('missing windows are unknown, not zero, and still usable', () => {
    expect(assess(acct1([]), now)).toEqual({ id: 'account-1', state: 'unknown' });
    // a reset time without a percent says nothing about room
    expect(assess(acct1([{ name: '5h', resetsAt: now + H }]), now).state).toBe('unknown');
    expect(pickAccount([acct1([]), acct2([w7d(10)])], now).account).toBe('account-1');
    // an API key with no numbers is simply ready
    expect(assess({ ...api(0), budget: undefined }, now).state).toBe('ready');
  });

  test('a weekly Opus window blocks Opus only', () => {
    const a = acct2([w7d(50), { name: '7d opus', usedPercent: 100, resetsAt: now + 30 * H }]);
    expect(assess(a, now, 'claude-opus-5-5')).toMatchObject({ state: 'limited', reason: 'Weekly Opus limit reached' });
    expect(assess(a, now, 'claude-sonnet-5-5').state).toBe('ready');
    expect(assess(a, now).state).toBe('ready');
    expect(windowApplies({ name: '7d oauth apps', usedPercent: 100 }, 'claude-opus-5-5')).toBe(false);
    expect(windowApplies({ name: '7d fable', usedPercent: 100 }, 'claude-fable-5')).toBe(true);
  });

  test('paused, signed out, a cooldown, a block the hub saw', () => {
    expect(assess({ ...acct1(), enabled: false }, now).state).toBe('paused');
    expect(assess({ ...acct1(), error: 'Signed out' }, now)).toMatchObject({ state: 'error', reason: 'Signed out' });
    const cool = { ...acct1(), cooldowns: [{ reason: 'quota', until: now + 600_000 }] };
    expect(assess(cool, now)).toMatchObject({ state: 'cooldown', reason: 'Hit its limit', until: now + 600_000 });
    const modelCool = { ...acct1(), cooldowns: [{ model: 'claude-opus-5-5', reason: 'model_not_supported', until: now + 600_000 }] };
    expect(assess(modelCool, now, 'claude-sonnet-5-5').state).toBe('unknown');
    expect(assess(modelCool, now, 'claude-opus-5-5').state).toBe('cooldown');
    expect(assess({ ...acct1([w5h(30, now + H)]), blockedUntil: now + 60_000 }, now).state).toBe('limited');
    expect(assess({ ...acct1([w5h(30, now + H)]), blockedUntil: now - 1 }, now).state).toBe('ready');
  });

  test('a budget without hard stop never blocks', () => {
    expect(assess({ ...api(150), budget: { usd: 100, spentUsd: 150, periodEnd: now + H, hardStop: false } }, now).state).toBe('ready');
  });

  test('an account that does not offer the model is passed over', () => {
    const r = pickAccount([{ ...acct1(), models: ['claude-sonnet-5-5'] }, acct2()], now, 'claude-opus-5-5');
    expect(r).toMatchObject({ account: 'account-2', skipped: [{ account: 'account-1', reason: 'Does not offer this model' }] });
    // a prefixed model id matches the bare one
    expect(pickAccount([{ ...acct1(), models: ['neu/claude-opus-5-5'] }], now, 'claude-opus-5-5').account).toBe('account-1');
  });
});

describe('the order and CLIProxyAPI priorities', () => {
  const list = [
    { id: 'api-anthropic', kind: 'api' as const },
    { id: 'account-2', kind: 'subscription' as const },
    { id: 'account-1', kind: 'subscription' as const },
  ];

  test('accounts left out of the order come after it, subscriptions before API keys', () => {
    expect(orderIds(list)).toEqual(['account-2', 'account-1', 'api-anthropic']);
    expect(orderIds(list, ['account-1'])).toEqual(['account-1', 'account-2', 'api-anthropic']);
    expect(orderIds(list, ['account-1', 'gone', 'account-1', 'api-anthropic', 'account-2'])).toEqual(['account-1', 'api-anthropic', 'account-2']);
  });

  test('a model match wins over the vendor default', () => {
    const routes = [
      { vendor: 'anthropic', order: ['account-1', 'account-2'] },
      { vendor: 'anthropic', match: 'claude-opus-*', order: ['account-2'] },
      { vendor: 'openai', order: ['x'] },
    ];
    expect(routeFor(routes, 'anthropic', 'claude-opus-5-5')?.order).toEqual(['account-2']);
    expect(routeFor(routes, 'anthropic', 'neu/claude-opus-5-5')?.order).toEqual(['account-2']);
    expect(routeFor(routes, 'anthropic', 'claude-sonnet-5-5')?.order).toEqual(['account-1', 'account-2']);
    expect(routeFor(routes, 'gemini', 'gemini-4')).toBeUndefined();
  });

  test('the first credential gets the highest priority', () => {
    expect([...priorities(['claude-a.json', 'claude-b.json', 'claude-c.json'])]).toEqual([
      ['claude-a.json', 3],
      ['claude-b.json', 2],
      ['claude-c.json', 1],
    ]);
  });

  test('window kinds and lengths from their names', () => {
    expect([windowKind('5h'), windowLength('5h')]).toEqual(['session', 5 * H]);
    expect([windowKind('7d opus'), windowLength('7d opus')]).toEqual(['weekly', 7 * 24 * H]);
    expect(windowKind('budget')).toBe('budget');
    expect([windowKind('requests'), windowLength('tokens')]).toEqual(['rate', 60_000]);
    expect(windowKind('extra usage')).toBe('extra');
  });
});
