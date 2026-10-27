import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { OpenAIProvider } from '../../src/providers/openai';
import { OpenAIResponsesProvider } from '../../src/providers/openai-responses';
import { ProviderRegistry } from '../../src/providers/registry';
import { jsonResponse, mockServer, sseResponse } from './mock';

const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'CLIPROXY_API_KEY', 'CONCLAVE_MODEL'];
const saved: Record<string, string | undefined> = {};
let home = '';
let config: ConfigStore;
let registry: ProviderRegistry;

const server = mockServer((req) => {
  const url = new URL(req.url);
  if (url.pathname === '/v1/models') return jsonResponse({ data: [{ id: 'llama-4-local' }, { id: 'nomic-embed-text' }] });
  return sseResponse([
    { data: { id: 'c1', choices: [{ index: 0, delta: { content: 'ok' } }] } },
    { data: { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
    'data: [DONE]\n\n',
  ]);
});

/** Only the mock server is reachable; anything else fails fast like an offline network. */
const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (u.origin !== server.url) throw new TypeError(`offline: ${u.host}`);
  return fetch(u, init);
};

beforeAll(() => {
  for (const k of KEY_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'conclave-registry-'));
  config = new ConfigStore(home);
  config.update({
    providers: {
      local: { type: 'openai', name: 'Local LLM', baseUrl: `${server.url}/v1` },
      codex: { type: 'openai', baseUrl: `${server.url}/v1`, apiKey: 'k', responsesApi: true, models: ['gpt-5.3-codex'] },
    } as any,
  });
  registry = new ProviderRegistry(config, { fetch: fetchImpl });
});

