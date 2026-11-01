import { describe, expect, test } from 'bun:test';
import { mapClaudeOAuthUsage, mapClaudeProfile } from '../../src/usage/readers/claude-oauth';
import { mapWhamUsage } from '../../src/usage/readers/codex-usage';
import { classifyHttpError, isSpendCapError, parseRateLimitHeaders } from '../../src/providers/errors';

const NOW = Date.parse('2026-10-20T12:00:00Z');

describe('the plan usage endpoint', () => {
  test('every window: 5h, 7d, 7d Opus, 7d Sonnet, Fable, oauth apps, cowork, and extra usage', () => {
    const l = mapClaudeOAuthUsage(
      {
        five_hour: { utilization: 12.5, resets_at: '2026-10-20T14:00:00Z' },
        seven_day: { utilization: 55, resets_at: '2026-10-27T10:00:00Z' },
        seven_day_opus: { utilization: 80, resets_at: '2026-10-27T10:00:00Z' },
        seven_day_sonnet: { utilization: 20, resets_at: '2026-10-27T10:00:00Z' },
        iguana_necktie: { utilization: 33, resets_at: '2026-10-27T10:00:00Z' },
        seven_day_oauth_apps: { utilization: 1, resets_at: null },
        seven_day_cowork: { utilization: 0, resets_at: null },
        extra_usage: { is_enabled: false },
      },
      NOW,
      'max',
    );
    expect(l.windows.map((w) => [w.name, w.usedPercent])).toEqual([
      ['5h', 12.5],
      ['7d', 55],
      ['7d opus', 80],
      ['7d sonnet', 20],
      ['7d fable', 33],
      ['7d oauth apps', 1],
      ['7d cowork', 0],
    ]);
    expect(l.windows[0].resetsAt).toBe(Date.parse('2026-10-20T14:00:00Z'));
    expect(l.blocked).toBe(false);
  });

  test('a full Opus week does not block the plan; a full week does', () => {
    expect(mapClaudeOAuthUsage({ seven_day: { utilization: 40 }, seven_day_opus: { utilization: 100 } }, NOW).blocked).toBe(false);
    expect(mapClaudeOAuthUsage({ five_hour: { utilization: 100 } }, NOW).blocked).toBe(true);
  });

  test('Fable from the limits list, and a Fable window counted in dollars as credits', () => {
    const fromList = mapClaudeOAuthUsage({ limits: [{ kind: 'weekly_scoped', percent: 64, resets_at: '2026-10-27T10:00:00Z', is_active: true, scope: { model: { display_name: 'Fable' } } }] }, NOW);
    expect(fromList.windows).toEqual([{ name: '7d fable', usedPercent: 64, resetsAt: Date.parse('2026-10-27T10:00:00Z') }]);
    const credits = mapClaudeOAuthUsage({ iguana_necktie: { utilization: 10, limit_dollars: 50, remaining_dollars: 45 } }, NOW);
    expect(credits.windows).toEqual([{ name: 'fable credits', usedPercent: 10, limit: 50, remaining: 45 }]);
  });

  test('missing windows stay out: unknown, not zero', () => {
    expect(mapClaudeOAuthUsage({ five_hour: { utilization: 3 }, seven_day: null, seven_day_opus: { resets_at: 'x' } }, NOW).windows).toEqual([{ name: '5h', usedPercent: 3 }]);
  });

  test('the plan from the profile', () => {
    expect(mapClaudeProfile({ organization: { rate_limit_tier: 'default_claude_max_20x' }, account: { has_claude_max: true } })).toBe('Max 20x');
    expect(mapClaudeProfile({ account: { has_claude_max: true } })).toBe('Max');
    expect(mapClaudeProfile({ account: { has_claude_pro: true, has_claude_max: false } })).toBe('Pro');
    expect(mapClaudeProfile({ organization: { organization_type: 'claude_team', subscription_status: 'active' } })).toBe('Team');
    expect(mapClaudeProfile({ account: { has_claude_pro: false, has_claude_max: false } })).toBe('Free');
    expect(mapClaudeProfile({})).toBeUndefined();
    expect(mapClaudeProfile(undefined)).toBeUndefined();
  });
});

