/**
 * A per-minute rate limit is not the plan's window (providers/errors.ts,
 * session/stream.ts, session/limits.ts). Anthropic's "This request would
 * exceed your account's rate limit" and CLIProxyAPI's "All credentials ...
 * are cooling down" around it retry in place for a few minutes and never
 * park a session for hours. Only a rejected 5h or 7d claim, or the plan's
 * own OAuth usage read, parks; a model's own window (7d fable) parks only
 * that model. Headers below are as Anthropic and CLIProxyAPI v8.0.32 to v8.0.64 send them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import { accountsOf } from '../../src/accounts/attached';
import type { CliproxyCredentialFacts } from '../../src/accounts/service';
import { classifyHttpError } from '../../src/providers/errors';
import { shortLimitTiming, streamCompletion } from '../../src/session/stream';
import { ProviderError } from '../../src/providers/types';
import { SqliteMemory } from '../../src/memory';
import type { LimitWindow } from '../../src/types';

const NOW = 1_800_000_000_000;
const SHORT_MSG = "This request would exceed your account's rate limit. Please try again later.";
const shortBody = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: SHORT_MSG } });
/** CLIProxyAPI once every credential of the model cools down (sdk/cliproxy/auth/selector.go): its own Retry-After, no upstream headers. */
const cpaBody = (model: string) =>
  JSON.stringify({ error: { code: 'model_cooldown', message: `All credentials for model ${model} are cooling down (last error: rate_limit_error: ${SHORT_MSG})`, model, reset_seconds: 16214 } });

describe('classifying a 429', () => {
  test("Anthropic's per-minute limit is short, with its Retry-After", () => {
    const e = classifyHttpError('anthropic', 429, { 'retry-after': '12', 'anthropic-ratelimit-input-tokens-remaining': '0' }, shortBody, NOW);
    expect([e.kind, e.code, e.resetAt]).toEqual(['rate_limit', 'short_limit', undefined]);
    expect(e.retryAfterMs).toBe(12_000);
  });

  test('an exhausted per-minute header window waits for its reset', () => {
    const reset = new Date(NOW + 40_000).toISOString();
    const e = classifyHttpError('anthropic', 429, { 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': reset }, JSON.stringify({ error: { type: 'rate_limit_error', message: 'limit' } }), NOW);
    expect([e.code, e.retryAfterMs, e.resetAt]).toEqual(['short_limit', 40_000, undefined]);
  });

  test("CLIProxyAPI's cooldown with a short Retry-After counts as short", () => {
    const e = classifyHttpError('cliproxy', 429, { 'retry-after': '25' }, cpaBody('claude-haiku-5-5'), NOW);
    expect([e.kind, e.code, e.retryAfterMs, e.resetAt]).toEqual(['rate_limit', 'short_limit', 25_000, undefined]);
  });

  test("CLIProxyAPI's cooldown for hours after a per-minute 429 is still short, and the hours are not honoured", () => {
    const e = classifyHttpError('cliproxy', 429, { 'retry-after': '16214' }, cpaBody('claude-opus-5-5'), NOW);
    expect([e.kind, e.code, e.retryAfterMs, e.resetAt]).toEqual(['rate_limit', 'short_limit', undefined, undefined]);
  });

  test('unified rejected with a reset 4h away but no window claim: short, not parked', () => {
    const e = classifyHttpError('anthropic', 429, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String((NOW + 4 * 3_600_000) / 1000) }, shortBody, NOW);
    expect([e.code, e.resetAt]).toEqual(['short_limit', undefined]);
  });

  test('unified rejected with the 5h claim: the plan window, with its reset', () => {
    const reset = (NOW + 2 * 3_600_000) / 1000;
    const e = classifyHttpError('anthropic', 429, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': String(reset) }, shortBody, NOW);
    expect([e.kind, e.code, e.resetAt]).toEqual(['quota', 'plan_window', reset * 1000]);
  });
});

// ---------------------------------------------------------------------------
// The call: a fake CLIProxyAPI with one Claude plan, and an API key
// ---------------------------------------------------------------------------

function sse(text: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const limited = (headers: Record<string, string> = {}, body = shortBody) => new Response(body, { status: 429, headers: { 'content-type': 'application/json', ...headers } });

/** How many 429s each model gets before it answers (Infinity: never). */
const script = new Map<string, number>();
const hits = new Map<string, number>();
let headersFor: (model: string) => Record<string, string> = () => ({});
let keyCalls = 0;

const cpa = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as { model?: string };
    const model = String(body.model ?? '');
    const n = (hits.get(model) ?? 0) + 1;
    hits.set(model, n);
    if (n <= (script.get(model) ?? 0)) return limited(headersFor(model));
    return sse(`from the plan: ${model}`);
  },
});
const key = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text();
    keyCalls++;
    return sse('from the key');
  },
});

