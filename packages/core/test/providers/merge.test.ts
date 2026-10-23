/**
 * One entry per model in the pickers (providers/merge.ts): the Claude plan
 * and the API key both list claude-opus-5-5; pickers show the first route's
 * entry with the route in words, and the others point at it.
 *
 *   bun test packages/core/test/providers/merge.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { ModelEntry, ModelGroup } from '../../src/client';
import { mergeModelGroups, routeWords, shownRef, type RouteStep } from '../../src/providers/merge';

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

describe('routeWords', () => {
  test('plan then key; plans in a row read as one; a member hears the plan is the hub', () => {
    expect(routeWords([plan, key], 'anthropic')).toBe('your Claude plan, then API key');
    expect(routeWords([plan, plan, key], 'anthropic')).toBe('your Claude plans, then API key');
    expect(routeWords([key, plan], 'openai')).toBe('API key, then your ChatGPT plan');
    expect(routeWords([plan], 'gemini', { member: true })).toBe("the hub's Gemini plan");
  });
});

describe('mergeModelGroups', () => {
  const groups = [
    group('anthropic', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']),
    group('openai', ['gpt-5.5'], { type: 'openai' }),
    group('cliproxy', ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5.5', 'neu/claude-opus-5-5'], { type: 'openai' }),
    group('zai', ['glm-5']),
  ];

  test("each model once: the plan's entry with the route, the key's points at it", () => {
    const out = mergeModelGroups(groups, order([plan, key]));
    expect(entry(out, 'cliproxy/claude-opus-5-5')).toMatchObject({ via: 'your Claude plan, then API key', refs: ['cliproxy/claude-opus-5-5', 'anthropic/claude-opus-5-5'] });
    expect(entry(out, 'anthropic/claude-opus-5-5')).toMatchObject({ sameAs: 'cliproxy/claude-opus-5-5' });
    expect(entry(out, 'anthropic/claude-opus-5-5')?.via).toBeUndefined();
    expect(entry(out, 'cliproxy/gpt-5.5')).toMatchObject({ via: 'your ChatGPT plan, then API key' });
    expect(entry(out, 'openai/gpt-5.5')).toMatchObject({ sameAs: 'cliproxy/gpt-5.5' });
    // only the key has Haiku 4.5: it stays, and says where it goes
    expect(entry(out, 'anthropic/claude-haiku-4-5')).toMatchObject({ via: 'API key' });
    expect(entry(out, 'anthropic/claude-haiku-4-5')?.sameAs).toBeUndefined();
    // an account prefix names one plan, and GLM has no order: untouched
    expect(entry(out, 'cliproxy/neu/claude-opus-5-5')).toEqual(model('cliproxy', 'neu/claude-opus-5-5'));
    expect(entry(out, 'zai/glm-5')).toEqual(model('zai', 'glm-5'));
    // the groups the hub returned are not changed
    expect(groups[0].models[0].sameAs).toBeUndefined();
  });

  test('the key first in the order: its entry is shown', () => {
    const out = mergeModelGroups(groups, order([key, plan]));
    expect(entry(out, 'anthropic/claude-opus-5-5')).toMatchObject({ via: 'API key, then your Claude plan', refs: ['anthropic/claude-opus-5-5', 'cliproxy/claude-opus-5-5'] });
    expect(entry(out, 'cliproxy/claude-opus-5-5')?.sameAs).toBe('anthropic/claude-opus-5-5');
  });

  test('no API key: the plan is the only route, and the keyless catalog entry points at it', () => {
    const noKey = groups.map((g) => (g.provider === 'anthropic' ? { ...g, configured: false } : g));
    const out = mergeModelGroups(noKey, order([plan]));
    expect(entry(out, 'cliproxy/claude-opus-5-5')).toMatchObject({ via: 'your Claude plan', refs: ['cliproxy/claude-opus-5-5', 'anthropic/claude-opus-5-5'] });
    expect(entry(out, 'anthropic/claude-opus-5-5')?.sameAs).toBe('cliproxy/claude-opus-5-5');
  });

  test("a member who may not use the hub's plan sees only the key's route", () => {
    const member = groups.map((g) => (g.provider === 'cliproxy' ? { ...g, configured: false } : g));
    const out = mergeModelGroups(member, order([plan, key]), { member: true });
    expect(entry(out, 'anthropic/claude-opus-5-5')).toMatchObject({ via: 'API key', refs: ['anthropic/claude-opus-5-5', 'cliproxy/claude-opus-5-5'] });
    expect(entry(out, 'cliproxy/claude-opus-5-5')?.sameAs).toBe('anthropic/claude-opus-5-5');
  });

  test('a provider that is off is no route; harnesses are left alone', () => {
    const off = [...groups.map((g) => (g.provider === 'cliproxy' ? { ...g, enabled: false } : g)), group('claude-code', ['opus'], { type: 'acp' })];
    const out = mergeModelGroups(off, order([plan, key]));
    expect(entry(out, 'anthropic/claude-opus-5-5')).toMatchObject({ via: 'API key' });
    expect(entry(out, 'anthropic/claude-opus-5-5')?.sameAs).toBeUndefined();
    expect(entry(out, 'claude-code/opus')).toEqual(model('claude-code', 'opus'));
  });

  test('no order anywhere: the groups come back as they were', () => {
    expect(mergeModelGroups(groups, () => undefined)).toBe(groups);
  });

  test('an old session or agent that names the key ref shows as the merged entry', () => {
    const out = mergeModelGroups(groups, order([plan, key]));
    expect(shownRef(out, 'anthropic/claude-opus-5-5')).toBe('cliproxy/claude-opus-5-5');
    expect(shownRef(out, 'cliproxy/claude-opus-5-5')).toBe('cliproxy/claude-opus-5-5');
    expect(shownRef(out, 'claude-code/opus')).toBe('claude-code/opus');
  });
});