describe('the ChatGPT usage endpoint (wham/usage)', () => {
  test('primary 5h and secondary weekly windows by their length, the plan, code review apart', () => {
    const r = mapWhamUsage(
      {
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 22, limit_window_seconds: 18_000, reset_after_seconds: 3600, reset_at: 1792500000 },
          secondary_window: { used_percent: 61.25, limit_window_seconds: 604_800, reset_after_seconds: 200_000 },
        },
        code_review_rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_after_seconds: 10 } },
      },
      NOW,
    );
    expect(r.plan).toBe('Pro');
    expect(r.windows).toEqual([
      { name: '5h', usedPercent: 22, resetsAt: 1792500000_000, windowMs: 18_000_000 },
      { name: '7d', usedPercent: 61.3, resetsAt: NOW + 200_000_000, windowMs: 604_800_000 },
      { name: '7d code review', usedPercent: 0, resetsAt: NOW + 10_000, windowMs: 604_800_000 },
    ]);
  });

  test('a reached limit without a percent reads as full', () => {
    const r = mapWhamUsage({ rate_limit: { limit_reached: true, primary_window: { reset_after_seconds: 60 } } }, NOW);
    expect(r.windows).toEqual([{ name: '5h', usedPercent: 100, resetsAt: NOW + 60_000 }]);
    expect(mapWhamUsage(undefined)).toEqual({ windows: [] });
  });
});

describe("CLIProxyAPI's stored signals", () => {
  test('header names match without regard to case, through the same parser as live headers', () => {
    const signals = {
      'Anthropic-Ratelimit-Unified-5h-Utilization': '0.45',
      'Anthropic-Ratelimit-Unified-5h-Reset': String(Math.floor(NOW / 1000) + 3600),
      'Anthropic-Ratelimit-Unified-7d-Utilization': '0.9',
      'ANTHROPIC-RATELIMIT-UNIFIED-7D_OPUS-UTILIZATION': '1',
      'Anthropic-Ratelimit-Unified-Status': 'allowed',
      'Retry-After': '30',
    };
    const w = parseRateLimitHeaders('claude', signals, NOW);
    expect(w.find((x) => x.name === '5h')).toMatchObject({ usedPercent: 45, resetsAt: NOW + 3_600_000 });
    expect(w.find((x) => x.name === '7d')?.usedPercent).toBeCloseTo(90);
    expect(w.find((x) => x.name === '7d opus')?.usedPercent).toBe(100);
  });

  test('ChatGPT signals: x-codex-primary and secondary', () => {
    const w = parseRateLimitHeaders('codex', { 'X-Codex-Primary-Used-Percent': '35', 'X-Codex-Primary-Window-Minutes': '300', 'X-Codex-Primary-Reset-After-Seconds': '600', 'x-codex-secondary-used-percent': '70', 'x-codex-secondary-window-minutes': '10080' }, NOW);
    expect(w).toEqual([
      { name: '5h', usedPercent: 35, resetsAt: NOW + 600_000, windowMs: 18_000_000 },
      { name: '7d', usedPercent: 70, windowMs: 604_800_000 },
    ]);
  });
});

describe('the Anthropic spend cap', () => {
  test('429 enforced_spend_limit_reached is a quota, with no retry in place', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'You have reached your organization’s monthly spend limit.', details: { error_code: 'enforced_spend_limit_reached' } } });
    expect(isSpendCapError(429, body)).toBe(true);
    const e = classifyHttpError('anthropic', 429, {}, body, NOW);
    expect(e.kind).toBe('quota');
    expect(e.code).toBe('spend_cap');
    expect(e.retryable).toBe(false);
    expect(e.retryAfterMs).toBeUndefined();
  });

  test('400 "You have reached your specified API usage limits" is the limit the owner set', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } });
    expect(isSpendCapError(400, body)).toBe(true);
    const e = classifyHttpError('anthropic', 400, {}, body, NOW);
    expect(e).toMatchObject({ kind: 'quota', code: 'spend_cap' });
  });

  test('an ordinary rate limit is not a spend cap', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } });
    expect(isSpendCapError(429, body)).toBe(false);
    const e = classifyHttpError('anthropic', 429, { 'retry-after': '20' }, body, NOW);
    expect(e.kind).toBe('rate_limit');
    expect(e.code).toBeUndefined();
    expect(isSpendCapError(400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens: too large' } }))).toBe(false);
  });
});
