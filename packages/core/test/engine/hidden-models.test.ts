/**
 * Hidden models (models.hidden, config/hidden.ts): refs and `*` globs the
 * owner hid leave the model list, isUsable says no (so tiers and fallbacks
 * skip them), the refusal walk passes over them, and a session saved on one
 * gets an error naming the setting instead of a silent switch.
 */
import { describe, expect, test } from 'bun:test';
import type { Message, TextBlock } from '../../src/types';
import { isHiddenModel } from '../../src/config/hidden';
import { agentModelRef } from '../../src/extensions/agent-model';
import { startTestEngine, type Step } from './harness';

const REFUSE: Step = { blocks: [{ text: 'I can not help with that.' }], stop: 'refusal' };
const cfg = (hidden?: unknown) => ({ models: { hidden } }) as never;

describe('isHiddenModel', () => {
  test('exact refs and * globs, case-insensitive; other characters are literal', () => {
    expect(isHiddenModel(cfg(['cliproxy/glm-*']), 'cliproxy/glm-5.3')).toBe(true);
    expect(isHiddenModel(cfg(['cliproxy/glm-*']), 'CLIPROXY/GLM-5.3')).toBe(true);
    expect(isHiddenModel(cfg(['cliproxy/glm-*']), 'zai/glm-5.3')).toBe(false);
    expect(isHiddenModel(cfg(['cliproxy/glm-*']), 'cliproxy/claude-opus-5-5')).toBe(false);
    expect(isHiddenModel(cfg(['zai/glm-5.3']), 'zai/glm-5.3')).toBe(true);
    expect(isHiddenModel(cfg(['zai/glm-5.3']), 'zai/glm-5.3-flash')).toBe(false);
    expect(isHiddenModel(cfg(['zai/glm-5.3']), 'zai/glm-5x3')).toBe(false);
    expect(isHiddenModel(cfg(['*/glm-*']), 'zai/glm-5')).toBe(true);
  });

  test('unset, empty, blank and non-string entries hide nothing', () => {
    expect(isHiddenModel({} as never, 'a/b')).toBe(false);
    expect(isHiddenModel(cfg([]), 'a/b')).toBe(false);
    expect(isHiddenModel(cfg(['', '  ', 3, null]), 'a/b')).toBe(false);
    expect(isHiddenModel(cfg('a/b'), 'a/b')).toBe(false);
  });
});

describe('on a real engine', () => {
  // overrides win over config.update, so the last test leaves hidden out of them and sets it later
  const start = (hidden: string[] | null = ['glm/glm-*']) =>
    startTestEngine({
      models: ['claude-opus-5-5'],
      extraProviders: { neu: ['claude-opus-5-5'], glm: ['glm-5.3'] },
      script: [[{ text: 'script' }]],
      route: (_b, _t, p) => (p === 'neu' ? [{ text: 'neu answers' }] : REFUSE),
      overrides: {
        limits: { maxRetries: 0 },
        models: {
          ...(hidden ? { hidden } : {}),
          tiers: { fast: 'glm/glm-5.3' },
          refusalFallback: { enabled: true, entries: [{ model: 'glm/glm-5.3' }, { model: 'neu/claude-opus-5-5' }] },
        },
      } as never,
    });

  test('list, isUsable, tiers and new sessions skip a hidden model', async () => {
    const t = await start();
    try {
      const refs = (await t.engine.listModels()).flatMap((g) => g.models.map((m) => m.ref));
      expect(refs).toContain('neu/claude-opus-5-5');
      expect(refs).not.toContain('glm/glm-5.3');
      expect(t.engine.isUsable('glm/glm-5.3')).toBe(false);
      expect(t.engine.isUsable('neu/claude-opus-5-5')).toBe(true);
      expect(agentModelRef(t.engine, 'fast', 'mock/claude-opus-5-5').model).not.toBe('glm/glm-5.3');
      await expect(t.engine.createSession({ title: 't', cwd: t.cwd, model: 'glm/glm-5.3' })).rejects.toThrow('models.hidden');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('the refusal walk passes over a hidden entry', async () => {
    const t = await start();
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: 'mock/claude-opus-5-5' });
      await t.run(s.id, 'go');
      expect(t.requestProviders).toEqual(['mock', 'neu']);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a session saved on a model hidden later says so and does not switch', async () => {
    const t = await start(null);
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, model: 'glm/glm-5.3' });
      t.engine.config.update({ models: { ...t.engine.config.get().models, hidden: ['glm/glm-*'] } });
      await t.run(s.id, 'go');
      expect(t.requestProviders).toEqual([]);
      expect(t.engine.getSession(s.id)!.model).toBe('glm/glm-5.3');
      const text = t.engine
        .getMessages(s.id)
        .flatMap((m: Message) => m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text))
        .join('\n');
      expect(text).toContain('models.hidden');
    } finally {
      await t.close();
    }
  }, 30_000);
});
