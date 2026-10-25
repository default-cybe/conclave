/**
 * A plan pinned by its prefix hits its limit (session/limits.ts handleLimit):
 * the same model continues on the owner's next ChatGPT plan that serves it,
 * skipping a paused or limited one, and the session keeps it. With no other
 * plan, or for a member's session or an id without a prefix, it parks as
 * before. A fake CLIProxyAPI answers; nothing reaches chatgpt.com.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import { accountsOf } from '../../src/accounts/attached';
import type { CliproxyCredentialFacts } from '../../src/accounts/service';
import { handleLimit, resumeAfterReset, switchBack } from '../../src/session/limits';
import { completeText } from '../../src/session/stream';
import { runSubagent } from '../../src/engine/subagent';
import { ProviderError } from '../../src/providers/types';
import type { Message, TextBlock } from '../../src/types';
import type { MemberPlanEntry, MemberPlans } from '../../src/people/plans';
import type { AccountDto } from '../../src/client/accounts';

const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const calls: string[] = [];

// personal-gpt, personal-gem and personal-cl are at their limit; every other plan answers
const cpa = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
    const body = (await req.json().catch(() => ({}))) as any;
    if (Array.isArray(body.tools) && body.tools.length) calls.push(body.model);
    // Claude ids take the Anthropic wire (anthropicWire below)
    if (path === '/v1/messages') {
      if (String(body.model).startsWith('personal-cl/')) return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'The usage limit has been reached' } }, { status: 429, headers: { 'retry-after': '7200' } });
      const ev = [
        { type: 'message_start', message: { id: 'm1', model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      return new Response(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (/^personal-(gpt|gem)\//.test(String(body.model))) {
      return Response.json({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }, { status: 429, headers: { 'retry-after': '7200' } });
    }
    // gpt-6-nano refuses: the refusal fallback walk starts
    if (body.model === 'gpt-6-nano') return sse([{ id: 'c1', choices: [{ index: 0, delta: { content: 'no' }, finish_reason: 'content_filter' }] }, '[DONE]']);
    return sse([{ id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']);
  },
});

const cred = (prefix: string, extra: Partial<CliproxyCredentialFacts> = {}): CliproxyCredentialFacts => ({ name: `codex-${prefix}.json`, provider: 'codex', email: `${prefix}@example.test`, prefix, disabled: false, windows: [], cooldowns: [], models: [{ id: 'gpt-6-sol' }], authIndex: prefix, ...extra });

let engine: Engine;
let home: string;
let cwd: string;
const IDS = ['personal', 'backup', 'spare'];

function feed(extra: Record<string, Partial<CliproxyCredentialFacts>> = {}) {
  accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() - 1000, credentials: IDS.map((id) => cred(`${id}-gpt`, extra[id])) });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-limit-acct-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'conclave-limit-acct-cwd-'));
  engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'cliproxy/spare-gpt/gpt-6-sol',
      smallModel: 'cliproxy/spare-gpt/gpt-6-sol',
      providers: {
        cliproxy: {
          type: 'openai',
          baseUrl: `http://127.0.0.1:${cpa.port}/v1`,
          apiKey: 'test-client-key',
          enabled: true,
          models: ['gpt-6-sol', 'gpt-6-mini', 'gpt-6-nano', ...IDS.map((id) => `${id}-gpt/gpt-6-sol`)],
          modelMeta: { 'gpt-6-sol': { name: 'GPT-6-Sol' } },
          anthropicWire: { baseUrl: `http://127.0.0.1:${cpa.port}`, models: ['claude-*', '*/claude-*'] },
          subscription: 'cliproxy',
        },
      },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
      limits: { maxRetries: 0, autoResume: true, fallbacks: {}, resumePrompt: 'go on' },
    } as never,
  });
  engine.config.update({
    models: { accounts: IDS.map((id) => ({ id, label: `${id}-gpt`, vendor: 'openai', kind: 'subscription', credential: `codex-${id}-gpt.json` })) },
  } as never);
});

beforeEach(() => {
  calls.length = 0;
  for (const id of IDS) accountsOf(engine)!.clearBlock(id);
  feed();
});

