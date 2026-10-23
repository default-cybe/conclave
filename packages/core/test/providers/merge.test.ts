/**
 * One entry per model in the pickers (providers/merge.ts): the Claude plan
 * and the API key both list claude-opus-5-5, a plan with a short name lists
 * it again as neu/claude-opus-5-5, OpenRouter as anthropic/claude-opus-5-5.
 * Pickers show the first route's entry with the route in words, and the
 * others point at it.
 *
 *   bun test packages/core/test/providers/merge.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { ModelEntry, ModelGroup } from '../../src/client';
import { mergeModelGroups, modelKey, routeWords, shownRef, type RouteStep } from '../../src/providers/merge';

const model = (provider: string, id: string): ModelEntry =>
  ({ id, ref: `${provider}/${id}`, provider, name: id, contextWindow: 200_000, maxOutput: 32_000, vision: true, tools: true, thinking: true, caching: 'explicit', inputPrice: 0, outputPrice: 0, cacheReadPrice: 0, cacheWritePrice: 0 }) as ModelEntry;

const group = (provider: string, ids: string[], p: Partial<ModelGroup> = {}): ModelGroup => ({ provider, name: provider, type: 'anthropic', configured: true, enabled: true, models: ids.map((id) => model(provider, id)), ...p });

const plan: RouteStep = { provider: 'cliproxy', kind: 'subscription' };
const key: RouteStep = { provider: 'anthropic', kind: 'api' };
const oaKey: RouteStep = { provider: 'openai', kind: 'api' };

/** The owner's order: plan first for Claude and ChatGPT models, no order for GLM. */
const order =
  (claude: RouteStep[], gpt: RouteStep[] = [{ provider: 'cliproxy', kind: 'subscription' }, oaKey]) =>
  (m: string): RouteStep[] | undefined =>
    m.startsWith('claude') ? claude : m.startsWith('gpt') ? gpt : undefined;

const entry = (groups: ModelGroup[], ref: string) => groups.flatMap((g) => g.models).find((m) => m.ref === ref);
/** What a picker shows: every entry that points nowhere else. */
const shown = (groups: ModelGroup[]) => groups.filter((g) => g.type !== 'acp').flatMap((g) => g.models.filter((m) => !m.sameAs).map((m) => m.ref));

describe('routeWords', () => {
  test('plan then key; plans in a row read as one; a member hears the plan is the hub', () => {
    expect(routeWords([plan, key], 'anthropic')).toBe('your Claude plan, then API key');
    expect(routeWords([plan, plan, key], 'anthropic')).toBe('your Claude plans, then API key');
    expect(routeWords([key, plan], 'openai')).toBe('API key, then your ChatGPT plan');
    expect(routeWords([plan], 'gemini', { member: true })).toBe("the hub's Gemini plan");
  });
});

