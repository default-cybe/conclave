/**
 * The 14-day recap's grouping (features/usage/Recap.tsx): spend and requests
 * per provider per day, zero-filled across the window, records outside it
 * dropped, and a window longer than the 1000-request feed flagged as
 * truncated.
 */
import { describe, expect, test } from 'bun:test';
import type { UsageRecord } from '@conclave/core/types';
import { recapSeries, RECAP_DAYS } from '../src/features/usage/Recap';

const DAY = 86_400_000;

function rec(provider: string, ts: number, costUsd: number, apiValueUsd?: number): UsageRecord {
  return {
    id: `${provider}-${ts}`,
    ts,
    sessionId: undefined,
    source: 'api',
    provider,
    model: `${provider}/m`,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd,
    ...(apiValueUsd === undefined ? {} : { apiValueUsd }),
    purpose: undefined,
    accountId: 'owner',
  } as UsageRecord;
}

const noon = (daysAgo: number) => new Date(Date.UTC(2026, 9, 25 - daysAgo, 12)).getTime();

describe('recap series', () => {
  test('splits spend and calls per provider per day, zero-filled, worth for plans', () => {
    const now = new Date(2026, 9, 25, 18).getTime();
    const series = recapSeries(
      [
        rec('anthropic', noon(0), 0, 5), // plan: worth its API value
        rec('anthropic', noon(1), 0, 7),
        rec('openai', noon(1), 3),
        rec('openai', noon(30), 99), // before the window: dropped
      ],
      now,
    );
    expect(series.days).toHaveLength(RECAP_DAYS);
    const anthropic = series.providers.find((p) => p.provider === 'anthropic')!;
    const openai = series.providers.find((p) => p.provider === 'openai')!;
    expect(anthropic.spend[RECAP_DAYS - 1]).toBe(5);
    expect(anthropic.spend[RECAP_DAYS - 2]).toBe(7);
    expect(anthropic.calls[RECAP_DAYS - 1]).toBe(1);
    expect(anthropic.totalSpend).toBe(12);
    expect(openai.totalSpend).toBe(3);
    expect(openai.calls.every((c, i) => (i === RECAP_DAYS - 2 ? c === 1 : c === 0))).toBe(true);
    // anthropic first: more worth
    expect(series.providers[0].provider).toBe('anthropic');
    expect(series.truncated).toBe(false);
  });

  test('a feed that stops inside the window says truncated', () => {
    const now = new Date(2026, 9, 25, 18).getTime();
    const many = Array.from({ length: 1000 }, (_, i) => rec('openai', now - i * 60_000, 0.01));
    const series = recapSeries(many, now);
    // 1000 minutes back is under 14 days, so the tail of the window is covered by the feed's span check
    expect(series.truncated).toBe(many[many.length - 1].ts > series.days[0].t);
    expect(series.providers).toHaveLength(1);
  });

  test('no records, no providers', () => {
    const series = recapSeries([], new Date(2026, 9, 25, 18).getTime());
    expect(series.providers).toEqual([]);
    expect(series.days).toHaveLength(RECAP_DAYS);
  });
});
