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
    // a signed in plan whose vendor reports no usage (Antigravity) still gets a state, saying so
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('antigravity-g.json', { provider: 'antigravity', email: 'g@example.test', models: [{ id: 'gemini-3-flash' }] })] });
    svc.publish();
    expect(repos.usage.limits()).toMatchObject([{ provider: 'cliproxy', account: 'antigravity-g', windows: [], note: 'Usage not reported by Google', blocked: false }]);
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

  test("another vendor's plan that lists the model joins that model's order (Opus on Antigravity)", () => {
    const now = { t: Date.now() };
    const { svc, config } = setup(now);
    const opus = [{ id: 'claude-opus-5-5' }];
    svc.setCliproxy({
      provider: 'cliproxy',
      management: true,
      credentials: [cred('claude-a.json', { models: opus }), cred('antigravity-g.json', { provider: 'antigravity', models: [...opus, { id: 'gemini-3-pro' }], prefix: 'ag' }), cred('gemini-cli-x.json', { provider: 'gemini-cli', models: [{ id: 'gemini-3-pro' }] })],
    });
    const ready = (m: string) => svc.readyAccounts(m).map((a) => a.id);
    // the vendor's own plans first, then the other vendor's plan, then the key; a gemini plan without Opus stays out
    expect(ready('claude-opus-5-5')).toEqual(['claude-a', 'antigravity-g', 'api-anthropic']);
    expect(ready('claude-sonnet-5-5')).toEqual(['api-anthropic']);
    // a per model order may hold it; the vendor's default order may not
    svc.setOrder({ vendor: '', match: 'claude-opus-5-5', order: ['antigravity-g', 'claude-a'] });
    expect((config.getUser() as any).models.routes).toEqual([{ vendor: 'anthropic', match: 'claude-opus-5-5', order: ['antigravity-g', 'claude-a'] }]);
    expect(ready('claude-opus-5-5')).toEqual(['antigravity-g', 'claude-a', 'api-anthropic']);
    expect(svc.status().routes.find((r) => r.match)?.order).toEqual(['antigravity-g', 'claude-a', 'api-anthropic']);
    expect(() => svc.setOrder({ vendor: 'anthropic', order: ['antigravity-g'] })).toThrow(/Not an account of Claude/);
    expect(() => svc.setOrder({ vendor: 'anthropic', match: 'claude-opus-5-5', order: ['gemini-cli-x'] })).toThrow(/Not an account of Claude/);
    // a limit on the prefixed id blocks that plan only; a bare one blocks every plan that lists the model (CLIProxyAPI tried them all)
    svc.noteLimit('cliproxy', 'ag/claude-opus-5-5');
    expect(ready('claude-opus-5-5')).toEqual(['claude-a', 'api-anthropic']);
    svc.clearBlock('antigravity-g');
    svc.noteLimit('cliproxy', 'claude-opus-5-5');
    expect(ready('claude-opus-5-5')).toEqual(['api-anthropic']);
    // only Antigravity's Claude quota: its Gemini models stay ready
    expect(ready('gemini-3-pro')).toEqual(['antigravity-g', 'gemini-cli-x']);
  });

  test("with a saved vendor order, another vendor's plan goes after the saved plans and before the API key", () => {
    const now = { t: Date.now() };
    const { svc } = setup(now);
    const opus = [{ id: 'claude-opus-5-5' }];
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('claude-a.json', { models: opus }), cred('claude-b.json', { models: opus }), cred('antigravity-g.json', { provider: 'antigravity', models: opus, prefix: 'ag' })] });
    const ready = (m: string) => svc.readyAccounts(m).map((a) => a.id);
    svc.setOrder({ vendor: 'anthropic', order: ['claude-b', 'claude-a', 'api-anthropic'] });
    expect(ready('claude-opus-5-5')).toEqual(['claude-b', 'claude-a', 'antigravity-g', 'api-anthropic']);
    // a per model order that lists it keeps its place
    svc.setOrder({ vendor: '', match: 'claude-opus-5-5', order: ['claude-a', 'api-anthropic', 'antigravity-g'] });
    expect(ready('claude-opus-5-5')).toEqual(['claude-a', 'api-anthropic', 'antigravity-g', 'claude-b']);
  });

  test('a vendor with only an API key: the other vendor\'s plan goes first, and the key is next when the plan is blocked or lacks the model', () => {
    const now = { t: Date.now() };
    const { svc } = setup(now);
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('antigravity-g.json', { provider: 'antigravity', models: [{ id: 'claude-opus-5-5' }], prefix: 'ag' })] });
    expect(svc.providersFor('claude-opus-5-5')).toEqual(['cliproxy', 'anthropic']);
    expect(svc.fallbackFor('cliproxy', 'claude-opus-5-5')).toBe('anthropic');
    // blocked: the key goes first, the plan keeps its place in the words
    svc.noteLimit('cliproxy', 'claude-opus-5-5');
    expect(svc.providersFor('claude-opus-5-5')).toEqual(['anthropic', 'cliproxy']);
    expect(svc.fallbackFor('cliproxy', 'claude-opus-5-5')).toBe('anthropic');
    expect(svc.routeOf('claude-opus-5-5')).toEqual([
      { provider: 'cliproxy', kind: 'subscription' },
      { provider: 'anthropic', kind: 'api' },
    ]);
    // a model the plan does not list goes straight to the key, as before
    expect(svc.providersFor('claude-sonnet-5-5')).toBeUndefined();
    expect(svc.routeOf('claude-sonnet-5-5')).toBeUndefined();
    expect(svc.fallbackFor('cliproxy', 'claude-sonnet-5-5')).toBeUndefined();
  });

  test("a plan that lists only an effort or thinking variant joins the model's order (Antigravity's claude-opus-5-5-high)", () => {
    const now = { t: Date.now() };
    const { svc } = setup(now);
    svc.setCliproxy({
      provider: 'cliproxy',
      management: true,
      credentials: [cred('claude-a.json', { models: [{ id: 'claude-opus-5-5' }] }), cred('antigravity-g.json', { provider: 'antigravity', models: [{ id: 'claude-opus-5-5-high' }, { id: 'claude-opus-4-6-thinking' }], prefix: 'backup-gemini' })],
    });
    const ready = (m: string) => svc.readyAccounts(m).map((a) => a.id);
    expect(ready('claude-opus-5-5')).toEqual(['claude-a', 'antigravity-g', 'api-anthropic']);
    expect(ready('claude-opus-4-6')).toEqual(['antigravity-g', 'api-anthropic']);
    svc.setOrder({ vendor: '', match: 'claude-opus-5-5', order: ['antigravity-g', 'claude-a'] });
    expect(svc.status().routes.find((r) => r.match)?.order).toEqual(['antigravity-g', 'claude-a', 'api-anthropic']);
    // a 429 on the bare id did not reach the plan that lists only the variant
    svc.noteLimit('cliproxy', 'claude-opus-5-5');
    expect(ready('claude-opus-5-5')).toEqual(['antigravity-g', 'api-anthropic']);
  });

  test('a per model order for a model no vendor is known for is refused', () => {
    const now = { t: Date.now() };
    const { svc } = setup(now);
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('antigravity-g.json', { provider: 'antigravity', models: [{ id: 'mystery-1' }] })] });
    expect(() => svc.setOrder({ vendor: '', match: 'mystery-1', order: ['antigravity-g'] })).toThrow(/Unknown model mystery-1/);
  });

  test("a limit on another vendor's model blocks only that vendor's models on the plan (Antigravity keeps Claude and Gemini quotas apart)", () => {
    const now = { t: Date.now() };
    const { svc } = setup(now);
    svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('antigravity-g.json', { provider: 'antigravity', models: [{ id: 'claude-opus-5-5' }, { id: 'gemini-3-pro' }], prefix: 'ag' })] });
    const ready = (m: string) => svc.readyAccounts(m).map((a) => a.id);
    svc.noteLimit('cliproxy', 'ag/claude-opus-5-5');
    expect(ready('claude-opus-5-5')).toEqual(['api-anthropic']);
    expect(ready('gemini-3-pro')).toEqual(['antigravity-g']);
    // a limit on the plan's own vendor still blocks the whole plan
    svc.clearBlock('antigravity-g');
    expect(ready('claude-opus-5-5')).toEqual(['antigravity-g', 'api-anthropic']);
    svc.noteLimit('cliproxy', 'ag/gemini-3-pro');
    expect(ready('gemini-3-pro')).toEqual([]);
    expect(ready('claude-opus-5-5')).toEqual(['api-anthropic']);
  });

  test("Antigravity's quota windows: a spent 3p window blocks its Claude and GPT models, a spent Gemini window its Gemini models", () => {
    const now = { t: Date.now() };
    const { svc, repos } = setup(now);
    const models = [{ id: 'claude-opus-5-5' }, { id: 'gpt-6-astra' }, { id: 'gemini-3-pro' }];
    const set = (windows: CliproxyCredentialFacts['windows']) =>
      svc.setCliproxy({ provider: 'cliproxy', management: true, credentials: [cred('antigravity-g.json', { provider: 'antigravity', models, prefix: 'ag', plan: 'AI Pro', windows })] });
    const ready = (m: string) => svc.readyAccounts(m).map((a) => a.id);
    set([{ name: '5h 3p', usedPercent: 100, resetsAt: now.t + H }, { name: '7d gemini', usedPercent: 40, resetsAt: now.t + 50 * H }]);
    expect(ready('claude-opus-5-5')).toEqual(['api-anthropic']);
    expect(ready('gpt-6-astra')).toEqual([]);
    expect(ready('gemini-3-pro')).toEqual(['antigravity-g']);
    // windows to show: the note that Google reports nothing goes away
    svc.publish();
    const l = repos.usage.limits().find((x) => x.account === 'antigravity-g');
    expect(l?.note).toBeUndefined();
    expect(l?.windows.map((w) => w.name)).toEqual(['5h 3p', '7d gemini']);
    set([{ name: '5h 3p', usedPercent: 10, resetsAt: now.t + H }, { name: '7d gemini', usedPercent: 100, resetsAt: now.t + 50 * H }]);
    expect(ready('gemini-3-pro')).toEqual([]);
    expect(ready('claude-opus-5-5')).toEqual(['antigravity-g', 'api-anthropic']);
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
