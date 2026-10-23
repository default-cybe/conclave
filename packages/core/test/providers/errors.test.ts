import { describe, expect, test } from 'bun:test';
import {
  classifyHttpError,
  classifyStreamError,
  nextMidnightIn,
  parseRateLimitHeaders,
  parseResetValue,
  parseRetryAfter,
  parseTextResetTime,
} from '../../src/providers/errors';

const NOW = Date.parse('2026-10-16T08:00:00Z');
const body = (o: unknown) => JSON.stringify(o);

describe('retry hints', () => {
  test('retry-after seconds, HTTP date and retry-after-ms', () => {
    expect(parseRetryAfter({ 'retry-after': '20' }, NOW)).toBe(20_000);
    expect(parseRetryAfter({ 'Retry-After': new Date(NOW + 5000).toUTCString() }, NOW)).toBe(5000);
    expect(parseRetryAfter({ 'retry-after-ms': '1500', 'retry-after': '9' }, NOW)).toBe(1500);
  });

  test('reset values: RFC3339, epoch seconds, Go durations', () => {
    expect(parseResetValue('2026-10-16T08:01:00Z', NOW)).toBe(NOW + 60_000);
    expect(parseResetValue('1792137600', NOW)).toBe(1_792_137_600_000);
    expect(parseResetValue('6m0s', NOW)).toBe(NOW + 360_000);
    expect(parseResetValue('20ms', NOW)).toBe(NOW + 20);
    expect(parseResetValue('1h2m3.5s', NOW)).toBe(NOW + 3_723_500);
  });

  test('text reset times assume Beijing time without an offset', () => {
    expect(parseTextResetTime('Your limit will reset at 2026-10-16 18:32:10', NOW)).toBe(Date.parse('2026-10-16T18:32:10+08:00'));
    expect(parseTextResetTime('Resets at 2026-10-16 13:42:07 (+02:00)', NOW)).toBe(Date.parse('2026-10-16T13:42:07+02:00'));
    expect(parseTextResetTime('reset at 2026-10-16T09:00:00Z', NOW)).toBe(Date.parse('2026-10-16T09:00:00Z'));
  });

  test('next midnight in Pacific time', () => {
    const t = nextMidnightIn('America/Los_Angeles', NOW);
    // 08:00Z is 01:00 PDT, so midnight is 23 hours later.
    expect(t).toBe(NOW + 23 * 3_600_000);
  });
});