const cred = (windows: LimitWindow[]): CliproxyCredentialFacts => ({
  name: 'claude-jinx.json',
  provider: 'claude',
  email: 'jinx@example.test',
  disabled: false,
  windows,
  cooldowns: [],
  models: [{ id: 'claude-opus-5-5' }, { id: 'claude-fable-5-1' }, { id: 'claude-haiku-5-5' }],
  authIndex: 'claude-jinx.json',
});
const oauth = (name: string, usedPercent: number, resetsAt = Date.now() + 3 * 3_600_000): LimitWindow => ({ name, usedPercent, resetsAt, source: 'oauth', observedAt: Date.now() });

let engine: Engine;
let home: string;
let cwd: string;
const notices: string[] = [];
const cleared: string[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-short-limit-'));
  cwd = mkdtempSync(join(tmpdir(), 'conclave-short-limit-cwd-'));
  engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'cliproxy/claude-opus-5-5',
      smallModel: 'cliproxy/claude-haiku-5-5',
      providers: {
        // the key serves Opus only: a Fable call has nowhere else to go
        anthropic: { type: 'anthropic', baseUrl: `http://127.0.0.1:${key.port}`, apiKey: 'test-key-not-real', models: ['claude-opus-5-5'], enabled: false },
        cliproxy: {
          type: 'openai',
          baseUrl: `http://127.0.0.1:${cpa.port}/v1`,
          apiKey: 'test-client-key',
          enabled: true,
          models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'],
          anthropicWire: { baseUrl: `http://127.0.0.1:${cpa.port}`, models: ['claude-*'] },
          subscription: 'cliproxy',
        },
      },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
      limits: { maxRetries: 4, autoResume: true, fallbacks: {}, resumePrompt: 'go on' },
    } as never,
  });
  accountsOf(engine)!.setReader(async (id, o) => {
    if (o.clearCooldown) cleared.push(id);
  });
  engine.bus.on((e) => {
    if (e.type === 'notice') notices.push(e.notice.body);
  });
  // short retries in tests: about a second and a half in all
  shortLimitTiming.budgetMs = 1500;
  shortLimitTiming.baseMs = 100;
});

afterAll(async () => {
  await engine.shutdown();
  cpa.stop(true);
  key.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

beforeEach(() => {
  script.clear();
  hits.clear();
  notices.length = 0;
  cleared.length = 0;
  headersFor = () => ({});
  accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() - 1000, credentials: [cred([oauth('5h', 40), oauth('7d', 30)])] });
});

const call = (model: string, sessionId?: string) =>
  streamCompletion(engine, `cliproxy/${model}`, { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 100 }, { purpose: 'turn', sessionId });

const text = (r: Awaited<ReturnType<typeof call>>) => r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

