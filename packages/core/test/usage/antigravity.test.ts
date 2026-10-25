import { describe, expect, test } from 'bun:test';
import { assess, pickAccount, usable } from '../../src/accounts/policy';
import { annotateWindow } from '../../src/accounts/windows';
import { antigravityProject, mapAntigravityQuota, mapAntigravityUsage } from '../../src/usage/readers/antigravity';

const credits = (creditAmount: unknown, minimum: unknown = undefined) => mapAntigravityUsage({
  paidTier: { id: 'GOOGLE_ONE_AI_PREMIUM', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount, minimumCreditAmountForUsage: minimum }] },
});

describe('Antigravity informational credits', () => {
  test('keeps exact raw fractional balance, without a limit or percentage', () => {
    expect(credits('96.512345', '5')).toEqual({ plan: 'AI Pro', windows: [{ name: 'credits', kind: 'extra', remaining: 96.512345 }] });
  });

  test('below-minimum and zero credits do not block ordinary model access', () => {
    for (const amount of [0, 1.234567]) {
      const { windows } = credits(amount, 5);
      const account = { id: 'google', kind: 'subscription' as const, enabled: true, windows };
      expect(windows).toEqual([{ name: 'credits', kind: 'extra', remaining: amount }]);
      for (const model of [undefined, 'gemini-3-pro', 'claude-opus-5-5']) {
        expect(usable(assess(account, 1000, model))).toBe(true);
        expect(assess(account, 1000, model).window).toBeUndefined();
        expect(pickAccount([account], 1000, model).account).toBe('google');
      }
      expect(assess({ ...account, cooldowns: [{ reason: 'quota', until: 2000 }] }, 1000).state).toBe('cooldown');
    }
  });

  test('missing or malformed minimum never creates spending eligibility', () => {
    for (const minimum of [undefined, null, '', 'bad', false, {}, Infinity]) {
      expect(credits('1.234567', minimum).windows).toEqual([{ name: 'credits', kind: 'extra', remaining: 1.234567 }]);
    }
  });

  test('ignores malformed balances and credit lists', () => {
    for (const amount of [undefined, null, '', ' ', 'bad', false, {}, [], Infinity, NaN, 'Infinity']) {
      expect(credits(amount, 5)).toEqual({ plan: 'AI Pro', windows: [] });
    }
    for (const availableCredits of [undefined, null, {}, 'bad', [null, false, {}, { creditAmount: 'bad' }]]) {
      expect(mapAntigravityUsage({ paidTier: { availableCredits } }).windows).toEqual([]);
    }
    expect(mapAntigravityUsage(undefined)).toEqual({ windows: [] });
    expect(mapAntigravityUsage({ currentTier: { id: 'INDIVIDUAL_STANDARD_NOCC' } })).toEqual({ plan: 'Standard', windows: [] });
  });
});