describe('classifyHttpError', () => {
  test('429 with retry-after is a short, retryable rate limit', () => {
    const e = classifyHttpError('anthropic', 429, { 'retry-after': '20' }, body({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), NOW);
    expect(e.kind).toBe('rate_limit');
    expect(e.retryAfterMs).toBe(20_000);
    expect(e.resetAt).toBeUndefined();
    expect(e.retryable).toBe(true);
    expect(e.status).toBe(429);
  });

  test('Anthropic exhausted window reset header', () => {
    const e = classifyHttpError(
      'anthropic',
      429,
      {
        'anthropic-ratelimit-tokens-limit': '1000',
        'anthropic-ratelimit-tokens-remaining': '0',
        'anthropic-ratelimit-tokens-reset': '2026-10-16T08:00:30Z',
        'anthropic-ratelimit-requests-remaining': '10',
        'anthropic-ratelimit-requests-reset': '2026-10-16T08:05:00Z',
      },
      body({ error: { type: 'rate_limit_error', message: 'rate limited' } }),
      NOW,
    );
    expect(e.kind).toBe('rate_limit');
    expect(e.retryAfterMs).toBe(30_000);
  });

  test('OpenAI x-ratelimit-reset duration over 90s sets resetAt', () => {
    const e = classifyHttpError(
      'openai',
      429,
      { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-reset-tokens': '6m0s' },
      body({ error: { message: 'Rate limit reached for gpt-5.5 on tokens per min', type: 'tokens', code: 'rate_limit_exceeded' } }),
      NOW,
    );
    expect(e.kind).toBe('rate_limit');
    expect(e.retryAfterMs).toBe(360_000);
    expect(e.resetAt).toBe(NOW + 360_000);
    expect(e.retryable).toBe(false);
  });

  test('OpenAI "try again in" message', () => {
    const e = classifyHttpError('openai', 429, {}, body({ error: { message: 'Please try again in 1.5s.', code: 'rate_limit_exceeded' } }), NOW);
    expect(e.retryAfterMs).toBe(1500);
  });

  test('OpenAI insufficient_quota is quota', () => {
    const e = classifyHttpError('openai', 429, {}, body({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }), NOW);
    expect(e.kind).toBe('quota');
  });

  test('Gemini RetryInfo and per-day quota', () => {
    const short = classifyHttpError(
      'google',
      429,
      {},
      body({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'You exceeded your current quota, please check your plan and billing details.',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
          ],
        },
      }),
      NOW,
    );
    expect(short.kind).toBe('rate_limit');
    expect(short.retryAfterMs).toBe(37_000);

    const daily = classifyHttpError(
      'google',
      429,
      {},
      body([
        {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'Quota exceeded',
            details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
          },
        },
      ]),
      NOW,
    );
    expect(daily.kind).toBe('quota');
    expect(daily.resetAt).toBe(NOW + 23 * 3_600_000);
  });

  test('Z.ai 1308 plan window with reset time', () => {
    const e = classifyHttpError(
      'zai',
      429,
      {},
      body({ type: 'error', error: { code: '1308', message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-16 18:32:10' } }),
      NOW,
    );
    expect(e.kind).toBe('quota');
    expect(e.resetAt).toBe(Date.parse('2026-10-16T18:32:10+08:00'));
    expect(e.retryAfterMs).toBe(e.resetAt! - NOW);
  });

  test('Z.ai weekly limit with next_flush_time field', () => {
    const flush = Date.parse('2026-10-20T00:00:00Z');
    const e = classifyHttpError('zai', 429, {}, body({ error: { code: 1310, message: 'Weekly/Monthly Limit Exhausted.', next_flush_time: flush } }), NOW);
    expect(e.kind).toBe('quota');
    expect(e.resetAt).toBe(flush);
  });

  test('Z.ai concurrency and overload codes', () => {
    expect(classifyHttpError('zai', 429, {}, body({ error: { code: '1302', message: 'High concurrency' } }), NOW).kind).toBe('rate_limit');
    expect(classifyHttpError('zai', 429, {}, body({ error: { code: '1305', message: 'Service overloaded' } }), NOW).kind).toBe('overloaded');
    expect(classifyHttpError('zai', 400, {}, body({ error: { code: '1261', message: 'Prompt exceeds max length' } }), NOW).kind).toBe('context_length');
  });

  test('Claude subscription window rejected via unified headers', () => {
    const reset = Math.floor((NOW + 2 * 3_600_000) / 1000);
    const e = classifyHttpError(
      'anthropic',
      429,
      { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset) },
      body({ error: { type: 'rate_limit_error', message: 'limit' } }),
      NOW,
    );
    expect(e.kind).toBe('quota');
    expect(e.resetAt).toBe(reset * 1000);
  });

  test('overloaded, server, auth', () => {
    expect(classifyHttpError('a', 529, {}, body({ error: { type: 'overloaded_error', message: 'Overloaded' } })).kind).toBe('overloaded');
    expect(classifyHttpError('a', 503, {}, 'Service Unavailable').kind).toBe('overloaded');
    expect(classifyHttpError('a', 500, {}, 'boom').kind).toBe('server');
    expect(classifyHttpError('a', 502, {}, '<html>bad gateway</html>').kind).toBe('server');
    expect(classifyHttpError('a', 401, {}, body({ error: { type: 'authentication_error', message: 'invalid x-api-key' } })).kind).toBe('auth');
    expect(classifyHttpError('a', 403, {}, body({ error: { type: 'permission_error', message: 'no' } })).kind).toBe('auth');
  });

  test('context length detection on 400', () => {
    expect(classifyHttpError('anthropic', 400, {}, body({ error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } })).kind).toBe(
      'context_length',
    );
    expect(classifyHttpError('openai', 400, {}, body({ error: { message: 'too long', code: 'context_length_exceeded' } })).kind).toBe('context_length');
    expect(
      classifyHttpError('google', 400, {}, body({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).' } }))
        .kind,
    ).toBe('context_length');
    expect(classifyHttpError('anthropic', 400, {}, body({ error: { type: 'invalid_request_error', message: 'messages: field required' } })).kind).toBe('bad_request');
  });

  test('Anthropic low credit balance is quota', () => {
    const e = classifyHttpError('anthropic', 400, {}, body({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }));
    expect(e.kind).toBe('quota');
  });
});

describe('classifyStreamError', () => {
  test('maps mid-stream error types', () => {
    expect(classifyStreamError('anthropic', { type: 'overloaded_error', message: 'Overloaded' }).kind).toBe('overloaded');
    expect(classifyStreamError('openai', { code: 'rate_limit_exceeded', message: 'slow' }).kind).toBe('rate_limit');
    expect(classifyStreamError('openai', { code: 'server_error', message: 'oops' }).kind).toBe('server');
  });
});

describe('parseRateLimitHeaders', () => {
  test('Anthropic API and subscription windows', () => {
    const w = parseRateLimitHeaders(
      'anthropic',
      new Headers({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '40',
        'anthropic-ratelimit-requests-reset': '2026-10-16T08:01:00Z',
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(NOW / 1000) + 3600),
        'anthropic-ratelimit-unified-7d-utilization': '0.1',
      }),
      NOW,
    );
    const req = w.find((x) => x.name === 'requests')!;
    expect(req).toMatchObject({ limit: 50, remaining: 40, resetsAt: NOW + 60_000 });
    expect(req.usedPercent).toBeCloseTo(20);
    expect(w.find((x) => x.name === '5h')).toMatchObject({ usedPercent: 42, resetsAt: NOW + 3_600_000 });
    expect(w.find((x) => x.name === '7d')?.usedPercent).toBeCloseTo(10);
  });

  test('OpenAI windows', () => {
    const w = parseRateLimitHeaders(
      'openai',
      {
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-remaining-requests': '499',
        'x-ratelimit-reset-requests': '120ms',
        'x-ratelimit-limit-tokens': '30000',
        'x-ratelimit-remaining-tokens': '15000',
        'x-ratelimit-reset-tokens': '1m30s',
      },
      NOW,
    );
    expect(w.find((x) => x.name === 'requests')).toMatchObject({ limit: 500, remaining: 499, resetsAt: NOW + 120 });
    expect(w.find((x) => x.name === 'tokens')).toMatchObject({ usedPercent: 50, resetsAt: NOW + 90_000 });
  });

  test('no headers, no windows', () => {
    expect(parseRateLimitHeaders('x', new Headers({ 'content-type': 'text/event-stream' }))).toEqual([]);
  });
});
