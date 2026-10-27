import { describe, expect, test } from 'bun:test';
import { assess } from '../../src/accounts/policy';
import { annotateWindow } from '../../src/accounts/windows';
import { mapKiroQuota } from '../../src/usage/readers/kiro';

/**
 * GET /v8/management/plugins/kiro4cpa/quota as CLIProxyAPI 8.0.32 answers it:
 * kiro4cpa 1.0.5 quotaResponse (internal/kiro/quota.go) over getUsageLimits,
 * a Pro plan with an active bonus. Numbers made up, shape from the plugin.
 */
const RESET = '2026-11-01T00:00:00Z';
const ANSWER = {
  subscription: { plan: 'KIRO PRO' },
  summary: [
    { key: 'agentic_request_used', label: 'Credits 已用', value: 312.5 },
    { key: 'agentic_request_limit', label: 'Credits 上限', value: 1100 },
  ],
  groups: [
    {
      displayName: 'Credits',
      buckets: [
        { window: 'monthly', remainingFraction: 0.7, resetTime: RESET, description: '300 / 1000' },
        { window: 'Welcome bonus', remainingFraction: 0.875, resetTime: '2026-11-20T00:00:00Z', description: '12.5 / 100' },
      ],
    },
  ],
};

describe('Kiro quota (kiro4cpa plugin)', () => {
  test('the plan, and one monthly window with the total usable credit and the monthly reset', () => {
    expect(mapKiroQuota(ANSWER)).toEqual({
      plan: 'Pro',
      windows: [{ name: 'monthly', usedPercent: 28.41, remaining: 787.5, limit: 1100, resetsAt: Date.parse(RESET) }],
    });
    expect(annotateWindow(mapKiroQuota(ANSWER).windows[0]).kind).toBe('monthly');
  });

  test('spent credit blocks the account until the reset', () => {
    const spent = mapKiroQuota({ ...ANSWER, summary: [{ key: 'agentic_request_used', value: 50 }, { key: 'agentic_request_limit', value: 50 }] });
    const windows = spent.windows.map((w) => annotateWindow(w));
    expect(windows[0]).toMatchObject({ usedPercent: 100, remaining: 0, limit: 50 });
    expect(assess({ id: 'kiro', kind: 'subscription', enabled: true, windows }, Date.parse(RESET) - 1000).state).toBe('limited');
  });

  test('without a summary the monthly bucket fraction still gives the window', () => {
    expect(mapKiroQuota({ groups: ANSWER.groups }).windows).toEqual([{ name: 'monthly', usedPercent: 30, resetsAt: Date.parse(RESET) }]);
  });

  test('a free plan title, and malformed answers give nothing', () => {
    expect(mapKiroQuota({ subscription: { plan: 'KIRO FREE' } })).toEqual({ plan: 'Free', windows: [] });
    for (const bad of [undefined, {}, { groups: 'x' }, { groups: [null, { buckets: [{ window: 'monthly' }] }] }, { summary: [{ key: 'x_used', value: 'NaN' }] }]) {
      expect(mapKiroQuota(bad as never).windows).toEqual([]);
    }
  });
});
