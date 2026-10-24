import { describe, expect, test } from 'bun:test';
import { parseRefusalEntries, refusalEntryText, refusalFallbackField } from '../../src/session/refusal-entries';
import { refusalPlan, shortModelName, targetFor } from '../../src/session/refusal-fallback';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { AccountsService } from '../../src/accounts/service';
import { setAccounts } from '../../src/accounts/attached';
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

  test("an entry pinned to a plan that lists only a variant asks for the plan's own id (Antigravity: claude-opus-5-5-high)", () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-refusal-variant-'));
    try {
      const svc = new AccountsService({ config: new ConfigStore(home), repos: new Repos(openDb(':memory:')), bus: new EventBus() });
      svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [{ name: 'antigravity-g.json', provider: 'antigravity', prefix: 'backup-gemini', disabled: false, windows: [], cooldowns: [], models: [{ id: 'claude-opus-5-5-high' }] }] });
      const engine = {};
      setAccounts(engine, svc);
      const t = targetFor(engine as never, { model: 'cliproxy/claude-opus-5-5', account: 'antigravity-g' }, 0);
      expect(t).toMatchObject({ ref: 'cliproxy/backup-gemini/claude-opus-5-5-high', pin: { provider: 'cliproxy', model: 'backup-gemini/claude-opus-5-5-high', account: 'antigravity-g' } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('short names drop the maker', () => {
    expect(shortModelName('Claude Opus 5.5')).toBe('Opus 5.5');
    expect(shortModelName('GLM-5.3')).toBe('GLM-5.3');
  });
});
