import { describe, expect, test } from 'bun:test';
import { parseRefusalEntries, refusalEntryText, refusalFallbackField } from '../../src/session/refusal-entries';
import { refusalPlan, shortModelName } from '../../src/session/refusal-fallback';
import { DEFAULT_CONFIG, type ConclaveConfig } from '../../src/config/schema';

const cfg = (refusalFallback?: NonNullable<ConclaveConfig['models']>['refusalFallback']): ConclaveConfig => ({ ...DEFAULT_CONFIG, models: { refusalFallback } });

describe('refusal fallback list', () => {
  test('entries from config objects and frontmatter strings; bad ones and repeats dropped', () => {
    expect(
      parseRefusalEntries([
        { model: 'cliproxy/claude-opus-5-5', account: 'neu' },
        'anthropic/claude-opus-5-5@personal',
        'zai/glm-5.3',
        'zai/glm-5.3',
        '@reviewer',
        { model: '' },
        42,
      ]),
    ).toEqual([{ model: 'cliproxy/claude-opus-5-5', account: 'neu' }, { model: 'anthropic/claude-opus-5-5', account: 'personal' }, { model: 'zai/glm-5.3' }]);
    expect(refusalEntryText({ model: 'a/b', account: 'x' })).toBe('a/b@x');
    expect(refusalFallbackField('off')).toBe(false);
    expect(refusalFallbackField(false)).toBe(false);
    expect(refusalFallbackField(['zai/glm-5.3'])).toEqual([{ model: 'zai/glm-5.3' }]);
    expect(refusalFallbackField(undefined)).toBeUndefined();
  });

  test('the plan: off and empty by default; on only when the owner says so; an agent list replaces and turns it on', () => {
    expect(refusalPlan(DEFAULT_CONFIG)).toBeUndefined();
    expect(refusalPlan(cfg({ enabled: true, entries: [] }))).toBeUndefined();
    const list = [{ model: 'zai/glm-5.3' }];
    expect(refusalPlan(cfg({ entries: list }))).toMatchObject({ auto: false, stay: false, source: 'config' });
    expect(refusalPlan(cfg({ enabled: true, stay: true, entries: list }))).toMatchObject({ auto: true, stay: true });
    expect(refusalPlan(cfg({ enabled: true, entries: list }), { refusalFallback: false })).toBeUndefined();
    expect(refusalPlan(cfg(undefined), { refusalFallback: [{ model: 'openai/gpt-5.5' }] })).toMatchObject({ auto: true, source: 'agent', entries: [{ model: 'openai/gpt-5.5' }] });
  });

  test('short names drop the maker', () => {
    expect(shortModelName('Claude Opus 5.5')).toBe('Opus 5.5');
    expect(shortModelName('GLM-5.3')).toBe('GLM-5.3');
  });
});
