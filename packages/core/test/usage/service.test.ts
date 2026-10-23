import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { UsageService, type UsageServiceOptions } from '../../src/usage/service';
import { CLAUDE_OAUTH_FLAG } from '../../src/usage/readers/claude-oauth';
import type { EngineEventEnvelope, Usage } from '../../src/types';
import { TestMachine } from '../acp/test-machine';
import { fixtureHome } from '../importers/fixture-home';

/** $3 input, $15 output, $0.30 cache read, $3.75 cache write per million, for every model. */
const PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const priceOf = (_ref: string, u: Usage) =>
  (u.inputTokens * PRICES.input + u.outputTokens * PRICES.output + (u.cacheReadTokens ?? 0) * PRICES.cacheRead + (u.cacheWriteTokens ?? 0) * PRICES.cacheWrite) / 1e6;

function setup(extra: Partial<UsageServiceOptions> = {}) {
  const repos = new Repos(openDb(':memory:'));
  const bus = new EventBus();
  const events: EngineEventEnvelope[] = [];
  bus.on((e) => events.push(e));
  const svc = new UsageService({ repos, bus, priceOf, ...extra });
  return { repos, bus, events, svc };
}

const base = { source: 'api', provider: 'anthropic', model: 'claude-x', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

describe('UsageService.record', () => {
  test('computes cost, inserts, emits, and dedupes by ext key', () => {
    const { svc, events } = setup();
    const rec = svc.record({ ...base, inputTokens: 1_000_000, outputTokens: 100_000, ts: 1000, sessionId: 's1', purpose: 'title' }, 'k1')!;
    expect(rec.costUsd).toBeCloseTo(3 + 1.5, 6);
    expect(rec).toMatchObject({ ts: 1000, sessionId: 's1', purpose: 'title' });
    expect(events.filter((e) => e.type === 'usage.recorded')).toHaveLength(1);
    expect(svc.record({ ...base, inputTokens: 5 }, 'k1')).toBeUndefined();
    expect(svc.recent(10)).toHaveLength(1);
    expect(svc.record({ ...base, costUsd: 0.5 })!.costUsd).toBe(0.5);
  });

  test('a throwing price function costs zero instead of failing', () => {
    const { svc } = setup({ priceOf: () => { throw new Error('unknown model'); } });
    expect(svc.record({ ...base, inputTokens: 10 })!.costUsd).toBe(0);
  });

  test('recordMany caps events for bulk imports', () => {
    const { svc, events } = setup();
    const items = Array.from({ length: 50 }, (_, i) => ({ extKey: `e${i}`, record: { ...base, ts: i, inputTokens: 1 } }));
    expect(svc.recordMany(items)).toBe(50);
    expect(svc.recordMany(items)).toBe(0);
    const recorded = events.filter((e) => e.type === 'usage.recorded') as Array<Extract<EngineEventEnvelope, { type: 'usage.recorded' }>>;
    expect(recorded).toHaveLength(20);
    expect(recorded[recorded.length - 1].record.ts).toBe(49);
  });
});

describe('UsageService.summary', () => {
  const day = (iso: string) => Date.parse(iso);

  function seeded(extra: Partial<UsageServiceOptions> = {}) {
    const s = setup(extra);
    s.svc.record({ ...base, ts: day('2025-10-01T23:30:00Z'), inputTokens: 100, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 100, purpose: 'turn' });
    s.svc.record({ ...base, ts: day('2025-10-02T10:00:00Z'), source: 'claude-code', model: 'claude-y', inputTokens: 50, outputTokens: 20, cacheReadTokens: 1_000_000 });
    s.svc.record({ ...base, ts: day('2025-10-02T11:00:00Z'), provider: 'openai', model: 'gpt-z', inputTokens: 50, outputTokens: 5, purpose: 'title' });
    s.svc.record({ ...base, ts: day('2025-11-20T00:00:00Z'), inputTokens: 999 });
    return s;
  }

  test('totals, breakdowns, cache hit rate and savings', () => {
    const { svc } = seeded();
    const from = day('2025-10-01T00:00:00Z');
    const to = day('2025-10-03T00:00:00Z');
    const s = svc.summary({ from, to });
    expect(s.from).toBe(from);
    expect(s.to).toBe(to);
    expect(s.totals).toMatchObject({ inputTokens: 200, outputTokens: 35, cacheReadTokens: 1_000_800, cacheWriteTokens: 100, calls: 3 });
    expect(s.byDay.map((b) => [b.key, b.calls])).toEqual([
      ['2025-10-01', 1],
      ['2025-10-02', 2],
    ]);
    expect(Object.fromEntries(s.bySource.map((b) => [b.key, b.calls]))).toEqual({ api: 2, 'claude-code': 1 });
    expect(Object.fromEntries(s.byPurpose.map((b) => [b.key, b.calls]))).toEqual({ turn: 2, title: 1 });
    expect(s.byModel.map((b) => b.key).sort()).toEqual(['claude-x', 'claude-y', 'gpt-z']);
    expect(s.cacheHitRate).toBeCloseTo(1_000_800 / (200 + 1_000_800 + 100), 9);
    // (3 - 0.3) $/M on 1,000,800 cache read tokens
    expect(s.cacheSavingsUsd).toBeCloseTo((1_000_800 * 2.7) / 1e6, 6);
  });

  test('tzOffset shifts day buckets; pricesOf is used for savings when given', () => {
    const { svc } = seeded({ pricesOf: () => ({ inputPrice: 1, cacheReadPrice: 0.5 }) });
    const s = svc.summary({ from: day('2025-10-01T00:00:00Z'), to: day('2025-10-03T00:00:00Z'), tzOffset: 60 });
    expect(s.byDay.map((b) => [b.key, b.calls])).toEqual([['2025-10-02', 3]]);
    expect(s.cacheSavingsUsd).toBeCloseTo((1_000_800 * 0.5) / 1e6, 6);
  });

  test('empty range', () => {
    const { svc } = setup();
    const s = svc.summary({ from: 1, to: 2 });
    expect(s.totals.calls).toBe(0);
    expect(s.cacheHitRate).toBe(0);
    expect(s.cacheSavingsUsd).toBe(0);
  });
});

describe('UsageService limits', () => {
  test('setLimit stores and emits; limits() clears windows past reset', () => {
    const { svc, events } = setup();
    svc.setLimit({
      provider: 'anthropic',
      label: 'Anthropic API',
      windows: [
        { name: 'tokens', usedPercent: 100, resetsAt: 1000 },
        { name: '5h block', resetsAt: 1000 },
        { name: '7d', usedPercent: 50, resetsAt: 5000 },
      ],
      updatedAt: 1,
      blocked: true,
      source: 'headers',
    });
    expect(events.some((e) => e.type === 'limit.updated')).toBe(true);
    expect(svc.limits(500)[0].windows).toHaveLength(3);
    const after = svc.limits(2000)[0];
    expect(after.windows).toEqual([
      { name: 'tokens', usedPercent: 0 },
      { name: '7d', usedPercent: 50, resetsAt: 5000 },
    ]);
    expect(after.blocked).toBe(false);
  });

  test('claudeBlock reads recent claude-code usage', () => {
    const { svc } = setup();
    const now = Date.now();
    const hour = 3_600_000;
    svc.record({ ...base, source: 'claude-code', ts: now - 30 * hour, inputTokens: 1 });
    svc.record({ ...base, source: 'claude-code', ts: now - 2 * hour, inputTokens: 100, outputTokens: 50 });
    svc.record({ ...base, source: 'claude-code', ts: now - hour, inputTokens: 10, cacheReadTokens: 40 });
    svc.record({ ...base, source: 'api', ts: now - hour, inputTokens: 1000 });
    const b = svc.claudeBlock(now)!;
    expect(b.active).toBe(true);
    expect(b.tokens).toBe(200);
    expect(b.start).toBe(Math.floor((now - 2 * hour) / hour) * hour);
  });

  test('refreshLimits imports logs from every machine and refreshes API limits', async () => {
    const home = fixtureHome();
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-test', expiresAt: Date.now() + 3_600_000, subscriptionType: 'max' } }));
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
      if (String(url).includes('anthropic.com')) {
        return Response.json({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 40, resets_at: null } });
      }
      return Response.json({ code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 10, percentage: 10, nextResetTime: Date.now() + 1000_000 }] } });
    }) as typeof fetch;
    const { svc, repos } = setup({ fetch: fakeFetch, zai: () => ({ apiKey: 'zai-key', baseUrl: 'https://api.z.ai/api/anthropic' }) });
    repos.kv.set(CLAUDE_OAUTH_FLAG, true);

    const machines = [new TestMachine({ id: 'pc', name: 'pc', home }), new TestMachine({ id: 'offline', name: 'offline', home: '/nonexistent-conclave' })];
    const report = await svc.refresh(machines);
    expect(report.errors).toEqual([]);
    expect(report.imported).toBe(5 + 3);

    const byProvider = Object.fromEntries(report.limits.map((l) => [l.provider, l]));
    expect(Object.keys(byProvider).sort()).toEqual(['claude-code', 'claude-max', 'codex', 'zai']);
    // fixture timestamps are long past: no active block, codex windows have reset
    expect(byProvider['claude-code'].windows).toEqual([]);
    expect(byProvider.codex.windows).toEqual([
      { name: '5h', usedPercent: 0 },
      { name: '7d', usedPercent: 0 },
    ]);
    expect(byProvider['claude-max'].windows.map((w) => [w.name, w.usedPercent])).toEqual([
      ['5h', 12],
      ['7d', 40],
    ]);
    expect(byProvider.zai.windows[0]).toMatchObject({ name: '5h', usedPercent: 10 });

    const oauth = calls.find((c) => c.url.includes('anthropic.com'))!;
    expect(oauth.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(oauth.headers.authorization).toBe('Bearer sk-ant-oat-test');
    expect(oauth.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    const zai = calls.find((c) => c.url.includes('z.ai'))!;
    expect(zai.url).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(zai.headers.authorization).toBe('zai-key');

    // second run: nothing new, same limits
    const again = await svc.refresh(machines);
    expect(again.imported).toBe(0);
    expect(svc.summary({ from: 1, to: Date.now() }).bySource.map((b) => [b.key, b.calls]).sort()).toEqual([
      ['claude-code', 5],
      ['codex', 3],
    ]);
  });

  test('refresh reports API errors without failing', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const { svc } = setup({ fetch: fakeFetch, zai: () => ({ apiKey: 'k' }), claudeOAuth: () => true });
    const report = await svc.refresh([new TestMachine({ id: 'pc', home: '/nonexistent-conclave' })]);
    expect(report.errors.some((e) => e.startsWith('zai: Z.ai quota endpoint returned 500'))).toBe(true);
    expect(report.errors.some((e) => e.includes('No Claude Code login found'))).toBe(true);
    expect(report.limits).toEqual([]);
  });
});
