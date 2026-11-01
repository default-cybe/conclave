/**
 * Claude Code, Codex, Gemini CLI and OpenCode as engines are off by default
 * (acp/harness-off.ts): the default config, the one time upgrade step that
 * keeps the ones a hub set by hand or used lately, and sessions that are
 * refused with words that say where to turn the harness on.
 *
 *   bun test packages/core/test/acp/harness-off.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { ConfigStore } from '../../src/config';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { BUILTIN_HARNESSES, HARNESSES_OFF_KEY, harnessOffWords, harnessesOffOnce } from '../../src/acp/harness-off';
import { createEngine } from '../../src/engine';
import { EngineError } from '../../src/engine/errors';
import { cleanup, tempDir } from '../extensions/_helpers';

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 12);

/** A hub home as an older release left it: its config.json, its database. */
function oldHub(config: Record<string, unknown> = {}) {
  const home = tempDir('conclave-harness-off-');
  dirs.push(home);
  const store = new ConfigStore(home);
  if (Object.keys(config).length) store.update(config as never);
  const db = openDb(store.paths.db);
  const repos = new Repos(db);
  return { store, db, repos };
}

function turnOn(repos: Repos, model: string, at: number) {
  repos.turns.start({ sessionId: 'ses_old', model, startedAt: at });
}

describe('the default', () => {
  test('the four harnesses are off; a harness the owner added is not', () => {
    const { store } = oldHub({ providers: { cursor: { type: 'acp', command: 'cursor-agent' } } });
    const p = store.get().providers;
    for (const id of BUILTIN_HARNESSES) expect(p[id]).toMatchObject({ type: 'acp', enabled: false });
    expect(p.cursor.enabled).toBeUndefined();
  });

  test('the words say which harness and where to turn it on', () => {
    expect(harnessOffWords('claude-code', { type: 'acp', name: 'Claude Code', enabled: false })).toBe('Claude Code is off as an engine. Turn it on in Settings, Providers, or pick another model for this session.');
    expect(harnessOffWords('codex', { type: 'acp', enabled: true })).toBeUndefined();
    expect(harnessOffWords('anthropic', { type: 'anthropic', enabled: false })).toBeUndefined();
    expect(harnessOffWords('gone', undefined)).toBeUndefined();
  });
});

describe('the upgrade step', () => {
  test('a hub that never ran a harness: all stay off, and the step runs once', () => {
    const { store, db, repos } = oldHub();
    expect(harnessesOffOnce({ config: store, db, kv: repos.kv, now: NOW })).toEqual([]);
    expect(repos.kv.get<unknown>(HARNESSES_OFF_KEY, null)).toEqual({ at: NOW, kept: [] });
    expect(harnessesOffOnce({ config: store, db, kv: repos.kv, now: NOW })).toBeUndefined();
    expect(store.getUser().providers).toBeUndefined();
  });

  test('a turn on Claude Code 3 days ago and a Codex usage row keep those two on; a turn 40 days ago does not', () => {
    const { store, db, repos } = oldHub();
    turnOn(repos, 'claude-code/opus', NOW - 3 * DAY);
    turnOn(repos, 'gemini-cli/default', NOW - 40 * DAY);
    repos.usage.insert({ id: 'u1', ts: NOW - DAY, sessionId: 'ses_x', source: 'codex', provider: 'codex', model: 'gpt-5.5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 });
    // Codex's own log lines (no session of the hub's) and a model named like a harness elsewhere do not count
    repos.usage.insert({ id: 'u2', ts: NOW - DAY, source: 'opencode', provider: 'opencode', model: 'glm-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 });
    turnOn(repos, 'openrouter/claude-code/x', NOW - DAY);
    expect(harnessesOffOnce({ config: store, db, kv: repos.kv, now: NOW })).toEqual(['claude-code', 'codex']);
    const p = store.get().providers;
    expect([p['claude-code'].enabled, p.codex.enabled, p['gemini-cli'].enabled, p.opencode.enabled]).toEqual([true, true, false, false]);
    // only the switch is written: the command and models still come from the defaults
    expect(store.getUser().providers as unknown).toEqual({ 'claude-code': { enabled: true }, codex: { enabled: true } });
  });

  test("the owner's own setting stands: on by hand stays on, off by hand stays off even when used", () => {
    const { store, db, repos } = oldHub({ providers: { 'gemini-cli': { enabled: true }, 'claude-code': { enabled: false } } });
    turnOn(repos, 'claude-code/opus', NOW - DAY);
    expect(harnessesOffOnce({ config: store, db, kv: repos.kv, now: NOW })).toEqual([]);
    const p = store.get().providers;
    expect(p['gemini-cli'].enabled).toBe(true);
    expect(p['claude-code'].enabled).toBe(false);
  });

  test('an imported chat does not count: it has a harness model but no turn or usage of its own', () => {
    const { store, db, repos } = oldHub();
    repos.sessions.insert({ id: 'ses_imp', title: 'imported', agent: 'coder', model: 'claude-code/default', mode: 'agent', permissionMode: 'default', cwd: '~', device: 'local', status: 'idle', tags: [], pinned: false, archived: true, createdAt: NOW - DAY, updatedAt: NOW - DAY, stats: { messages: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } } as never);
    expect(harnessesOffOnce({ config: store, db, kv: repos.kv, now: NOW })).toEqual([]);
  });

  test('a harness turned off after the step stays off on the next start', () => {
    const { store, db, repos } = oldHub();
    turnOn(repos, 'codex/default', NOW - DAY);
    expect(harnessesOffOnce({ config: store, db, kv: repos.kv, now: NOW })).toEqual(['codex']);
    store.update({ providers: { codex: { enabled: false } } } as never);
    expect(harnessesOffOnce({ config: store, db, kv: repos.kv, now: NOW + DAY })).toBeUndefined();
    expect(store.get().providers.codex.enabled).toBe(false);
  });
});

describe('sessions on a harness that is off', () => {
  test('starting, switching, handoff and the usable check refuse it; turned on, it starts', async () => {
    const home = tempDir('conclave-harness-off-engine-');
    dirs.push(home);
    const engine = await createEngine({ home, noBackground: true, version: 'test', overrides: { memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 } } as never });
    try {
      const words = 'Claude Code is off as an engine. Turn it on in Settings, Providers, or pick another model for this session.';
      const err = await engine.createSession({ model: 'claude-code/opus', title: 'cc' }).catch((e) => e);
      expect(err).toBeInstanceOf(EngineError);
      expect(err).toMatchObject({ status: 400, message: words });
      expect(engine.isUsable('claude-code/opus')).toBe(false);
      const s = await engine.createSession({ title: 'plain' });
      expect(() => engine.updateSession(s.id, { model: 'claude-code/opus' })).toThrow(words);
      // an agent whose profile names the harness is refused the same way
      expect(engine.harnessOff('claude-code/sonnet')).toBe(words);
      expect(engine.harnessOff('anthropic/claude-opus-5-5')).toBeUndefined();
      engine.config.update({ providers: { 'claude-code': { enabled: true } } } as never);
      expect(engine.harnessOff('claude-code/opus')).toBeUndefined();
      const on = await engine.createSession({ model: 'claude-code/opus', title: 'cc on' });
      expect(on.model).toBe('claude-code/opus');
    } finally {
      await engine.shutdown();
    }
  });
});
