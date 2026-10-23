import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLiteLLMData,
  clearLiteLLMData,
  computeCost,
  familyForProvider,
  findCatalogEntry,
  lookupModel,
  normalizeModelId,
  refreshPricingFromLiteLLM,
} from '../../src/providers/catalog';
import { ToolNameMap, wireToolName, GEMINI_TOOL_NAME_RULES } from '../../src/providers/tool-names';

afterEach(() => clearLiteLLMData());

describe('normalizeModelId and fuzzy lookup', () => {
  test('normalization', () => {
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('us.anthropic.claude-opus-4-5-20251101-v1:0')).toBe('claude-opus-4-5');
    expect(normalizeModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5');
    expect(normalizeModelId('claude-sonnet-5-5[1m]')).toBe('claude-sonnet-5-5');
    expect(normalizeModelId('gpt-5.5-2026-04-23')).toBe('gpt-5.5');
    expect(normalizeModelId('models/gemini-3-flash-preview')).toBe('gemini-3-flash-preview');
    expect(normalizeModelId('z-ai/glm-5:free')).toBe('glm-5');
  });

  test('lookup by snapshot, router id, alias and prefix', () => {
    expect(findCatalogEntry('claude-sonnet-4-5-20250929')?.id).toBe('claude-sonnet-4-5');
    expect(findCatalogEntry('openrouter/anthropic/claude-opus-5.5')?.id).toBe('claude-opus-5-5');
    expect(findCatalogEntry('opus')?.id).toBe('claude-opus-5-5');
    expect(findCatalogEntry('gemini-3-pro')?.id).toBe('gemini-3.1-pro-preview');
    expect(findCatalogEntry('glm-4.7-turbo')?.id).toBe('glm-4.7');
    expect(findCatalogEntry('gpt-5.4-mini-2026-03-01')?.id).toBe('gpt-5.4-mini');
    expect(findCatalogEntry('MiniMax-M2.5')?.id).toBe('MiniMax-M2.5');
    expect(findCatalogEntry('totally-unknown')).toBeUndefined();
  });

  test('ModelInfo keeps the requested id and builds the ref', () => {
    const info = lookupModel('zai', 'GLM-5');
    expect(info).toMatchObject({ id: 'GLM-5', ref: 'zai/GLM-5', provider: 'zai', name: 'GLM-5', inputPrice: 1, outputPrice: 3.2, caching: 'automatic', thinking: true });
    const claude = lookupModel('anthropic', 'claude-opus-5-5');
    expect(claude).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000, inputPrice: 4, outputPrice: 20, cacheReadPrice: 0.2, cacheWritePrice: 5, caching: 'explicit', tier: 'deep' });
  });

  test('unknown models get defaults that depend on the wire type', () => {
    expect(lookupModel('local', 'qwen3:8b', { type: 'openai' })).toMatchObject({ contextWindow: 128_000, maxOutput: 8192, inputPrice: 0, caching: 'none', tools: true });
    expect(lookupModel('proxy', 'mystery', { type: 'anthropic' }).caching).toBe('explicit');
  });

  test('config overrides win', () => {
    const info = lookupModel('zai', 'glm-5', { override: { inputPrice: 0, outputPrice: 0, contextWindow: 150_000 } });
    expect(info).toMatchObject({ inputPrice: 0, outputPrice: 0, contextWindow: 150_000, maxOutput: 128_000 });
  });

  test('family by base URL', () => {
    expect(familyForProvider('anthropic')).toBe('anthropic');
    expect(familyForProvider('anthropic', 'https://api.z.ai/api/anthropic')).toBe('zai');
    expect(familyForProvider('openai', 'https://openrouter.ai/api/v1')).toBe('any');
    expect(familyForProvider('openai', 'https://api.deepseek.com/v1')).toBe('deepseek');
    expect(familyForProvider('openai', 'http://127.0.0.1:11434/v1')).toBeUndefined();
    expect(familyForProvider('gemini')).toBe('gemini');
  });
});

describe('cost', () => {
  test('computeCost bills each token class at its own rate', () => {
    const info = lookupModel('anthropic', 'claude-sonnet-5-5');
    const cost = computeCost(info, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000 });
    // 2 + 1 + 0.2 (reads at $0.10/M) + 1 (5 minute writes at $2.50/M)
    expect(cost).toBeCloseTo(4.2, 6);
  });

  test('Claude prices as on the pricing page (2026-10-22): Sonnet 5.5 reads $0.10/M, 1 hour writes 2x input', () => {
    const sonnet = lookupModel('anthropic', 'claude-sonnet-5-5');
    expect(sonnet).toMatchObject({ inputPrice: 2, outputPrice: 10, cacheReadPrice: 0.1, cacheWritePrice: 2.5, cacheWrite1hPrice: 4 });
    const opus = lookupModel('anthropic', 'claude-opus-5-5');
    expect(opus).toMatchObject({ inputPrice: 4, outputPrice: 20, cacheReadPrice: 0.2, cacheWritePrice: 5, cacheWrite1hPrice: 8 });
    // Fable 5.1 reads at 0.025x
    expect(lookupModel('anthropic', 'claude-fable-5-1')).toMatchObject({ inputPrice: 10, cacheReadPrice: 0.25, cacheWrite1hPrice: 20 });
    // other vendors carry no 1 hour price
    expect(lookupModel('openai', 'gpt-5.5').cacheWrite1hPrice).toBeUndefined();
  });

  test('1 hour cache writes cost 2x input, 5 minute ones 1.25x: a 100K switch to Sonnet 5.5 bills $0.40, not $0.25', () => {
    const sonnet = lookupModel('anthropic', 'claude-sonnet-5-5');
    const opus = lookupModel('anthropic', 'claude-opus-5-5');
    const write = (cw1h: number) => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 100_000, cacheWrite1hTokens: cw1h });
    expect(computeCost(sonnet, write(100_000))).toBeCloseTo(0.4, 9);
    expect(computeCost(sonnet, write(0))).toBeCloseTo(0.25, 9);
    expect(computeCost(opus, write(100_000))).toBeCloseTo(0.8, 9);
    expect(computeCost(opus, write(0))).toBeCloseTo(0.5, 9);
    // a split write: 60K at 1h, 40K at 5m
    expect(computeCost(sonnet, write(60_000))).toBeCloseTo(0.06 * 4 + 0.04 * 2.5, 9);
    // the 1h part can never exceed the writes
    expect(computeCost(sonnet, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 10, cacheWrite1hTokens: 1_000 })).toBeCloseTo((10 * 4) / 1e6, 12);
    // a model with no 1 hour price falls back to 2x input
    expect(computeCost({ inputPrice: 3, outputPrice: 0, cacheReadPrice: 0, cacheWritePrice: 3.75 }, write(100_000))).toBeCloseTo(0.6, 9);
  });

  test('an input price override moves the 1 hour price with it; a plan prices nothing', () => {
    expect(lookupModel('anthropic', 'claude-sonnet-5-5', { override: { inputPrice: 3 } }).cacheWrite1hPrice).toBe(6);
    expect(lookupModel('anthropic', 'claude-sonnet-5-5', { override: { inputPrice: 3, cacheWrite1hPrice: 5 } }).cacheWrite1hPrice).toBe(5);
  });
});

