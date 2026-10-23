import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { AccountsService, checkBudget, type CliproxyCredentialFacts } from '../../src/accounts/service';
import { UsageService } from '../../src/usage/service';
import type { EngineEventEnvelope } from '../../src/types';
import { TestMachine } from '../acp/test-machine';
import { IDS, fixtureHome } from '../importers/fixture-home';

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const H = 3_600_000;

function setup(now: { t: number }) {
  const home = mkdtempSync(join(tmpdir(), 'conclave-acct-svc-'));
  homes.push(home);
  const config = new ConfigStore(home);
  // a key for Anthropic (a made up one: nothing is called) makes the API account
  config.setSecret('providers', 'anthropic', 'test-key-not-real');
  const repos = new Repos(openDb(':memory:'));
  const bus = new EventBus();
  const events: EngineEventEnvelope[] = [];
  bus.on((e) => events.push(e));
  const notes: Array<{ title: string; body: string }> = [];
  const svc = new AccountsService({ config, repos, bus, now: () => now.t, notify: (title, body) => notes.push({ title, body }) });
  return { config, repos, bus, events, notes, svc };
}

const cred = (name: string, extra: Partial<CliproxyCredentialFacts> = {}): CliproxyCredentialFacts => ({ name, provider: 'claude', disabled: false, windows: [], cooldowns: [], ...extra });

describe('the accounts service', () => {
  test('a session stays on its account until that account is blocked, like CLIProxyAPI session affinity', () => {
    const now = { t: Date.parse('2026-10-19T09:00:00Z') };
    const { svc } = setup(now);
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json', { email: 'a@example.test' }), cred('claude-b.json', { email: 'b@example.test' })] });
    expect(svc.accountFor('cliproxy', 'claude-opus-5-5', 's1')).toBe('claude-a');
    // Account 1 fills its 5 hours: s1 moves to Account 2, as CLIProxyAPI rebinds on quota
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json', { windows: [{ name: '5h', usedPercent: 100, resetsAt: now.t + H }] }), cred('claude-b.json')] });
    expect(svc.accountFor('cliproxy', 'claude-opus-5-5', 's1')).toBe('claude-b');
    // Account 1 resets: s1 keeps Account 2 (its cache is there), a new session starts on Account 1
    now.t += 2 * H;
    expect(svc.accountFor('cliproxy', 'claude-opus-5-5', 's1')).toBe('claude-b');
    expect(svc.accountFor('cliproxy', 'claude-opus-5-5', 's2')).toBe('claude-a');
    // the API key's calls are its own account; a prefix names one account
    expect(svc.accountFor('anthropic', 'claude-opus-5-5', 's1')).toBe('api-anthropic');
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json'), cred('claude-b.json', { prefix: 'neu' })] });
    expect(svc.accountFor('cliproxy', 'neu/claude-opus-5-5')).toBe('claude-b');
    expect(svc.accountFor('openrouter', 'anthropic/claude-opus-5-5')).toBeUndefined();
  });

  test('per-account limit states replace the gateway shared one, and an event says what changed', async () => {
    const now = { t: Date.now() };
    const { svc, repos, events } = setup(now);
    repos.usage.setLimit({ provider: 'cliproxy', label: 'CLIProxyAPI', windows: [{ name: '5h', usedPercent: 50 }], updatedAt: 1, source: 'headers' });
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json', { windows: [{ name: '5h', usedPercent: 30, resetsAt: now.t + H }], plan: 'Max 20x', email: 'a@example.test' })] });
    svc.publish();
    const keys = repos.usage.limits().map((l) => `${l.provider}:${l.account ?? ''}`);
    expect(keys).toEqual(['cliproxy:claude-a']);
    expect(repos.usage.limits()[0]).toMatchObject({ label: 'Claude Max 20x · a@example.test', blocked: false, windows: [{ name: '5h', usedPercent: 30, kind: 'session' }] });
    expect(events.some((e) => e.type === 'accounts.updated')).toBe(true);
    expect(events.some((e) => e.type === 'limit.updated' && e.limit.account === 'claude-a')).toBe(true);
    // the account signs out: its state goes too
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [] });
    svc.publish();
    expect(repos.usage.limits()).toEqual([]);
  });

  test("the budget warns once at warnAt and once when spent, from the usage rows' cost", async () => {
    const now = { t: Date.parse('2026-10-20T12:00:00Z') };
    const { svc, repos, bus, notes } = setup(now);
    svc.patch('api-anthropic', { budget: { usd: 10, period: 'month', resetDay: 22, tz: 'UTC', warnAt: 50 } });
    const usage = new UsageService({ repos, bus, priceOf: () => 0 });
    const spend = (usd: number) => usage.record({ source: 'api', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: usd, account: 'api-anthropic', ts: now.t });
    spend(3);
    expect(notes).toEqual([]);
    spend(3);
    expect(notes.map((n) => n.title)).toEqual(['Claude API key: 60% of the budget used']);
    spend(1);
    expect(notes).toHaveLength(1);
    spend(4);
    expect(notes.map((n) => n.title)).toEqual(['Claude API key: 60% of the budget used', 'Claude API key: budget spent']);
    expect(notes[1].body).toContain('Calls on it stop');
    expect(svc.budgetStop('anthropic')).toMatchObject({ account: 'api-anthropic', usd: 10, until: Date.parse('2026-10-22T00:00:00Z') });
    // spend before the period started does not count
    usage.record({ source: 'api', provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 500, account: 'api-anthropic', ts: Date.parse('2026-09-21T23:59:00Z') });
    expect(svc.account('api-anthropic')!.budget!.spentUsd).toBe(11);
    // on the 22nd a new period starts
    now.t = Date.parse('2026-10-22T00:00:01Z');
    expect(svc.budgetStop('anthropic')).toBeUndefined();
    expect(svc.account('api-anthropic')!.budget).toMatchObject({ spentUsd: 0, periodStart: Date.parse('2026-10-22T00:00:00Z'), periodEnd: Date.parse('2026-11-22T00:00:00Z') });
  });

  test('the order is saved, checked, and gives CLIProxyAPI priorities', () => {
    const now = { t: Date.now() };
    const { svc, config } = setup(now);
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json'), cred('claude-b.json'), cred('codex-c.json', { provider: 'codex' })] });
    expect(svc.status().routes.map((r) => [r.vendor, r.order])).toEqual([
      ['anthropic', ['claude-a', 'claude-b', 'api-anthropic']],
      ['openai', ['codex-c']],
    ]);
    svc.setOrder({ vendor: 'anthropic', order: ['claude-b', 'api-anthropic', 'claude-a'] });
    expect((config.getUser() as any).models.routes).toEqual([{ vendor: 'anthropic', order: ['claude-b', 'api-anthropic', 'claude-a'] }]);
    expect([...svc.credentialPriorities()]).toEqual([
      ['claude-b.json', 2],
      ['claude-a.json', 1],
      ['codex-c.json', 1],
    ]);
    expect(() => svc.setOrder({ vendor: 'anthropic', order: ['codex-c'] })).toThrow(/Not an account of Claude/);
    expect(() => svc.setOrder({ vendor: 'zai', order: [] })).toThrow(/No accounts/);
    expect(() => svc.patch('nobody', { label: 'x' })).toThrow(/not here/);
    expect(() => svc.patch('claude-a', { budget: { usd: 5 } })).toThrow(/Budgets are for API keys/);
    svc.patch('claude-a', { label: 'Account 1' });
    expect(svc.account('claude-a')!.label).toBe('Account 1');
  });

  test('budgets are checked before they are saved', () => {
    expect(checkBudget({ usd: '25', resetDay: 22, tz: 'Europe/Berlin', hardStop: false })).toEqual({ usd: 25, period: 'month', resetDay: 22, tz: 'Europe/Berlin', hardStop: false });
    expect(checkBudget({ usd: 5, period: 'week', resetDay: 2, resetHour: 10 })).toEqual({ usd: 5, period: 'week', resetDay: 2, resetHour: 10 });
    expect(() => checkBudget({ usd: 0 })).toThrow(/more than \$0/);
    expect(() => checkBudget({ usd: 5, resetDay: 32 })).toThrow(/resetDay/);
    expect(() => checkBudget({ usd: 5, period: 'week', resetDay: 7 })).toThrow(/resetDay/);
    expect(() => checkBudget({ usd: 5, tz: 'Mars/Olympus' })).toThrow(/not a time zone/);
    expect(() => checkBudget({ usd: 5, period: 'year' })).toThrow(/period/);
  });
});