afterAll(() => {
  registry.dispose();
  server.stop();
  rmSync(home, { recursive: true, force: true });
  for (const k of KEY_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('ProviderRegistry.get', () => {
  test('builds providers by type and skips ACP', () => {
    expect(registry.get('anthropic')).toBeInstanceOf(AnthropicProvider);
    // Chat Completions at /api/coding/paas/v4 since 0.4.21
    expect(registry.get('zai')).toBeInstanceOf(OpenAIProvider);
    expect(registry.get('openai')).toBeInstanceOf(OpenAIProvider);
    expect(registry.get('codex')).toBeInstanceOf(OpenAIResponsesProvider);
    expect(registry.get('google')?.type).toBe('gemini');
    expect(registry.get('claude-code')).toBeUndefined();
    expect(registry.get('nope')).toBeUndefined();
  });

  test('caches until config changes', () => {
    const a = registry.get('openai');
    expect(registry.get('openai')).toBe(a);
    config.setSecret('providers', 'openai', 'sk-test');
    const b = registry.get('openai');
    expect(b).not.toBe(a);
    expect(registry.isConfigured('openai')).toBe(true);
  });
});

describe('ProviderRegistry.resolve', () => {
  test('explicit refs, including ACP providers', () => {
    expect(registry.resolve('anthropic/claude-sonnet-5-5')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', acp: false });
    const acp = registry.resolve('claude-code/opus');
    expect(acp).toMatchObject({ provider: 'claude-code', model: 'opus', acp: true });
    expect(acp.info.name).toBe('Claude Opus 5.5');
    // A model part with slashes stays intact.
    expect(registry.resolve('openrouter/anthropic/claude-sonnet-4.5')).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
  });

  test('routing aliases', () => {
    expect(registry.resolve('fast')).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(registry.resolve('smart')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    // Only OpenAI has a key, so "deep" picks its best model.
    expect(registry.resolve('deep')).toMatchObject({ provider: 'openai', model: 'gpt-5.5' });
  });

  test('Claude Code aliases', () => {
    expect(registry.resolve('opus')).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(registry.resolve('haiku').info.tier).toBe('fast');
    expect(registry.resolve('inherit')).toMatchObject({ model: 'claude-sonnet-5-5' });
  });

  test('bare ids search provider model lists, then the serving family', () => {
    expect(registry.resolve('glm-5')).toMatchObject({ provider: 'zai', model: 'glm-5' });
    expect(registry.resolve('gpt-5.4')).toMatchObject({ provider: 'openai', model: 'gpt-5.4' });
    expect(registry.resolve('gpt-5.3-codex').provider).toBe('codex');
    // No Google key: still resolves to the Gemini provider so the error names the missing key.
    expect(registry.resolve('gemini-3.1-pro-preview').provider).toBe('google');
    expect(() => registry.resolve('totally-unknown-model')).toThrow(/Unknown model/);
  });
});

describe('ProviderRegistry.groups, costOf, test', () => {
  test('groups list endpoint models for usable providers and catalog models otherwise', async () => {
    const groups = await registry.groups();
    const by = Object.fromEntries(groups.map((g) => [g.provider, g]));

    expect(by.local).toMatchObject({ name: 'Local LLM', type: 'openai', configured: true, enabled: true });
    expect(by.local.models.map((m) => m.id)).toEqual(['llama-4-local']);

    expect(by.anthropic.configured).toBe(false);
    expect(by.anthropic.error).toBeUndefined();
    expect(by.anthropic.models.some((m) => m.id === 'claude-opus-5-5')).toBe(true);

    // Configured but unreachable: falls back to the catalog without failing.
    expect(by.openai.configured).toBe(true);
    expect(by.openai.models.some((m) => m.id === 'gpt-5.5')).toBe(true);

    expect(by.zai.models.map((m) => m.id)).toEqual(['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5.3-flash', 'glm-4.7', 'glm-4.5-air']);
    expect(by.ollama.enabled).toBe(false);
    expect(by['claude-code'].type).toBe('acp');
    expect(by['claude-code'].models.map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  });

  test('costOf uses catalog prices and prefers a provider-reported cost', () => {
    const info = registry.resolve('anthropic/claude-haiku-5-5').info;
    expect(registry.costOf(info, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6, 6);
    expect(registry.costOf(info, { inputTokens: 5, outputTokens: 5, costUsd: 0.01 })).toBe(0.01);
  });

  test('a custom provider model is priced from modelOverrides, and stays $0 without one', () => {
    config.update({
      providers: {
        experientiallabs: {
          type: 'openai',
          name: 'experientiallabs',
          baseUrl: 'https://api.experientiallabs.ai/v1',
          apiKey: 'k',
          models: ['glm-5.3-uncensored', 'glm-5.3-flash-uncensored'],
        },
      } as any,
    });
    // the shape `conclave config set providers.experientiallabs.modelOverrides '<json>'` patches in
    config.update({ providers: { experientiallabs: { modelOverrides: { 'glm-5.3-uncensored': { inputPrice: 1.4, outputPrice: 4.4, cacheReadPrice: 1.4, cacheWritePrice: 1.4 } } } } as any });
    const priced = registry.resolve('experientiallabs/glm-5.3-uncensored').info;
    expect(priced).toMatchObject({ name: 'GLM-5.3 Uncensored', inputPrice: 1.4, outputPrice: 4.4 });
    expect(registry.costOf(priced, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 })).toBeCloseTo(7.2, 6);
    const free = registry.resolve('experientiallabs/glm-5.3-flash-uncensored').info;
    expect(free).toMatchObject({ inputPrice: 0, outputPrice: 0 });
    expect(registry.costOf(free, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
  });

  test('test() sends a tiny request and reports latency', async () => {
    config.update({ providers: { local: { type: 'openai', baseUrl: `${server.url}/v1`, models: ['llama-4-local'] } } as any });
    const res = await registry.test('local');
    expect(res.ok).toBe(true);
    expect(res.detail).toBe('llama-4-local: ok');
    expect(typeof res.latencyMs).toBe('number');
    expect(server.requests.at(-1)!.body.max_tokens).toBe(32);

    const bad = await registry.test('openai');
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('offline');
    expect((await registry.test('missing')).ok).toBe(false);
  });
});