describe('LiteLLM overlay', () => {
  const sample = {
    sample_spec: { input_cost_per_token: 1 },
    'claude-opus-5-5': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, cache_read_input_token_cost: 3e-7 },
    'zai/glm-9': { litellm_provider: 'zai', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 8e-6, max_input_tokens: 500_000, max_output_tokens: 64_000, supports_reasoning: true },
    'dall-e-3': { mode: 'image_generation', input_cost_per_token: 1 },
  };

  test('prices override the catalog; unknown models get LiteLLM limits', () => {
    expect(applyLiteLLMData(sample)).toBe(2);
    // a new input price moves the 1 hour write to 2x it
    expect(lookupModel('anthropic', 'claude-opus-5-5')).toMatchObject({ inputPrice: 3, outputPrice: 15, cacheReadPrice: 0.3, cacheWritePrice: 5, cacheWrite1hPrice: 6, contextWindow: 1_000_000 });
    expect(lookupModel('zai', 'glm-9')).toMatchObject({ inputPrice: 2, outputPrice: 8, contextWindow: 500_000, maxOutput: 64_000, thinking: true });
  });

  test("LiteLLM's 1 hour write price wins when it names one", () => {
    applyLiteLLMData({ 'claude-sonnet-5-5': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 2e-6, cache_creation_input_token_cost_above_1hr: 4.5e-6 } });
    try {
      expect(lookupModel('anthropic', 'claude-sonnet-5-5').cacheWrite1hPrice).toBe(4.5);
    } finally {
      clearLiteLLMData();
    }
  });

  test('refreshPricingFromLiteLLM downloads once a day and falls back to the stale copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-litellm-'));
    try {
      let calls = 0;
      const okFetch = async () => {
        calls++;
        return new Response(JSON.stringify(sample));
      };
      expect(await refreshPricingFromLiteLLM(dir, { fetch: okFetch })).toEqual({ models: 2, source: 'network' });
      expect(await refreshPricingFromLiteLLM(dir, { fetch: okFetch })).toEqual({ models: 2, source: 'cache' });
      expect(calls).toBe(1);

      const old = (Date.now() - 2 * 86_400_000) / 1000;
      utimesSync(join(dir, 'litellm-prices.json'), old, old);
      const failing = async () => new Response('nope', { status: 503 });
      const res = await refreshPricingFromLiteLLM(dir, { fetch: failing });
      expect(res.source).toBe('stale-cache');
      expect(res.models).toBe(2);

      const empty = mkdtempSync(join(tmpdir(), 'conclave-litellm-'));
      expect((await refreshPricingFromLiteLLM(empty, { fetch: failing })).source).toBe('none');
      rmSync(empty, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a download that ends after the home is gone does not make the home again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-litellm-home-'));
    // the engine closed and its home was removed while the price table was downloading
    const slowFetch = async () => {
      rmSync(home, { recursive: true, force: true });
      return new Response(JSON.stringify(sample));
    };
    const res = await refreshPricingFromLiteLLM(join(home, 'cache'), { fetch: slowFetch });
    expect(res).toEqual({ models: 2, source: 'network' });
    expect(existsSync(home)).toBe(false);
  });
});

describe('tool names', () => {
  test('valid names pass through; long or invalid names are shortened deterministically', () => {
    expect(wireToolName('Read')).toBe('Read');
    const long = 'mcp__' + 'x'.repeat(80);
    const w = wireToolName(long);
    expect(w.length).toBe(64);
    expect(wireToolName(long)).toBe(w);
    expect(wireToolName('a.b')).toMatch(/^a_b_[0-9a-f]{8}$/);
    expect(wireToolName('a.b')).not.toBe(wireToolName('a_b'));
    expect(wireToolName('9lives', GEMINI_TOOL_NAME_RULES)).toMatch(/^_9lives_[0-9a-f]{8}$/);
    expect(wireToolName('ns.tool', GEMINI_TOOL_NAME_RULES)).toBe('ns.tool');
    const map = new ToolNameMap();
    expect(map.original(map.wire(long))).toBe(long);
    expect(map.original('Unknown')).toBe('Unknown');
  });
});