describe('ACP and log usage are not counted twice', () => {
  test("a harness session's lines inside a turn Conclave counted over ACP are skipped; other lines are read", async () => {
    const run = async (mark: boolean) => {
      const repos = new Repos(openDb(':memory:'));
      const usage = new UsageService({ repos, bus: new EventBus(), priceOf: () => 0 });
      if (mark) {
        // the ACP turn that ran Claude Code session A and Codex session C, and recorded their usage then
        const t = repos.turns.start({ sessionId: 'ses_1', startedAt: Date.parse('2025-10-01T09:59:00Z') });
        repos.turns.setHarnessSession(t, IDS.claudeA);
        repos.turns.end(t, { endedAt: Date.parse('2025-10-01T10:05:00Z') });
        const c = repos.turns.start({ sessionId: 'ses_2', startedAt: Date.parse('2025-10-02T07:59:00Z') });
        repos.turns.setHarnessSession(c, IDS.codexC);
        repos.turns.end(c, { endedAt: Date.parse('2025-10-02T08:02:00Z') });
      }
      const machine = new TestMachine({ id: 'pc', home: fixtureHome() });
      const r = await usage.refresh([machine]);
      return { imported: r.imported, rows: repos.usage.recent(100) };
    };
    const all = await run(false);
    const skipped = await run(true);
    expect(all.imported).toBe(8);
    // session A's three calls (one a sidechain) and session C's three are left to the ACP rows; session B's two are read
    expect(skipped.imported).toBe(2);
    expect(skipped.rows.map((r) => r.ts).sort()).toEqual([Date.parse('2025-10-03T12:00:02.000Z'), Date.parse('2025-10-03T12:00:03.000Z')]);
    expect(skipped.rows.every((r) => r.device === 'pc')).toBe(true);
    expect(all.rows.filter((r) => r.source === 'claude-code').every((r) => typeof r.cwd === 'string')).toBe(true);
  });
});