afterAll(async () => {
  await engine.shutdown();
  cpa.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);
const limitErr = () => new ProviderError('rate_limit', 'The usage limit has been reached', { resetAt: Date.now() + 2 * 3_600_000 });
const limit = (sessionId: string, ref: string) => handleLimit(engine, { id: sessionId, turnCheckpoint: undefined } as never, ref, limitErr());

describe('a pinned plan at its limit moves to the next plan, same model', () => {
  test('personal-gpt at its limit: the turn continues on backup-gpt, says so once, and the session keeps it', async () => {
    const s = await engine.createSession({ cwd, title: 'gpt', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    const runner = engine.runnerFor(s.id);
    await runner.enqueue({ text: 'hi' });
    await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
    expect(calls).toEqual(['personal-gpt/gpt-6-sol', 'backup-gpt/gpt-6-sol']);
    const msgs = engine.getMessages(s.id);
    expect(notices(msgs).filter((n) => /limit/i.test(n))).toEqual(['GPT-6-Sol (personal-gpt) hit its limit. Continuing on GPT-6-Sol (backup-gpt).']);
    expect(msgs.filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!.model).toBe('cliproxy/backup-gpt/gpt-6-sol');
    expect(engine.getSession(s.id)!.model).toBe('cliproxy/backup-gpt/gpt-6-sol');
    expect(engine.getSession(s.id)!.status).not.toBe('waiting_reset');
    // the next turn goes straight to backup-gpt
    calls.length = 0;
    await runner.enqueue({ text: 'again' });
    await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
    expect(calls).toEqual(['backup-gpt/gpt-6-sol']);
  }, 30_000);

  test('a paused or limited next plan is skipped', async () => {
    const s = await engine.createSession({ cwd, title: 'skip', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    feed({ backup: { disabled: true } });
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/spare-gpt/gpt-6-sol' });
    engine.updateSession(s.id, { model: 'cliproxy/personal-gpt/gpt-6-sol' });
    feed({ backup: { cooldowns: [{ reason: 'quota', until: Date.now() + 3_600_000 }] } });
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/spare-gpt/gpt-6-sol' });
  });

  test('a next plan without a prefix gets the bare id', async () => {
    const s = await engine.createSession({ cwd, title: 'bare', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    feed({ backup: { prefix: undefined } });
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/gpt-6-sol' });
  });

  test('a next plan that lists only a variant of the model gets its own id (Antigravity: claude-opus-5-5-high)', async () => {
    const s = await engine.createSession({ cwd, title: 'variant', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    feed({ backup: { models: [{ id: 'gpt-6-sol-high' }] } });
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-sol-high' });
  });

  test('no other plan can serve it: parks as before', async () => {
    const s = await engine.createSession({ cwd, title: 'park', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    feed({ backup: { disabled: true }, spare: { cooldowns: [{ reason: 'quota', until: Date.now() + 3_600_000 }] } });
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ parked: true });
    expect(engine.getSession(s.id)!.model).toBe('cliproxy/personal-gpt/gpt-6-sol');
    expect(notices(engine.getMessages(s.id)).at(-1)).toContain('Usage limit reached.');
  });

  test("a member's session never moves to the owner's plans", async () => {
    const s = await engine.createSession({ cwd, title: 'member', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never, 'acc_alice');
    expect(engine.repos.sessions.get(s.id)!.accountId).toBe('acc_alice');
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ parked: true });
    expect(engine.repos.sessions.get(s.id)!.model).toBe('cliproxy/personal-gpt/gpt-6-sol');
  });

  test('an id without a prefix is left to CLIProxyAPI: parks as before', async () => {
    const s = await engine.createSession({ cwd, title: 'loose', model: 'cliproxy/gpt-6-sol' } as never);
    expect(await limit(s.id, 'cliproxy/gpt-6-sol')).toEqual({ parked: true });
    expect(engine.getSession(s.id)!.model).toBe('cliproxy/gpt-6-sol');
  });

  test('when the failover plan also hits its limit, fallbacks under the initial prefix or bare ref still match', async () => {
    const s = await engine.createSession({ cwd, title: 'chain', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    feed({ spare: { disabled: true } });
    // personal-gpt fails over to backup-gpt
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-sol' });
    expect(engine.getSession(s.id)!.model).toBe('cliproxy/backup-gpt/gpt-6-sol');

    // backup-gpt also hits its limit; fallback configured under personal-gpt prefix
    feed({ personal: { cooldowns: [{ reason: 'quota', until: Date.now() + 3_600_000 }] }, spare: { disabled: false } });
    engine.config.update({ limits: { fallbacks: { 'cliproxy/personal-gpt/gpt-6-sol': ['cliproxy/spare-gpt/gpt-6-sol'] } } } as never);
    try {
      // disable spare in accounts so nextAccount() does not pick it, testing cfg.limits.fallbacks
      feed({ personal: { cooldowns: [{ reason: 'quota', until: Date.now() + 3_600_000 }] }, spare: { disabled: true } });
      expect(await limit(s.id, 'cliproxy/backup-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/spare-gpt/gpt-6-sol' });

      // and when configured under bare cliproxy/gpt-6-sol
      engine.config.update({ limits: { fallbacks: { 'cliproxy/gpt-6-sol': ['cliproxy/spare-gpt/gpt-6-sol'] } } } as never);
      expect(await limit(s.id, 'cliproxy/backup-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/spare-gpt/gpt-6-sol' });
    } finally {
      engine.config.update({ limits: { fallbacks: {} } } as never);
    }
  });
});

describe('the same on Claude, Gemini and Z.ai, no switching by hand', () => {
  test('two Claude plans: personal-cl at its limit, the turn continues on backup-cl and the session keeps it', async () => {
    const cl = ['personal', 'backup'].map((id) => cred(`${id}-cl`, { name: `claude-${id}-cl.json`, provider: 'claude', models: [{ id: 'claude-opus-5-5' }] }));
    accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() - 1000, credentials: [...IDS.map((id) => cred(`${id}-gpt`)), ...cl] });
    const models = [...(engine.config.get().providers as any).cliproxy.models];
    engine.config.update({ providers: { cliproxy: { models: [...models, 'claude-opus-5-5', 'personal-cl/claude-opus-5-5', 'backup-cl/claude-opus-5-5'] } } } as never);
    try {
      const s = await engine.createSession({ cwd, title: 'claude', model: 'cliproxy/personal-cl/claude-opus-5-5' } as never);
      const runner = engine.runnerFor(s.id);
      await runner.enqueue({ text: 'hi' });
      await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
      expect(calls).toEqual(['personal-cl/claude-opus-5-5', 'backup-cl/claude-opus-5-5']);
      expect(notices(engine.getMessages(s.id)).filter((n) => /limit/i.test(n))).toHaveLength(1);
      expect(engine.getSession(s.id)!.model).toBe('cliproxy/backup-cl/claude-opus-5-5');
      expect(engine.getSession(s.id)!.status).not.toBe('waiting_reset');
    } finally {
      engine.config.update({ providers: { cliproxy: { models } } } as never);
    }
  }, 30_000);

  test('two Antigravity plans: personal-gem at its limit, the turn continues on backup-gem and the session keeps it', async () => {
    const gem = ['personal', 'backup'].map((id) => cred(`${id}-gem`, { name: `antigravity-${id}-gem.json`, provider: 'antigravity', models: [{ id: 'gemini-3.5-flash' }] }));
    accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() - 1000, credentials: [...IDS.map((id) => cred(`${id}-gpt`)), ...gem] });
    const models = [...(engine.config.get().providers as any).cliproxy.models];
    engine.config.update({ providers: { cliproxy: { models: [...models, 'gemini-3.5-flash', 'personal-gem/gemini-3.5-flash', 'backup-gem/gemini-3.5-flash'] } } } as never);
    try {
      const s = await engine.createSession({ cwd, title: 'gem', model: 'cliproxy/personal-gem/gemini-3.5-flash' } as never);
      const runner = engine.runnerFor(s.id);
      await runner.enqueue({ text: 'hi' });
      await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
      expect(calls).toEqual(['personal-gem/gemini-3.5-flash', 'backup-gem/gemini-3.5-flash']);
      expect(notices(engine.getMessages(s.id)).filter((n) => /limit/i.test(n))).toHaveLength(1);
      expect(engine.getSession(s.id)!.model).toBe('cliproxy/backup-gem/gemini-3.5-flash');
      expect(engine.getSession(s.id)!.status).not.toBe('waiting_reset');
    } finally {
      engine.config.update({ providers: { cliproxy: { models } } } as never);
    }
  }, 30_000);

  test('the Z.ai Coding Plan at its limit: the same call continues on the next Z.ai key', async () => {
    const real = globalThis.fetch;
    const zai: string[] = [];
    // the coding plan's endpoint says its 5 hours are used up; the pay as you go endpoint answers
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.z.ai/')) return real(input, init);
      zai.push(new URL(url).pathname);
      if (url.includes('/coding/')) return Response.json({ error: { code: '1308', message: 'Usage limit reached for 5 hour' } }, { status: 429, headers: { 'retry-after': '7200' } });
      return sse([{ id: 'z1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']);
    }) as typeof fetch;
    const before = structuredClone(engine.config.getUser().providers);
    engine.config.update({
      providers: {
        zai: { type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'zai-plan-test-key', enabled: true, models: ['glm-5.3'], subscription: 'zai-coding' },
        'zai-paygo': { type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: 'zai-paygo-test-key', enabled: true, models: ['glm-5.3'] },
      },
    } as never);
    try {
      const s = await engine.createSession({ cwd, title: 'zai', model: 'zai/glm-5.3' } as never);
      const runner = engine.runnerFor(s.id);
      await runner.enqueue({ text: 'hi' });
      await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
      expect(zai).toEqual(['/api/coding/paas/v4/chat/completions', '/api/paas/v4/chat/completions']);
      expect(engine.getSession(s.id)!.status).not.toBe('waiting_reset');
      expect(notices(engine.getMessages(s.id)).filter((n) => /at its limit/i.test(n))).toEqual([expect.stringContaining('for this call.')]);
    } finally {
      globalThis.fetch = real;
      // the plan and its keys must not reach later tests (accts, keyPlan)
      engine.config.replace({ ...engine.config.getUser(), providers: before });
      accountsOf(engine)!.clearBlock('api-zai');
    }
  }, 30_000);
});

describe('back on the first plan once its limit resets', () => {
  const coolPersonal = () => feed({ personal: { cooldowns: [{ reason: 'quota', until: Date.now() + 3_600_000 }] } });
  /** As if the failover was 16 minutes ago and its reset unknown. */
  const settle = (id: string) => {
    const ls = engine.getSession(id)!.meta?.limitSwitch as Record<string, unknown>;
    engine.patchMeta(id, { limitSwitch: { from: ls.from, to: ls.to, at: Date.now() - 16 * 60_000 } });
  };

  test('the failover is recorded; while personal-gpt is limited nothing moves; after its reset the next turn goes back, with one notice', async () => {
    const s = await engine.createSession({ cwd, title: 'back', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    coolPersonal();
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-sol' });
    expect(engine.getSession(s.id)!.meta?.limitSwitch).toMatchObject({ from: 'cliproxy/personal-gpt/gpt-6-sol', to: 'cliproxy/backup-gpt/gpt-6-sol' });
    settle(s.id);
    expect(switchBack(engine, s.id)).toBeUndefined();
    expect(engine.getSession(s.id)!.model).toBe('cliproxy/backup-gpt/gpt-6-sol');
    // the window reset: the next turn starts on personal-gpt again (the fake still refuses it, so it fails over once more)
    feed();
    calls.length = 0;
    const runner = engine.runnerFor(s.id);
    await runner.enqueue({ text: 'next' });
    await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
    expect(calls[0]).toBe('personal-gpt/gpt-6-sol');
    expect(notices(engine.getMessages(s.id)).filter((n) => n.startsWith('Back on'))).toEqual(['Back on personal-gpt, its limit reset.']);
  }, 30_000);

  test('a chain of failovers keeps the first ref; a higher plan that has room comes back before the first', async () => {
    const s = await engine.createSession({ cwd, title: 'chain-back', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    feed({ personal: { cooldowns: [{ reason: 'quota', until: Date.now() + 3_600_000 }] }, backup: { disabled: true } });
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/spare-gpt/gpt-6-sol' });
    // backup-gpt is on again, personal-gpt still limited: up one plan, the original stays recorded
    coolPersonal();
    settle(s.id);
    expect(switchBack(engine, s.id)).toBe('cliproxy/backup-gpt/gpt-6-sol');
    expect(engine.getSession(s.id)!.meta?.limitSwitch).toMatchObject({ from: 'cliproxy/personal-gpt/gpt-6-sol', to: 'cliproxy/backup-gpt/gpt-6-sol' });
    feed();
    expect(switchBack(engine, s.id)).toBe('cliproxy/personal-gpt/gpt-6-sol');
    expect(engine.getSession(s.id)!.meta?.limitSwitch).toBeUndefined();
  });

  test('a block that lifts within minutes does not bounce the session back: the reset must pass, or 15 minutes', async () => {
    const s = await engine.createSession({ cwd, title: 'bounce', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    coolPersonal();
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-sol' });
    // the hub's blind block cleared and CLIProxyAPI reports no cooldown: personal-gpt looks ready at once
    feed();
    expect(switchBack(engine, s.id)).toBeUndefined();
    expect(engine.getSession(s.id)!.model).toBe('cliproxy/backup-gpt/gpt-6-sol');
    // its reset time passed: back
    const ls = engine.getSession(s.id)!.meta?.limitSwitch as Record<string, unknown>;
    expect(ls.until).toBeGreaterThan(Date.now());
    engine.patchMeta(s.id, { limitSwitch: { ...ls, until: Date.now() - 1 } });
    expect(switchBack(engine, s.id)).toBe('cliproxy/personal-gpt/gpt-6-sol');
  });

  test("a member's session never goes back to, or onto, the owner's plans", async () => {
    const s = await engine.createSession({ cwd, title: 'member-back', model: 'cliproxy/backup-gpt/gpt-6-sol' } as never, 'acc_alice');
    engine.patchMeta(s.id, { limitSwitch: { from: 'cliproxy/personal-gpt/gpt-6-sol', to: 'cliproxy/backup-gpt/gpt-6-sol' } });
    expect(switchBack(engine, s.id)).toBeUndefined();
    expect(engine.repos.sessions.get(s.id)!.model).toBe('cliproxy/backup-gpt/gpt-6-sol');
    expect(notices(engine.getMessages(s.id)).some((n) => n.startsWith('Back on'))).toBe(false);
  });

  test('a model the owner picked by hand after the failover stays', async () => {
    const s = await engine.createSession({ cwd, title: 'hand', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    coolPersonal();
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-sol' });
    engine.updateSession(s.id, { model: 'cliproxy/spare-gpt/gpt-6-sol' });
    feed();
    expect(switchBack(engine, s.id)).toBeUndefined();
    expect(engine.getSession(s.id)!.model).toBe('cliproxy/spare-gpt/gpt-6-sol');
    expect(engine.getSession(s.id)!.meta?.limitSwitch).toBeUndefined();
  });
});

// every plan of the model at its limit: personal-gpt answers 429, backup and spare are paused or cooling down
const allBlocked = () => feed({ backup: { disabled: true }, spare: { cooldowns: [{ reason: 'quota', until: Date.now() + 3_600_000 }] } });
// config updates merge, so a fallback an earlier test set stays: empty its list
const clearFallbacks = () => engine.config.update({ limits: { fallbacks: Object.fromEntries(Object.keys(engine.config.get().limits.fallbacks).map((k) => [k, []])) } } as never);
const withChain = async (entries: unknown[], fn: () => Promise<void>, enabled = false) => {
  clearFallbacks();
  engine.config.update({ models: { refusalFallback: { enabled, entries } } } as never);
  try {
    await fn();
  } finally {
    engine.config.update({ models: { refusalFallback: { enabled: false, entries: [] } } } as never);
    clearFallbacks();
  }
};

describe('no plan left for the model: the refusal fallback list is the default limit fallback', () => {
  test('the first ready entry of another model takes the turn, with the usual notice', async () => {
    const s = await engine.createSession({ cwd, title: 'chain', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    allBlocked();
    await withChain([{ model: 'cliproxy/gpt-6-sol' }, { model: 'cliproxy/gpt-6-mini' }], async () => {
      // the same model (another plan of it) is skipped: no plan of it is ready
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/gpt-6-mini' });
      expect(notices(engine.getMessages(s.id)).at(-1)).toBe('cliproxy/personal-gpt/gpt-6-sol hit its limit. Falling back to cliproxy/gpt-6-mini for this turn.');
      // configured limits.fallbacks still win
      engine.config.update({ limits: { fallbacks: { 'cliproxy/personal-gpt/gpt-6-sol': ['cliproxy/gpt-6-nano'] } } } as never);
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/gpt-6-nano' });
      clearFallbacks();
      // a model that hit its limit this turn is not gone back to: nothing left, it parks
      expect(await handleLimit(engine, { id: s.id, turnCheckpoint: undefined } as never, 'cliproxy/personal-gpt/gpt-6-sol', limitErr(), ['cliproxy/gpt-6-mini'])).toEqual({ parked: true });
    });
  });

  test('a whole turn: the limit falls back to the list entry and answers', async () => {
    const s = await engine.createSession({ cwd, title: 'turn', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    allBlocked();
    await withChain([{ model: 'cliproxy/gpt-6-mini' }], async () => {
      const runner = engine.runnerFor(s.id);
      await runner.enqueue({ text: 'hi' });
      await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
      expect(calls).toEqual(['personal-gpt/gpt-6-sol', 'gpt-6-mini']);
      expect(engine.getSession(s.id)!.status).not.toBe('waiting_reset');
      expect(engine.getMessages(s.id).filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!.model).toBe('cliproxy/gpt-6-mini');
    });
  }, 30_000);

  test("the session's agent decides the list: refusalFallback off parks, its own list replaces the owner's", async () => {
    allBlocked();
    const base = engine.agentFor(await engine.createSession({ cwd, title: 'base' } as never));
    await engine.extensions.saveAgent({ ...base, name: 'limit-off', refusalFallback: false }, 'user');
    await engine.extensions.saveAgent({ ...base, name: 'limit-own', refusalFallback: [{ model: 'cliproxy/gpt-6-nano' }] }, 'user');
    await withChain([{ model: 'cliproxy/gpt-6-mini' }], async () => {
      const off = await engine.createSession({ cwd, title: 'off', model: 'cliproxy/personal-gpt/gpt-6-sol', agent: 'limit-off' } as never);
      expect(await limit(off.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ parked: true });
      const own = await engine.createSession({ cwd, title: 'own', model: 'cliproxy/personal-gpt/gpt-6-sol', agent: 'limit-own' } as never);
      expect(await limit(own.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/gpt-6-nano' });
    });
  });

  test('a chore at its limit runs once more on the next model', async () => {
    allBlocked();
    await withChain([{ model: 'cliproxy/gpt-6-mini' }], async () => {
      expect(await completeText(engine, { model: 'cliproxy/personal-gpt/gpt-6-sol', prompt: 'title this' })).toBe('ok');
    });
    // nothing to fall back to: the limit error stands
    await expect(completeText(engine, { model: 'cliproxy/personal-gpt/gpt-6-sol', prompt: 'title this' })).rejects.toThrow(/usage limit/i);
  }, 30_000);
});

describe('the usage fallback list (models.limitFallback): by model, each on its own account order', () => {
  const SOL_MINI = [{ id: 'gpt-6-sol' }, { id: 'gpt-6-mini' }];
  const solOut = { reason: 'quota', model: 'gpt-6-sol', until: Date.now() + 3_600_000 };
  // every plan lists sol and mini; sol is at its limit on all of them, mini on personal only
  const solBlocked = () =>
    feed({
      personal: { models: SOL_MINI, cooldowns: [{ ...solOut, model: 'gpt-6-mini' }] },
      backup: { models: SOL_MINI, cooldowns: [solOut] },
      spare: { models: SOL_MINI, cooldowns: [solOut] },
    });
  const withUsage = async (models: string[], fn: () => Promise<void>, enabled = true) => {
    engine.config.update({ models: { limitFallback: { enabled, models } } } as never);
    try {
      await withChain([{ model: 'cliproxy/gpt-6-nano' }], fn);
    } finally {
      engine.config.update({ models: { limitFallback: { enabled: false, models: [] } } } as never);
    }
  };
  const CHAIN = ['cliproxy/gpt-6-nano', 'cliproxy/gpt-6-sol', 'cliproxy/gpt-6-mini'];

  test('the same model goes to its next account first', async () => {
    const s = await engine.createSession({ cwd, title: 'usage same', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    await withUsage(CHAIN, async () => {
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-sol' });
    });
  });

  test("every account of the model at its limit: the next model's first ready account, not the refusal list, and down the list, not back to the top", async () => {
    const s = await engine.createSession({ cwd, title: 'usage next', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    solBlocked();
    await withUsage(CHAIN, async () => {
      // nano is first in the list and first in the refusal list; sol sits in the middle, so mini comes next, on backup (personal is out for mini)
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-mini' });
      expect(notices(engine.getMessages(s.id)).at(-1)).toBe('cliproxy/personal-gpt/gpt-6-sol hit its limit. Falling back to cliproxy/backup-gpt/gpt-6-mini for this turn.');
      // mini tried this turn too: nothing below it, it parks
      expect(await handleLimit(engine, { id: s.id, turnCheckpoint: undefined } as never, 'cliproxy/personal-gpt/gpt-6-sol', limitErr(), ['cliproxy/backup-gpt/gpt-6-mini'])).toEqual({ parked: true });
    });
    // a model not on the list starts from the top
    solBlocked();
    await withUsage(['cliproxy/gpt-6-mini', 'cliproxy/gpt-6-nano'], async () => {
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-mini' });
    });
  });

  test('the next model on a plan that lists only a variant of it gets the plan\'s own id', async () => {
    const s = await engine.createSession({ cwd, title: 'usage variant', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    feed({
      personal: { models: SOL_MINI, cooldowns: [{ ...solOut, model: 'gpt-6-mini' }] },
      backup: { models: [{ id: 'gpt-6-sol' }, { id: 'gpt-6-mini-high' }], cooldowns: [solOut] },
      spare: { models: SOL_MINI, cooldowns: [solOut] },
    });
    await withUsage(CHAIN, async () => {
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/backup-gpt/gpt-6-mini-high' });
    });
  });

  test('an agent with the refusal fallback off gets no other model; a chore uses the list', async () => {
    solBlocked();
    const base = engine.agentFor(await engine.createSession({ cwd, title: 'base' } as never));
    await engine.extensions.saveAgent({ ...base, name: 'usage-off', refusalFallback: false }, 'user');
    await withUsage(CHAIN, async () => {
      const off = await engine.createSession({ cwd, title: 'usage off', model: 'cliproxy/personal-gpt/gpt-6-sol', agent: 'usage-off' } as never);
      expect(await limit(off.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ parked: true });
      calls.length = 0;
      expect(await completeText(engine, { model: 'cliproxy/personal-gpt/gpt-6-sol', prompt: 'title this' })).toBe('ok');
    });
  }, 30_000);

  test('across vendors: both Claude plans at their limit go to the first ready GPT plan, then to the Z.ai key', async () => {
    const gptAccounts = IDS.map((id) => ({ id, label: `${id}-gpt`, vendor: 'openai', kind: 'subscription', credential: `codex-${id}-gpt.json` }));
    const claude = ['claude-a', 'claude-b'];
    const out = { reason: 'quota', until: Date.now() + 3_600_000 };
    const sol61 = { ...out, model: 'gpt-6.1-sol' };
    const feedAll = (gptOut: Record<string, boolean>) =>
      accountsOf(engine)!.setCliproxy({
        provider: 'cliproxy',
        management: true,
        refreshedAt: Date.now() - 1000,
        credentials: [
          ...claude.map((p) => ({ ...cred(p), name: `${p}.json`, provider: 'claude', models: [{ id: 'claude-opus-5-5' }], cooldowns: [out] })),
          ...IDS.map((id) => cred(`${id}-gpt`, { models: [{ id: 'gpt-6-sol' }, { id: 'gpt-6.1-sol' }], cooldowns: gptOut[id] ? [sol61] : [] })),
        ],
      });
    engine.config.update({
      models: { accounts: [...claude.map((id) => ({ id, label: id, vendor: 'anthropic', kind: 'subscription', credential: `${id}.json` })), ...gptAccounts] },
      providers: { zai: { type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'zai-test-key', enabled: true, models: ['glm-5.3'] } },
    } as never);
    try {
      const s = await engine.createSession({ cwd, title: 'usage vendors', model: 'cliproxy/claude-a/claude-opus-5-5' } as never);
      await withUsage(['cliproxy/claude-opus-5-5', 'cliproxy/gpt-6.1-sol', 'zai/glm-5.3'], async () => {
        // personal and backup are out for 6.1-sol: spare is the first ready plan in the order
        feedAll({ personal: true, backup: true });
        expect(await limit(s.id, 'cliproxy/claude-a/claude-opus-5-5')).toEqual({ fallback: 'cliproxy/spare-gpt/gpt-6.1-sol' });
        // every GPT plan out too: the Z.ai key, no prefix
        feedAll({ personal: true, backup: true, spare: true });
        expect(await limit(s.id, 'cliproxy/claude-a/claude-opus-5-5')).toEqual({ fallback: 'zai/glm-5.3' });
      });
    } finally {
      engine.config.update({ models: { accounts: gptAccounts }, providers: { zai: { enabled: false } } } as never);
    }
  });

  test('off or unset: the refusal list as before', async () => {
    const s = await engine.createSession({ cwd, title: 'usage unset', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never);
    solBlocked();
    await withUsage(CHAIN, async () => {
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/gpt-6-nano' });
    }, false);
    await withUsage([], async () => {
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/gpt-6-nano' });
    });
  });
});

describe('a refusal fallback entry at its limit tries the next plan of its model first', () => {
  test('personal-gpt at its limit: the entry runs on backup-gpt', async () => {
    const s = await engine.createSession({ cwd, title: 'refusal', model: 'cliproxy/gpt-6-nano' } as never);
    await withChain(
      [{ model: 'cliproxy/gpt-6-sol', account: 'personal' }],
      async () => {
        const runner = engine.runnerFor(s.id);
        await runner.enqueue({ text: 'hi' });
        await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
        expect(calls).toEqual(['gpt-6-nano', 'personal-gpt/gpt-6-sol', 'backup-gpt/gpt-6-sol']);
        const last = engine.getMessages(s.id).filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!;
        expect(last.model).toBe('cliproxy/backup-gpt/gpt-6-sol');
        expect(last.stopReason).not.toBe('refusal');
      },
      true,
    );
  }, 30_000);
});

describe('a subagent at a usage limit', () => {
  test('fails over like a main chat', async () => {
    const parent = await engine.createSession({ cwd, title: 'parent', model: 'cliproxy/spare-gpt/gpt-6-sol' } as never);
    const r = await runSubagent(engine, { parentSessionId: parent.id, agent: 'general-purpose', prompt: 'look', description: 'look', model: 'cliproxy/personal-gpt/gpt-6-sol' });
    expect(r.resumeAt).toBeUndefined();
    expect(r.text).toContain('ok');
    expect(calls).toEqual(['personal-gpt/gpt-6-sol', 'backup-gpt/gpt-6-sol']);
  }, 30_000);

  test('with nothing left it waits for the reset, then reports to its parent', async () => {
    const parent = await engine.createSession({ cwd, title: 'parent', model: 'cliproxy/spare-gpt/gpt-6-sol' } as never);
    allBlocked();
    const r = await runSubagent(engine, { parentSessionId: parent.id, agent: 'general-purpose', prompt: 'look', description: 'look', model: 'cliproxy/personal-gpt/gpt-6-sol' });
    expect(r.resumeAt).toBeGreaterThan(Date.now());
    expect(r.text).toContain('continues on its own when the limit resets');
    // still parked: the durable resume job picks it up
    const child = engine.getSession(r.sessionId)!;
    expect(child.status).toBe('waiting_reset');
    expect(engine.getSession(parent.id)!.meta?.backgroundTasks).toBe(true);
    // the reset: backup-gpt is back, the child finishes and its report reaches the parent
    feed();
    engine.runnerFor(parent.id).noteDelayMs = 50;
    await resumeAfterReset(engine, { sessionId: r.sessionId });
    const done = engine.getSession(r.sessionId)!;
    expect((done.meta?.background as { state: string }).state).toBe('completed');
    expect(done.status).not.toBe('waiting_reset');
    await Bun.sleep(300);
    await engine.runnerFor(parent.id).waitIdle();
    const all = engine.getMessages(parent.id).map((m) => m.content.map((b) => (b.type === 'text' ? (b as TextBlock).text : '')).join(''));
    expect(all.some((t) => t.includes(`<subagent_result session="${r.sessionId}"`))).toBe(true);
  }, 30_000);

  test('a parked child the owner writes to stops waiting, its resume job goes, and its report reaches the parent', async () => {
    const parent = await engine.createSession({ cwd, title: 'parent', model: 'cliproxy/spare-gpt/gpt-6-sol' } as never);
    allBlocked();
    const r = await runSubagent(engine, { parentSessionId: parent.id, agent: 'general-purpose', prompt: 'look', description: 'look', model: 'cliproxy/personal-gpt/gpt-6-sol' });
    expect(engine.getSession(r.sessionId)!.status).toBe('waiting_reset');
    expect(engine.repos.jobs.pending('session.resume').some((j) => j.dedupeKey === `resume:${r.sessionId}`)).toBe(true);
    feed();
    engine.runnerFor(parent.id).noteDelayMs = 50;
    const child = engine.runnerFor(r.sessionId);
    await child.enqueue({ text: 'how far did you get?' });
    await Promise.race([child.waitIdle(), Bun.sleep(15_000)]);
    await Bun.sleep(300);
    const done = engine.getSession(r.sessionId)!;
    expect(done.meta?.background).toMatchObject({ state: 'completed', waitingReset: false });
    expect(engine.repos.jobs.pending('session.resume').some((j) => j.dedupeKey === `resume:${r.sessionId}`)).toBe(false);
    await engine.runnerFor(parent.id).waitIdle();
    const all = engine.getMessages(parent.id).map((m) => m.content.map((b) => (b.type === 'text' ? (b as TextBlock).text : '')).join(''));
    expect(all.filter((t) => t.includes(`<subagent_result session="${r.sessionId}"`))).toHaveLength(1);
  }, 30_000);
});

describe("a member's plan at its limit", () => {
  let ready: AccountDto[] = [];
  const listeners = new Set<(id: string) => void>();
  let memberId = '';
  const plan = (prefix: string) => ({ id: `m-${prefix}`, label: prefix, kind: 'subscription', prefix }) as unknown as AccountDto;
  const entry: MemberPlanEntry = { config: { type: 'openai', baseUrl: `http://127.0.0.1:${cpa.port}/v1`, models: ['gpt-6-sol', 'personal-gpt/gpt-6-sol', 'mine-gpt/gpt-6-sol'] } as never, apiKey: 'member-key' };
  const plans: MemberPlans = {
    entry: (id) => (id === memberId ? entry : undefined),
    count: (id) => (id === memberId ? 2 : 0),
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    readyAccounts: (id, model) => (id === memberId && model === 'gpt-6-sol' ? ready : []),
  };

  beforeAll(() => {
    memberId = engine.people.create({ name: 'mia' }).id;
    engine.access.setPlans(plans);
    for (const fn of listeners) fn(memberId);
  });
  afterAll(() => engine.access.setPlans(undefined));

  // her plans are named like the owner's on purpose: personal-gpt is hers here
  test('with two plans she moves to her second one, same model', async () => {
    ready = [plan('personal-gpt'), plan('mine-gpt')];
    const s = await engine.createSession({ cwd, title: 'member two plans', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never, memberId);
    expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ fallback: 'cliproxy/mine-gpt/gpt-6-sol' });
    expect(engine.repos.sessions.get(s.id)!.model).toBe('cliproxy/mine-gpt/gpt-6-sol');
  });

  test("she never gets an owner's plan or the owner's refusal list, even when they are ready", async () => {
    // backup-gpt is the owner's: her own CLIProxyAPI does not list it
    ready = [plan('backup-gpt')];
    const s = await engine.createSession({ cwd, title: 'member no owner', model: 'cliproxy/personal-gpt/gpt-6-sol' } as never, memberId);
    await withChain([{ model: 'cliproxy/gpt-6-mini' }, { model: 'cliproxy/gpt-6-sol', account: 'spare' }], async () => {
      expect(await limit(s.id, 'cliproxy/personal-gpt/gpt-6-sol')).toEqual({ parked: true });
    });
    expect(engine.repos.sessions.get(s.id)!.model).toBe('cliproxy/personal-gpt/gpt-6-sol');
  });
});
