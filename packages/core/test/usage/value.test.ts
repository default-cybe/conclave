/**
 * What plan use is worth at API prices (usage/value.ts): plan rows bill $0
 * and keep the catalog price of their tokens, cache rates included; API key
 * rows are worth what they billed; rows from before values were kept get an
 * estimate on read; and the month's saved total adds up.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { UsageService, savedOf } from '../../src/usage/service';
import { apiValueOf, isPlanCall } from '../../src/usage/value';
import { lookupModel } from '../../src/providers/catalog';
import type { ConclaveConfig } from '../../src/config/schema';
import type { Usage, UsageRecord } from '../../src/types';
import { startTestEngine, type TestEngine } from '../engine/harness';

/** A signed in plan (the hub's CLIProxyAPI) and an API key, as the engine's config has them. */
const CONFIG = {
  providers: {
    cliproxy: { type: 'openai', baseUrl: 'http://127.0.0.1:8317/v1', subscription: 'cliproxy', anthropicWire: { baseUrl: 'http://127.0.0.1:8317', models: ['claude-*'] } },
    anthropic: { type: 'anthropic' },
    zai: { type: 'anthropic', subscription: 'zai-coding', modelOverrides: { 'glm-5.3': { inputPrice: 0, outputPrice: 0 } } },
  },
  models: { accounts: [{ id: 'max-1', vendor: 'anthropic', kind: 'subscription', credential: 'claude-a.json' }] },
} as unknown as ConclaveConfig;

/** What the engine bills: $0 per token on the plan, list prices on the key. */
const priceOf = (ref: string, u: Usage) => {
  const [provider, ...rest] = ref.split('/');
  if (provider === 'cliproxy') return 0;
  const info = lookupModel(provider, rest.join('/'));
  return (u.inputTokens * info.inputPrice + u.outputTokens * info.outputPrice + (u.cacheReadTokens ?? 0) * info.cacheReadPrice + (u.cacheWriteTokens ?? 0) * info.cacheWritePrice) / 1e6;
};

function setup() {
  const repos = new Repos(openDb(':memory:'));
  const svc = new UsageService({ repos, bus: new EventBus(), priceOf, apiValueOf: (row, u) => apiValueOf(CONFIG, row, u) });
  return { repos, svc };
}

const SONNET = lookupModel('anthropic', 'claude-sonnet-5-5');
/** The catalog price of a call, by hand. */
const listPrice = (u: { input: number; output: number; read?: number; write?: number }) =>
  (u.input * SONNET.inputPrice + u.output * SONNET.outputPrice + (u.read ?? 0) * SONNET.cacheReadPrice + (u.write ?? 0) * SONNET.cacheWritePrice) / 1e6;