describe('Antigravity quota summary', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
  const bucket = (bucketId: string, window: string, extra: Record<string, unknown> = {}) => ({ bucketId, window, displayName: bucketId, ...extra });
  // prod: both groups; daily: only the 3p group (Gemini left out)
  const prod = {
    groups: [
      { buckets: [bucket('gemini-5h', '5h', { remainingFraction: 0.75, resetTime: at(3) }), bucket('gemini-weekly', 'weekly', { remainingFraction: 0.4, resetTime: at(72) })] },
      { buckets: [bucket('3p-5h', '5h', { remainingFraction: 0.9, resetTime: at(2) }), bucket('3p-weekly', 'weekly', { remainingFraction: 1, resetTime: at(168) })] },
    ],
  };
  const daily = { groups: [{ buckets: [bucket('3p-5h', '5h', { remainingFraction: 0.5, resetTime: at(2) }), bucket('3p-weekly', 'weekly', { remainingFraction: 1, resetTime: at(168) })] }] };

  test('reads both hosts, keeps the lower remaining per bucket, and Gemini from the host that has it', () => {
    expect(mapAntigravityQuota([daily, prod])).toEqual([
      { name: '5h 3p', usedPercent: 50, resetsAt: now + 2 * 3_600_000 },
      // fraction 1: the window has not started, so no reset
      { name: '7d 3p', usedPercent: 0 },
      { name: '5h gemini', usedPercent: 25, resetsAt: now + 3 * 3_600_000 },
      { name: '7d gemini', usedPercent: 60, resetsAt: now + 72 * 3_600_000 },
    ]);
    // a failed host reads as nothing
    expect(mapAntigravityQuota([undefined, prod])).toHaveLength(4);
    expect(mapAntigravityQuota([undefined, undefined])).toEqual([]);
  });

  test('a disabled bucket is skipped; a missing fraction with a reset is 0 left; top-level buckets count', () => {
    const spent = {
      buckets: [
        // the week is spent (proto3 left the zero out), so the 5h bucket comes back disabled and full
        bucket('gemini-weekly', 'weekly', { resetTime: at(30) }),
        bucket('gemini-5h', '5h', { remainingFraction: 1, disabled: true }),
        // no fraction and no reset: unknown, left out
        bucket('3p-5h', '5h'),
        // another bucket keeps its own scope (informational until windows.ts knows it)
        bucket('gemini-argon-wtu-weekly', 'weekly', { remainingFraction: 0.2, resetTime: at(50) }),
      ],
    };
    expect(mapAntigravityQuota([spent])).toEqual([
      { name: '7d gemini', usedPercent: 100, resetsAt: now + 30 * 3_600_000 },
      { name: '7d gemini-argon-wtu', usedPercent: 80, resetsAt: now + 50 * 3_600_000 },
    ]);
    expect(mapAntigravityQuota([{ groups: 'bad', buckets: [null, { bucketId: 5 }, bucket('x-monthly', 'monthly', { remainingFraction: 0 })] }])).toEqual([]);
  });

  test('the project comes from loadCodeAssist as a string or { id }, and only when it is an id', () => {
    expect(antigravityProject({ cloudaicompanionProject: 'proj-1' })).toBe('proj-1');
    expect(antigravityProject({ cloudaicompanionProject: { id: 'proj.2:x' } })).toBe('proj.2:x');
    for (const p of [undefined, '', 'a b', 'x"}', 'a'.repeat(129), { id: 7 }]) expect(antigravityProject({ cloudaicompanionProject: p })).toBeUndefined();
  });

  test('a spent Gemini window blocks Gemini models only; a spent 3p window blocks Claude and GPT only', () => {
    const t = now;
    const acct = (windows: ReturnType<typeof mapAntigravityQuota>) => ({ id: 'google', kind: 'subscription' as const, enabled: true, windows: windows.map((w) => annotateWindow(w)) });
    const gem = acct(mapAntigravityQuota([{ buckets: [bucket('gemini-weekly', 'weekly', { resetTime: at(30) }), bucket('3p-5h', '5h', { remainingFraction: 0.5, resetTime: at(2) })] }]));
    expect(usable(assess(gem, t, 'gemini-3-pro'))).toBe(false);
    expect(assess(gem, t, 'gemini-3-pro').window?.name).toBe('7d gemini');
    expect(pickAccount([gem], t, 'gemini-3-pro').account).toBeUndefined();
    for (const m of ['claude-opus-5-5', 'gpt-6-astra', undefined]) expect(pickAccount([gem], t, m).account).toBe('google');
    const tp = acct(mapAntigravityQuota([{ buckets: [bucket('3p-5h', '5h', { resetTime: at(2) }), bucket('gemini-5h', '5h', { remainingFraction: 0.9, resetTime: at(2) })] }]));
    for (const m of ['claude-opus-5-5', 'ag/gpt-6-astra']) {
      expect(usable(assess(tp, t, m))).toBe(false);
      expect(pickAccount([tp], t, m).account).toBeUndefined();
    }
    expect(pickAccount([tp], t, 'gemini-3-pro').account).toBe('google');
    // the reset passed: Claude answers again
    expect(pickAccount([tp], t + 3 * 3_600_000, 'claude-opus-5-5').account).toBe('google');
  });
});