describe('a per-minute limit on the call', () => {
  // first: the hint is said at most every 15 minutes per account, and later tests hit the same plan
  test('two sessions on one plan hitting it together get one hint to run fewer at once', async () => {
    const a = await engine.createSession({ cwd, title: 'a' });
    const b = await engine.createSession({ cwd, title: 'b' });
    script.set('claude-opus-5-5', 2);
    await Promise.all([call('claude-opus-5-5', a.id), call('claude-opus-5-5', b.id)]);
    expect(notices.filter((n) => /Running fewer heavy sessions at once/.test(n))).toHaveLength(1);
  });

  test("Anthropic's short 429 retries in place and then answers, with a clear notice", async () => {
    const s = await engine.createSession({ cwd, title: 'short' });
    script.set('claude-opus-5-5', 2);
    const r = await call('claude-opus-5-5', s.id);
    expect(text(r)).toContain('from the plan');
    expect(hits.get('claude-opus-5-5')).toBe(3);
    expect(notices.some((n) => /^Claude rate limit \(too many requests per minute on .+\)\. Retrying in \d+s/.test(n))).toBe(true);
    expect(notices.some((n) => /Usage limit reached/i.test(n))).toBe(false);
    // CLIProxyAPI's cooldown on the account is cleared before each retry
    expect(cleared).toContain('claude-jinx');
  });

  test('unified-reset 4h away but the OAuth usage has room: no park, the call retries and answers', async () => {
    script.set('claude-opus-5-5', 1);
    headersFor = () => ({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 4 * 3600) });
    const r = await call('claude-opus-5-5');
    expect(text(r)).toContain('from the plan');
  });

  test('unified rejected with the 5h claim: thrown at once as the plan window with its reset', async () => {
    script.set('claude-opus-5-5', Infinity);
    const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
    headersFor = () => ({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': String(reset) });
    const err = (await call('claude-opus-5-5').catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect([err.kind, err.code, err.resetAt]).toEqual(['quota', 'plan_window', reset * 1000]);
    expect(hits.get('claude-opus-5-5')).toBe(1);
  });

  test('a full Fable window parks a Fable call only; an Opus call on the same plan retries and answers', async () => {
    const fableReset = Date.now() + 4 * 3_600_000;
    accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() - 1000, credentials: [cred([oauth('5h', 40), oauth('7d', 30), oauth('7d fable', 100, fableReset)])] });
    script.set('claude-fable-5-1', Infinity);
    script.set('claude-opus-5-5', 1);
    const fable = (await call('claude-fable-5-1').catch((e) => e)) as ProviderError;
    expect([fable.kind, fable.code, fable.resetAt]).toEqual(['quota', 'plan_window', fableReset]);
    const opus = await call('claude-opus-5-5');
    expect(text(opus)).toContain('from the plan');
  });

  test('retries run out with nothing left: a clear stop, and the session is not parked', async () => {
    const s = await engine.createSession({ cwd, title: 'stops', model: 'cliproxy/claude-fable-5-1' } as never);
    script.set('claude-fable-5-1', Infinity);
    const err = (await call('claude-fable-5-1', s.id).catch((e) => e)) as ProviderError;
    expect(err.code).toBe('short_limit');
    expect(err.message).toMatch(/^Stopped: still rate limited after \d+ minutes?\. Send again or wait a minute\.$/);
    expect(err.resetAt).toBeUndefined();
    expect(hits.get('claude-fable-5-1')!).toBeGreaterThan(2);
  }, 10_000);

  test('a whole turn that stays rate limited ends with the stop notice, not a park', async () => {
    const s = await engine.createSession({ cwd, title: 'turn', model: 'cliproxy/claude-fable-5-1' } as never);
    script.set('claude-fable-5-1', Infinity);
    const runner = engine.runnerFor(s.id);
    await runner.enqueue({ text: 'go' });
    await Promise.race([runner.waitIdle(), Bun.sleep(8_000)]);
    expect(engine.repos.sessions.get(s.id)!.status).not.toBe('waiting_reset');
    expect(notices.some((n) => n.startsWith('Stopped: still rate limited'))).toBe(true);
    expect(notices.some((n) => /Usage limit reached/i.test(n))).toBe(false);
  }, 10_000);

  test('retries run out with an API key for the model: the call moves there', async () => {
    engine.config.update({ providers: { anthropic: { enabled: true } }, models: { accounts: [{ id: 'api-anthropic', vendor: 'anthropic', kind: 'api', provider: 'anthropic' }] } } as never);
    try {
      script.set('claude-opus-5-5', Infinity);
      const before = keyCalls;
      const r = await call('claude-opus-5-5');
      expect(text(r)).toBe('from the key');
      expect(keyCalls).toBe(before + 1);
    } finally {
      engine.config.update({ providers: { anthropic: { enabled: false } }, models: { accounts: [] } } as never);
    }
  }, 10_000);
});

describe('memory extraction', () => {
  test('a short 429 is tried once more later, not dropped', async () => {
    let n = 0;
    {
      const mem = new SqliteMemory({
        db: engine.repos.db,
        bus: engine.bus,
        // the engine's overrides keep memory off: this store sees it on
        config: { ...engine.config, get: () => ({ ...engine.config.get(), memory: { ...engine.config.get().memory, enabled: true } }) },
        extractRetryMs: 10,
        complete: async () => {
          if (++n === 1) throw classifyHttpError('cliproxy', 429, { 'retry-after': '20' }, cpaBody('claude-haiku-5-5'));
          return JSON.stringify({ add: [{ kind: 'fact', content: 'The owner runs two heavy coding sessions at once.' }], update: [] });
        },
      } as never);
      const sessionId = 'ses_mem_short';
      const msg = (seq: number, role: 'user' | 'assistant', t: string) => ({ id: `m${seq}`, sessionId, seq, role, kind: 'normal', content: [{ type: 'text', text: t }], createdAt: Date.now() });
      await mem.extract(sessionId, [msg(1, 'user', 'I usually run two heavy coding sessions on my Claude plan at the same time.'), msg(2, 'assistant', 'Noted, that can hit the per-minute limit.')] as never, {});
      expect(n).toBe(2);
    }
  });
});