const row = { source: 'api', model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

describe('API value', () => {
  test('the catalog has the rates these tests rely on', () => {
    expect(SONNET.inputPrice).toBeGreaterThan(0);
    expect(SONNET.cacheReadPrice).toBeGreaterThan(0);
    expect(SONNET.cacheReadPrice).toBeLessThan(SONNET.inputPrice);
    expect(SONNET.cacheWritePrice).toBeGreaterThan(SONNET.inputPrice);
  });

  test('a plan row bills $0 and keeps the API price of its tokens, cache reads and writes at their own rates', () => {
    const { svc } = setup();
    const tokens = { input: 20_000, output: 3_000, read: 900_000, write: 60_000 };
    const r = svc.record({ ...row, provider: 'cliproxy', account: 'max-1', inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.read, cacheWriteTokens: tokens.write })!;
    expect(r.costUsd).toBe(0);
    expect(r.apiValueUsd).toBeCloseTo(listPrice(tokens), 6);
    // cache reads cost less than input, writes more: priced as input the value would be wrong
    const flat = ((tokens.input + tokens.read + tokens.write) * SONNET.inputPrice + tokens.output * SONNET.outputPrice) / 1e6;
    expect(Math.abs(r.apiValueUsd! - flat)).toBeGreaterThan(0.01);
    // kept on the row
    expect(svc.recent(1)[0]).toMatchObject({ costUsd: 0, apiValueUsd: r.apiValueUsd });
    expect(svc.recent(1)[0].apiValueEstimated).toBeUndefined();
  });

  test('a 1 hour cache write is priced at its own rate', () => {
    const { svc } = setup();
    const r5m = svc.record({ ...row, provider: 'cliproxy', cacheWriteTokens: 100_000 })!;
    const r1h = svc.record({ ...row, provider: 'cliproxy', cacheWriteTokens: 100_000, cacheWrite1hTokens: 100_000 })!;
    expect(r1h.apiValueUsd!).toBeGreaterThan(r5m.apiValueUsd!);
    expect(r1h.apiValueUsd!).toBeCloseTo((100_000 * (SONNET.cacheWrite1hPrice ?? SONNET.inputPrice * 2)) / 1e6, 6);
  });

  test('an API key row is worth what it billed', () => {
    const { svc } = setup();
    const r = svc.record({ ...row, provider: 'anthropic', inputTokens: 50_000, outputTokens: 4_000, cacheReadTokens: 200_000, cacheWriteTokens: 10_000 })!;
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.apiValueUsd).toBe(r.costUsd);
    // a price a provider reported (OpenRouter) is the value too
    const reported = svc.record({ ...row, provider: 'openrouter', inputTokens: 10, costUsd: 0.42 })!;
    expect(reported.apiValueUsd).toBe(0.42);
  });

  test('which calls a plan served', () => {
    expect(isPlanCall(CONFIG, { provider: 'cliproxy', model: 'claude-opus-5-5' })).toBe(true);
    expect(isPlanCall(CONFIG, { provider: 'anthropic', model: 'claude-opus-5-5' })).toBe(false);
    // a price override on a plan's model is the price the owner pays
    expect(isPlanCall(CONFIG, { provider: 'zai', model: 'glm-5.3' })).toBe(false);
    expect(isPlanCall(CONFIG, { provider: 'zai', model: 'glm-5.2' })).toBe(true);
    // the account that served it says so too
    expect(isPlanCall(CONFIG, { provider: 'gateway-x', model: 'claude-opus-5-5', account: 'max-1' })).toBe(true);
    // a second account's copy of a model has the same API price
    const u = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(apiValueOf(CONFIG, { provider: 'cliproxy', model: 'neu/claude-sonnet-5-5', costUsd: 0 }, u)).toBeCloseTo(SONNET.inputPrice, 6);
  });

  test('rows from before values were kept get an estimate on read, marked as such', () => {
    const { svc, repos } = setup();
    const ts = Date.parse('2026-10-10T12:00:00Z');
    // written as an older hub wrote them: no api value
    const old = (id: string, provider: string, cost: number): UsageRecord => ({ id, ts, source: 'api', provider, model: 'claude-sonnet-5-5', inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 500_000, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: cost, accountId: 'owner' });
    repos.usage.insert(old('use_a', 'cliproxy', 0));
    repos.usage.insert(old('use_b', 'anthropic', 1.23));
    svc.record({ ...row, ts, provider: 'cliproxy', inputTokens: 100_000, outputTokens: 10_000 });
    const est = listPrice({ input: 100_000, output: 10_000, read: 500_000 });
    const kept = listPrice({ input: 100_000, output: 10_000 });

    const recent = svc.recent(10);
    expect(recent.find((r) => r.id === 'use_a')).toMatchObject({ costUsd: 0, apiValueEstimated: true });
    expect(recent.find((r) => r.id === 'use_a')!.apiValueUsd).toBeCloseTo(est, 6);
    // an old key row is worth what it billed
    expect(recent.find((r) => r.id === 'use_b')).toMatchObject({ apiValueUsd: 1.23, apiValueEstimated: true });

    const s = svc.summary({ from: ts - 1000, to: ts + 1000 });
    expect(s.totals.costUsd).toBeCloseTo(1.23, 6);
    expect(s.totals.apiValueUsd).toBeCloseTo(est + 1.23 + kept, 6);
    expect(s.totals.estimatedUsd).toBeCloseTo(est + 1.23, 6);
    // the breakdowns carry it too
    const byModel = s.byModel.find((b) => b.key === 'claude-sonnet-5-5')!;
    expect(byModel.apiValueUsd).toBeCloseTo(est + 1.23 + kept, 6);
    expect(s.byDay[0].apiValueUsd).toBeCloseTo(est + 1.23 + kept, 6);
    expect(s.savedUsd).toBeCloseTo(est + kept, 6);
    // rows with values only: no estimate
    const fresh = svc.summary({ from: ts + 1, to: ts + 2 });
    expect(fresh.totals.estimatedUsd).toBeUndefined();
  });

  test('the month\'s saved total is what the plans would have cost, less what they billed', () => {
    const { svc } = setup();
    const at = (iso: string) => Date.parse(iso);
    const plan = (iso: string, input: number, output: number) => svc.record({ ...row, ts: at(iso), provider: 'cliproxy', account: 'max-1', inputTokens: input, outputTokens: output })!;
    const a = plan('2026-10-02T09:00:00Z', 400_000, 30_000);
    const b = plan('2026-10-20T21:00:00Z', 1_000_000, 80_000);
    // an API key row in the month: billed and worth the same, so it saves nothing
    svc.record({ ...row, ts: at('2026-10-05T10:00:00Z'), provider: 'anthropic', inputTokens: 300_000, outputTokens: 20_000 });
    // last month's plan use is not this month's
    plan('2026-09-29T10:00:00Z', 2_000_000, 100_000);

    const month = svc.summary({ from: at('2026-10-01T00:00:00Z'), to: at('2026-10-23T00:00:00Z') });
    expect(month.savedUsd).toBeCloseTo(a.apiValueUsd! + b.apiValueUsd!, 6);
    expect(month.savedUsd).toBeCloseTo(listPrice({ input: 1_400_000, output: 110_000 }), 6);
    expect(savedOf(month.totals)).toBe(month.savedUsd!);
    // per account: the plan's bill and its worth
    const acct = month.byAccount!.find((x) => x.key === 'max-1')!;
    expect(acct.costUsd).toBe(0);
    expect(acct.apiValueUsd).toBeCloseTo(a.apiValueUsd! + b.apiValueUsd!, 6);
    const keyRow = month.byAccount!.find((x) => x.key === '')!;
    expect(keyRow.apiValueUsd).toBeCloseTo(keyRow.costUsd, 9);
  });
});

