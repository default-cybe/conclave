/**
 * Accounts on a real engine: two signed in Claude plans behind a fake
 * CLIProxyAPI and an API key behind a fake Anthropic API. The plan goes
 * first, a 429 on it moves the call to the key in the same turn, the key's
 * budget stops it, and every usage row says which account, device and folder.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import { accountsOf } from '../../src/accounts/attached';
import type { CliproxyCredentialFacts } from '../../src/accounts/service';
import { streamCompletion } from '../../src/session/stream';
import { ProviderError } from '../../src/providers/types';

function sse(text: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let plan: 'ok' | 'limited' = 'ok';
let api: 'ok' | 'capped' = 'ok';
const planCalls: Array<{ session: string | null }> = [];
const apiCalls: number[] = [];

const cpa = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text();
    planCalls.push({ session: req.headers.get('x-session-id') });
    if (plan === 'limited') {
      return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'all credentials are limited' } }, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 7200) });
    }
    return sse('from the plan');
  },
});
const anthropic = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text();
    apiCalls.push(Date.now());
    if (api === 'capped') return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Your organization has reached its monthly spend limit.', details: { error_code: 'enforced_spend_limit_reached' } } });
    return sse('from the key');
  },
});

const cred = (name: string, email: string, extra: Partial<CliproxyCredentialFacts> = {}): CliproxyCredentialFacts => ({ name, provider: 'claude', email, disabled: false, windows: [], cooldowns: [], models: [{ id: 'claude-sonnet-5-5' }], authIndex: name, ...extra });

let engine: Engine;
let home: string;
let cwd: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-acct-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'conclave-acct-cwd-'));
  engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'anthropic/claude-sonnet-5-5',
      smallModel: 'anthropic/claude-sonnet-5-5',
      providers: {
        anthropic: { type: 'anthropic', baseUrl: `http://127.0.0.1:${anthropic.port}`, apiKey: 'test-key-not-real', models: ['claude-sonnet-5-5'] },
        cliproxy: {
          type: 'openai',
          baseUrl: `http://127.0.0.1:${cpa.port}/v1`,
          apiKey: 'test-client-key',
          enabled: true,
          models: ['claude-sonnet-5-5'],
          anthropicWire: { baseUrl: `http://127.0.0.1:${cpa.port}`, models: ['claude-*'] },
          subscription: 'cliproxy',
          sessionHeader: 'X-Session-ID',
        },
      },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
      limits: { maxRetries: 0, autoResume: false, fallbacks: {}, resumePrompt: 'go on' },
    } as never,
  });
  // the fake API is not api.anthropic.com, so the hub would not find it as Claude's key by itself: name it
  engine.config.update({ models: { accounts: [{ id: 'api-anthropic', vendor: 'anthropic', kind: 'api', provider: 'anthropic' }] } } as never);
  accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() - 1000, credentials: [cred('claude-one.json', 'one@example.test'), cred('claude-two.json', 'two@example.test')] });
});

afterAll(async () => {
  await engine.shutdown();
  cpa.stop(true);
  anthropic.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

async function turn(sessionId: string, text: string) {
  const runner = engine.runnerFor(sessionId);
  await runner.enqueue({ text });
  await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
}

describe('accounts on the engine', () => {
  test('the order: both plans, then the key; the registry sends anthropic/ refs to the plan', () => {
    const st = accountsOf(engine)!.status();
    expect(st.accounts.map((a) => [a.id, a.kind, a.label])).toEqual([
      ['api-anthropic', 'api', 'Claude API key'],
      ['claude-one', 'subscription', 'one@example.test'],
      ['claude-two', 'subscription', 'two@example.test'],
    ]);
    expect(st.routes).toEqual([{ vendor: 'anthropic', vendorName: 'Claude', order: ['claude-one', 'claude-two', 'api-anthropic'] }]);
    expect(st.now[0]).toMatchObject({ vendor: 'anthropic', account: 'claude-one', skipped: [] });
    expect(engine.providers.resolve('anthropic/claude-sonnet-5-5').provider).toBe('cliproxy');
    expect(engine.providers.resolve('sonnet').provider).toBe('cliproxy');
    expect(engine.providers.resolve('claude-sonnet-5-5').provider).toBe('cliproxy');
    // the priorities CLIProxyAPI gets: the first plan highest
    expect([...accountsOf(engine)!.credentialPriorities()]).toEqual([
      ['claude-one.json', 2],
      ['claude-two.json', 1],
    ]);
  });

  test('a turn goes to the plan with its session id, and the usage row names the account, device and folder', async () => {
    const s = await engine.createSession({ cwd, title: 't1' });
    await turn(s.id, 'hello');
    const turnCall = planCalls.find((c) => c.session === s.id);
    expect(turnCall).toBeDefined();
    const rows = engine.repos.usage.recent(10, { sessionId: s.id });
    const main = rows.find((r) => r.purpose === 'turn')!;
    expect(main).toMatchObject({ provider: 'cliproxy', account: 'claude-one', device: 'local', cwd: s.cwd, costUsd: 0 });
    // one turns row, closed, with the account of its last call
    const turns = engine.repos.turns.list({ sessionId: s.id });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ sessionId: s.id, model: s.model, account: 'claude-one', tools: 0, outcome: 'done' });
    expect(turns[0].endedAt).toBeGreaterThanOrEqual(turns[0].startedAt);
  });

  test('both plans refuse: the same turn moves to the API key, says so, and the next resolve goes there', async () => {
    plan = 'limited';
    const s = await engine.createSession({ cwd, title: 't2' });
    const before = apiCalls.length;
    await turn(s.id, 'hello again');
    expect(apiCalls.length).toBeGreaterThan(before);
    const rows = engine.repos.usage.recent(10, { sessionId: s.id });
    expect(rows.find((r) => r.purpose === 'turn')).toMatchObject({ provider: 'anthropic', account: 'api-anthropic' });
    const notes = engine.repos.messages.list(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
    expect(notes.some((n) => n.includes('Your signed in plans are at their limit'))).toBe(true);
    expect(engine.providers.resolve('anthropic/claude-sonnet-5-5').provider).toBe('anthropic');
    const st = accountsOf(engine)!.status();
    expect(st.accounts.find((a) => a.id === 'claude-one')?.state).toBe('limited');
    expect(st.now[0]).toMatchObject({ account: 'api-anthropic' });
    expect(st.now[0].skipped.map((x) => x.account)).toEqual(['claude-one', 'claude-two']);
  });

  test("the key's budget: a window from Conclave's own costs; at 100% with hard stop the call stops", async () => {
    const acc = accountsOf(engine)!;
    acc.patch('api-anthropic', { budget: { usd: 0.0001, period: 'month', resetDay: 22, tz: 'UTC' } });
    // the turn above spent more than that on the key
    const a = acc.account('api-anthropic')!;
    expect(a.budget).toMatchObject({ usd: 0.0001, period: 'month', resetDay: 22 });
    expect(a.budget!.spentUsd).toBeGreaterThan(0.0001);
    expect(a.windows.find((w) => w.name === 'budget')).toMatchObject({ kind: 'budget', usedPercent: 100, source: 'ledger' });
    expect(a.state).toBe('budget');
    // with every account blocked the first in the order is tried, so its error (and its reset) is the one shown
    expect(engine.providers.resolve('anthropic/claude-sonnet-5-5').provider).toBe('cliproxy');
    // with the plans paused only the key is left: its budget stops the call before it is sent
    acc.patch('claude-one', { enabled: false });
    acc.patch('claude-two', { enabled: false });
    const sent = apiCalls.length;
    const err = await streamCompletion(engine, 'anthropic/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'quota', code: 'budget' });
    expect(err.message).toContain('has spent its $0.0001 budget');
    expect(err.resetAt).toBe(a.budget!.periodEnd);
    expect(apiCalls.length).toBe(sent);
    acc.patch('claude-one', { enabled: true });
    acc.patch('claude-two', { enabled: true });
    acc.patch('api-anthropic', { budget: null });
    // the owner's changes are saved in models.accounts, every account with its id
    const saved = (engine.config.getUser() as any).models.accounts;
    expect(saved.map((x: { id: string }) => x.id)).toEqual(['api-anthropic', 'claude-one', 'claude-two']);
    expect(saved.find((x: { id: string }) => x.id === 'claude-one')).toEqual({ id: 'claude-one', vendor: 'anthropic', kind: 'subscription', credential: 'claude-one.json' });
  });

  test('the key hits its spend cap while a plan has room again: the call goes back to the plan', async () => {
    plan = 'ok';
    api = 'capped';
    const acc = accountsOf(engine)!;
    // a fresh read of the credentials clears the block the 429 left
    acc.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() + 1, credentials: [cred('claude-one.json', 'one@example.test'), cred('claude-two.json', 'two@example.test')] });
    const r = await streamCompletion(engine, 'anthropic/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test' });
    expect(r.content).toEqual([{ type: 'text', text: 'from the plan' }]);
    api = 'ok';
  });

  test('approvals keep when they were asked and answered', async () => {
    const s = await engine.createSession({ cwd, title: 't3' });
    const ac = new AbortController();
    const p = engine.requestApproval(s.id, { toolUseId: 'tu1', tool: 'Bash', input: { command: 'ls' }, summary: 'Run: ls' }, ac.signal);
    const pending = engine.pendingApprovals().find((x) => x.sessionId === s.id)!;
    await Bun.sleep(5);
    engine.resolveApproval(pending.id, { decision: 'allow', scope: 'once' });
    await p;
    const log = engine.repos.approvals.list().find((x) => x.id === pending.id)!;
    expect(log).toMatchObject({ sessionId: s.id, tool: 'Bash', decision: 'allow' });
    expect(log.resolvedAt! - log.requestedAt).toBeGreaterThanOrEqual(0);
  });
});
