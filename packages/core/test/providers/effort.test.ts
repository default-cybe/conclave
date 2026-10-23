/**
 * Effort levels per model (providers/effort.ts): Claude's table from
 * Anthropic's docs, the levels other wires take, clamping a stored level to
 * one the model has, and the levels on the hub's model list.
 *
 *   bun test packages/core/test/providers/effort.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { clampEffort, claudeEffort, claudeThinkingOff, effortChoices, effortLabel, isEffortSetting, modelEffort, type ModelEffort } from '../../src/providers/effort';
import { ProviderRegistry, effortWire } from '../../src/providers/registry';

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

describe('Claude', () => {
  test('levels, Off and default per model', () => {
    for (const m of ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
      expect(claudeEffort(m)?.levels).toEqual(ALL as never);
    }
    expect(claudeEffort('claude-opus-4-6')).toEqual({ levels: ['low', 'medium', 'high', 'max'], off: true, default: 'high' });
    expect(claudeEffort('claude-sonnet-4-6-20260101')?.levels).not.toContain('xhigh');
    expect(claudeEffort('claude-haiku-4-5')).toBeUndefined();
    expect(claudeEffort('claude-sonnet-4-5')).toBeUndefined();
    // defaults: high on most, medium on Opus 5.5 and Haiku 5.5
    expect(claudeEffort('claude-opus-5-5')?.default).toBe('medium');
    expect(claudeEffort('claude-haiku-5-5')?.default).toBe('medium');
    expect(claudeEffort('claude-sonnet-5-5')?.default).toBe('high');
    expect(claudeEffort('claude-opus-4-8')?.default).toBe('high');
    // Opus 5.5 and Fable cannot turn thinking off
    expect(claudeEffort('claude-opus-5-5')?.off).toBe(false);
    expect(claudeEffort('claude-fable-5')?.off).toBe(false);
    expect(claudeEffort('claude-sonnet-5-5')?.off).toBe(true);
  });

  test('how Off is sent', () => {
    expect(claudeThinkingOff('claude-opus-5-5')).toBeUndefined();
    expect(claudeThinkingOff('claude-fable-5-1')).toBeUndefined();
    expect(claudeThinkingOff('claude-sonnet-5-5')).toBe('between_tools');
    expect(claudeThinkingOff('claude-opus-5')).toBe('disabled');
    expect(claudeThinkingOff('claude-haiku-5-5')).toBe('disabled');
    expect(claudeThinkingOff('anthropic/claude-opus-4-7')).toBe('disabled');
    expect(claudeThinkingOff('claude-opus-4-6')).toBe('omit');
  });
});

describe('other wires', () => {
  test('only levels the adapter can send', () => {
    expect(modelEffort('gpt-5', true, 'openai')).toEqual({ levels: ['low', 'medium', 'high'], off: false });
    expect(modelEffort('gpt-5.5', true, 'openai')?.levels).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(modelEffort('gpt-5.1-codex-max', true, 'openai')?.levels).toContain('xhigh');
    expect(modelEffort('gpt-5.6', true, 'openai')?.levels).not.toContain('max');
    expect(modelEffort('gemini-3.1-pro-preview', true, 'gemini')?.levels).toEqual(['low', 'high']);
    expect(modelEffort('gemini-3.5-flash', true, 'gemini')?.levels).toEqual(['low', 'medium', 'high']);
    expect(modelEffort('glm-5', true, 'switch')).toEqual({ levels: ['high'], off: true });
    expect(modelEffort('glm-5', true, 'anthropic')).toEqual({ levels: ['low', 'medium', 'high'], off: true, default: 'off' });
    expect(modelEffort('claude-opus-5-5', true, 'anthropic')?.levels).toEqual(ALL as never);
    // no thinking, or a harness (its levels come from the harness): nothing
    expect(modelEffort('gpt-4.1', false, 'openai')).toBeUndefined();
    expect(modelEffort('opus', true, 'harness')).toBeUndefined();
  });

  test('effortWire reads the provider config', () => {
    expect(effortWire({ type: 'anthropic' }, 'claude-opus-5-5')).toBe('anthropic');
    expect(effortWire({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, 'anthropic/claude-opus-5-5')).toBe('openrouter');
    expect(effortWire({ type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4' }, 'glm-5')).toBe('switch');
    expect(effortWire({ type: 'openai', baseUrl: 'http://127.0.0.1:8317/v1', anthropicWire: { baseUrl: 'http://127.0.0.1:8317', models: ['claude-*'] } }, 'claude-sonnet-5-5')).toBe('anthropic');
    expect(effortWire({ type: 'openai', baseUrl: 'http://127.0.0.1:8317/v1', anthropicWire: { baseUrl: 'http://127.0.0.1:8317', models: ['claude-*'] } }, 'gpt-5.5')).toBe('openai');
    expect(effortWire({ type: 'acp', command: 'x' }, 'opus')).toBe('harness');
  });
});

describe('clamping and words', () => {
  const opus46 = claudeEffort('claude-opus-4-6')!;
  const opus55 = claudeEffort('claude-opus-5-5')!;
  const gpt5: ModelEffort = { levels: ['low', 'medium', 'high'], off: false };

  test('a level the model lacks goes to the nearest one, the lower on a tie', () => {
    expect(clampEffort('xhigh', opus46)).toBe('high');
    expect(clampEffort('max', opus46)).toBe('max');
    expect(clampEffort('max', gpt5)).toBe('high');
    expect(clampEffort('medium', { levels: ['low', 'high'], off: false })).toBe('low');
    // Off where thinking cannot stop is the lowest level
    expect(clampEffort('off', opus55)).toBe('low');
    expect(clampEffort('off', opus46)).toBe('off');
    // unset stays unset; no effort control means nothing to send
    expect(clampEffort(undefined, opus55)).toBeUndefined();
    expect(clampEffort('high', undefined)).toBeUndefined();
  });

  test('choices and labels', () => {
    expect(effortChoices(opus55)).toEqual(ALL as never);
    expect(effortChoices(opus46)).toEqual(['off', 'low', 'medium', 'high', 'max']);
    expect(effortChoices(undefined)).toEqual([]);
    expect(effortLabel('xhigh')).toBe('Extra high');
    expect(effortLabel('off')).toBe('Off');
    expect(effortLabel('high', { levels: ['high'], off: true })).toBe('On');
    expect(isEffortSetting('max')).toBe(true);
    expect(isEffortSetting('ultra')).toBe(false);
    // plain words: no dashes in any label
    for (const s of ['off', ...ALL] as const) expect(effortLabel(s)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('the model list', () => {
  test('models carry their levels; harness models only after the harness said', async () => {
    const config = new ConfigStore(mkdtempSync(join(tmpdir(), 'conclave-effort-')));
    config.update({
      providers: {
        anthropic: { type: 'anthropic', apiKey: 'k', models: ['claude-opus-5-5', 'claude-opus-4-6', 'claude-haiku-4-5'] },
        'claude-code': { type: 'acp', command: 'definitely-not-installed-xyz', models: ['opus', 'default'] },
      },
    } as never);
    const r = new ProviderRegistry(config);
    r.setHarnessEffort((ref) => (ref === 'claude-code/opus' ? ['low', 'medium', 'high', 'xhigh', 'max'] : undefined));
    const groups = await r.groups();
    const models = Object.fromEntries(groups.flatMap((g) => g.models).map((m) => [m.ref, m]));
    expect(models['anthropic/claude-opus-5-5'].effort).toEqual({ levels: ALL as never, off: false, default: 'medium' });
    expect(models['anthropic/claude-opus-4-6'].effort?.levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(models['anthropic/claude-haiku-4-5'].effort).toBeUndefined();
    expect(models['claude-code/opus'].effort).toEqual({ levels: ALL as never, off: false });
    expect(models['claude-code/default'].effort).toBeUndefined();
    // a resolved model has them too (engine.thinkingFor reads it)
    expect(r.resolve('anthropic/claude-opus-4-6').info.effort?.levels).not.toContain('xhigh');
    r.dispose();
  });
});