describe('session stats', () => {
  let t: TestEngine | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  test('a session on a signed in plan bills $0 and shows what its calls are worth', async () => {
    t = await startTestEngine({ script: [{ blocks: [{ text: 'done' }], usage: { input: 200_000, output: 10_000 } }] });
    const port = new URL((t.engine.config.get().providers.mock as { baseUrl: string }).baseUrl).port;
    // the mock as a signed in gateway: Claude models over the Anthropic wire, no per-token price
    t.engine.config.setRuntime({ providers: { plan: { type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', subscription: 'plan', models: ['claude-sonnet-5-5'], anthropicWire: { baseUrl: `http://127.0.0.1:${port}`, models: ['claude-*'] } } } } as never, 'plan');
    const s = await t.engine.createSession({ cwd: t.cwd, model: 'plan/claude-sonnet-5-5' });
    await t.run(s.id, 'hello');
    const stats = t.engine.repos.sessions.get(s.id)!.stats;
    expect(stats.costUsd).toBe(0);
    expect(stats.apiValueUsd).toBeCloseTo(listPrice({ input: 200_000, output: 10_000 }), 6);
    const rec = t.engine.usage.recent(5).find((r) => r.sessionId === s.id && r.purpose === 'turn')!;
    expect(rec).toMatchObject({ provider: 'plan', costUsd: 0 });
    expect(rec.apiValueUsd).toBeCloseTo(stats.apiValueUsd!, 6);
  });
});