describe('modelKey', () => {
  test('account and vendor prefixes, case and 4.5 against 4-5 do not count; a dated snapshot and -latest stay their own', () => {
    expect(modelKey('neu/claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelKey('neu-claude/Claude-Opus-5-5')).toBe('claude-opus-5-5');
    expect(modelKey('anthropic/claude-opus-4.5')).toBe(modelKey('claude-opus-4-5'));
    expect(modelKey('openai/gpt-6.1-sol')).toBe(modelKey('gpt-6.1-sol'));
    expect(modelKey('claude-opus-4-5-20251101')).not.toBe(modelKey('claude-opus-4-5'));
    expect(modelKey('claude-sonnet-latest')).not.toBe(modelKey('claude-sonnet'));
  });
});

describe('mergeModelGroups', () => {
  const groups = [
    group('anthropic', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']),
    group('openai', ['gpt-5.5'], { type: 'openai' }),
    group('cliproxy', ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5.5', 'neu/claude-opus-5-5'], { type: 'openai' }),
    group('zai', ['glm-5']),
  ];

  test("each model once: the plan's entry with the route, the key's and the prefixed copy point at it", () => {
    const out = mergeModelGroups(groups, order([plan, key]));
    expect(entry(out, 'cliproxy/claude-opus-5-5')).toMatchObject({ via: 'your Claude plan, then API key', refs: ['cliproxy/claude-opus-5-5', 'anthropic/claude-opus-5-5', 'cliproxy/neu/claude-opus-5-5'] });
    expect(entry(out, 'anthropic/claude-opus-5-5')).toMatchObject({ sameAs: 'cliproxy/claude-opus-5-5' });
    expect(entry(out, 'anthropic/claude-opus-5-5')?.via).toBeUndefined();
    expect(entry(out, 'cliproxy/neu/claude-opus-5-5')).toMatchObject({ sameAs: 'cliproxy/claude-opus-5-5' });
    // the key is in the order, so its ref follows the order too: the one choice of its own is the plan's prefix
    expect(entry(out, 'cliproxy/claude-opus-5-5')?.choices).toEqual(['cliproxy/neu/claude-opus-5-5']);
    expect(entry(out, 'cliproxy/gpt-5.5')).toMatchObject({ via: 'your ChatGPT plan, then API key' });
    expect(entry(out, 'openai/gpt-5.5')).toMatchObject({ sameAs: 'cliproxy/gpt-5.5' });
    // only the key has Haiku 4.5: it stays, and says where it goes
    expect(entry(out, 'anthropic/claude-haiku-4-5')).toMatchObject({ via: 'API key' });
    expect(entry(out, 'anthropic/claude-haiku-4-5')?.sameAs).toBeUndefined();
    // GLM has no order and one route: untouched
    expect(entry(out, 'zai/glm-5')).toEqual(model('zai', 'glm-5'));
    // the groups the hub returned are not changed
    expect(groups[0].models[0].sameAs).toBeUndefined();
    expect(shown(out)).toEqual(['anthropic/claude-haiku-4-5', 'cliproxy/claude-opus-5-5', 'cliproxy/claude-sonnet-5-5', 'cliproxy/gpt-5.5', 'zai/glm-5']);
  });

  test('the key first in the order: its entry is shown', () => {
    const out = mergeModelGroups(groups, order([key, plan]));
    expect(entry(out, 'anthropic/claude-opus-5-5')).toMatchObject({ via: 'API key, then your Claude plan', refs: ['anthropic/claude-opus-5-5', 'cliproxy/claude-opus-5-5', 'cliproxy/neu/claude-opus-5-5'] });
    expect(entry(out, 'cliproxy/claude-opus-5-5')?.sameAs).toBe('anthropic/claude-opus-5-5');
    expect(entry(out, 'cliproxy/neu/claude-opus-5-5')?.sameAs).toBe('anthropic/claude-opus-5-5');
  });

  test('no API key: the plan is the only route, and the keyless catalog entry points at it', () => {
    const noKey = groups.map((g) => (g.provider === 'anthropic' ? { ...g, configured: false } : g));
    const out = mergeModelGroups(noKey, order([plan]));
    expect(entry(out, 'cliproxy/claude-opus-5-5')).toMatchObject({ via: 'your Claude plan', refs: ['cliproxy/claude-opus-5-5', 'anthropic/claude-opus-5-5', 'cliproxy/neu/claude-opus-5-5'] });
    expect(entry(out, 'anthropic/claude-opus-5-5')?.sameAs).toBe('cliproxy/claude-opus-5-5');
    // a provider with no key is no choice
    expect(entry(out, 'cliproxy/claude-opus-5-5')?.choices).toEqual(['cliproxy/neu/claude-opus-5-5']);
  });

  test("a member who may not use the hub's plan sees only the key's route", () => {
    const member = groups.map((g) => (g.provider === 'cliproxy' ? { ...g, configured: false } : g));
    const out = mergeModelGroups(member, order([plan, key]), { member: true });
    expect(entry(out, 'anthropic/claude-opus-5-5')).toMatchObject({ via: 'API key', refs: ['anthropic/claude-opus-5-5', 'cliproxy/claude-opus-5-5', 'cliproxy/neu/claude-opus-5-5'] });
    expect(entry(out, 'anthropic/claude-opus-5-5')?.choices).toBeUndefined();
    expect(entry(out, 'cliproxy/claude-opus-5-5')?.sameAs).toBe('anthropic/claude-opus-5-5');
  });

  test('a provider that is off is no route; harnesses are left alone', () => {
    const off = [...groups.map((g) => (g.provider === 'cliproxy' ? { ...g, enabled: false } : g)), group('claude-code', ['opus', 'claude-opus-5-5'], { type: 'acp' })];
    const out = mergeModelGroups(off, order([plan, key]));
    expect(entry(out, 'anthropic/claude-opus-5-5')?.sameAs).toBeUndefined();
    expect(entry(out, 'cliproxy/claude-opus-5-5')?.sameAs).toBe('anthropic/claude-opus-5-5');
    expect(entry(out, 'claude-code/opus')).toEqual(model('claude-code', 'opus'));
    // a harness's model of the same name is another engine
    expect(entry(out, 'claude-code/claude-opus-5-5')).toEqual(model('claude-code', 'claude-opus-5-5'));
  });

  test('no order: the vendor\'s own provider, then a bare id; every other copy is a choice', () => {
    const out = mergeModelGroups(groups, () => undefined);
    expect(entry(out, 'anthropic/claude-opus-5-5')).toMatchObject({ refs: ['anthropic/claude-opus-5-5', 'cliproxy/claude-opus-5-5', 'cliproxy/neu/claude-opus-5-5'], choices: ['cliproxy/claude-opus-5-5', 'cliproxy/neu/claude-opus-5-5'] });
    expect(entry(out, 'anthropic/claude-opus-5-5')?.via).toBeUndefined();
    expect(entry(out, 'cliproxy/neu/claude-opus-5-5')?.sameAs).toBe('anthropic/claude-opus-5-5');
    expect(entry(out, 'openai/gpt-5.5')?.sameAs).toBeUndefined();
    expect(entry(out, 'cliproxy/gpt-5.5')?.sameAs).toBe('openai/gpt-5.5');
    // nothing to merge anywhere: the groups come back as they were
    const single = [group('zai', ['glm-5']), group('anthropic', ['claude-opus-5-5'])];
    expect(mergeModelGroups(single, () => undefined)).toBe(single);
  });

  test('an old session or agent that names the key ref or a prefix shows as the merged entry', () => {
    const out = mergeModelGroups(groups, order([plan, key]));
    expect(shownRef(out, 'anthropic/claude-opus-5-5')).toBe('cliproxy/claude-opus-5-5');
    expect(shownRef(out, 'cliproxy/neu/claude-opus-5-5')).toBe('cliproxy/claude-opus-5-5');
    expect(shownRef(out, 'cliproxy/claude-opus-5-5')).toBe('cliproxy/claude-opus-5-5');
    expect(shownRef(out, 'claude-code/opus')).toBe('claude-code/opus');
  });
});

describe('the hub as the owner has it', () => {
  // CLIProxyAPI: the main accounts' list, a Claude plan named neu-claude, a ChatGPT plan named neu; the keys; OpenRouter; Ollama; harnesses
  const hub = [
    group('anthropic', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']),
    group('openai', ['gpt-6.1-sol', 'gpt-6-astra'], { type: 'openai' }),
    group('google', ['gemini-3-pro'], { type: 'gemini', configured: false }),
    group(
      'cliproxy',
      ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6-astra', 'nova-preview', 'gemini-3-pro', 'neu-claude/claude-opus-5-5', 'neu-claude/claude-sonnet-5-5', 'neu/gpt-6.1-sol', 'neu/gpt-6-astra', 'neu/nova-preview'],
      { type: 'openai' },
    ),
    group('openrouter', ['anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol', 'moonshotai/kimi-k3', 'meta-llama/llama-5'], { type: 'openai' }),
    group('ollama', ['llama-5'], { type: 'openai' }),
    group('claude-code', ['default', 'opus'], { type: 'acp' }),
    group('codex', ['default', 'gpt-6.1-sol', 'nova-preview'], { type: 'acp' }),
  ];
  const claude = [plan, plan, key];
  const gpt = [plan, oaKey];
  const routeOf = (m: string): RouteStep[] | undefined => (m.startsWith('claude') ? claude : m.startsWith('gpt') ? gpt : m.startsWith('gemini') ? [plan] : undefined);
  const out = mergeModelGroups(hub, routeOf, { vendorOf: (m) => (m === 'nova-preview' ? 'openai' : undefined) });

  test('each model once, on the route the owner put first', () => {
    expect(shown(out)).toEqual([
      'anthropic/claude-haiku-5-5',
      'cliproxy/claude-opus-5-5',
      'cliproxy/claude-sonnet-5-5',
      'cliproxy/gpt-6.1-sol',
      'cliproxy/gpt-6-astra',
      'cliproxy/nova-preview',
      'cliproxy/gemini-3-pro',
      'openrouter/moonshotai/kimi-k3',
      'openrouter/meta-llama/llama-5',
      // a local model is not the hosted one
      'ollama/llama-5',
    ]);
    expect(entry(out, 'cliproxy/claude-opus-5-5')).toMatchObject({
      via: 'your Claude plans, then API key',
      refs: ['cliproxy/claude-opus-5-5', 'anthropic/claude-opus-5-5', 'cliproxy/neu-claude/claude-opus-5-5', 'openrouter/anthropic/claude-opus-5.5'],
      choices: ['cliproxy/neu-claude/claude-opus-5-5', 'openrouter/anthropic/claude-opus-5.5'],
    });
    expect(entry(out, 'cliproxy/gpt-6.1-sol')?.choices).toEqual(['cliproxy/neu/gpt-6.1-sol', 'openrouter/openai/gpt-6.1-sol']);
    // the harnesses keep their own models
    expect(out.find((g) => g.provider === 'codex')!.models.every((m) => !m.sameAs)).toBe(true);
  });

  test("a model only a plan lists, under an id no name places, stays once, filed under that plan's vendor", () => {
    expect(entry(out, 'cliproxy/nova-preview')).toMatchObject({ vendor: 'openai', refs: ['cliproxy/nova-preview', 'cliproxy/neu/nova-preview'], choices: ['cliproxy/neu/nova-preview'] });
    expect(entry(out, 'cliproxy/neu/nova-preview')).toMatchObject({ sameAs: 'cliproxy/nova-preview', vendor: 'openai' });
    expect(entry(out, 'codex/nova-preview')).toEqual(model('codex', 'nova-preview'));
  });

  test('a saved ref on any hidden copy still finds its row', () => {
    for (const ref of ['anthropic/claude-opus-5-5', 'cliproxy/neu-claude/claude-opus-5-5', 'openrouter/anthropic/claude-opus-5.5']) expect(shownRef(out, ref)).toBe('cliproxy/claude-opus-5-5');
    expect(shownRef(out, 'openai/gpt-6.1-sol')).toBe('cliproxy/gpt-6.1-sol');
  });
});
