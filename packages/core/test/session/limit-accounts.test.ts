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
import { handleLimit } from '../../src/session/limits';
import { ProviderError } from '../../src/providers/types';
import type { Message, TextBlock } from '../../src/types';

const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const calls: string[] = [];

// personal-gpt is at its limit; every other plan answers
const cpa = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
    const body = (await req.json().catch(() => ({}))) as any;
    if (Array.isArray(body.tools) && body.tools.length) calls.push(body.model);
    if (String(body.model).startsWith('personal-gpt/')) {
      return Response.json({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }, { status: 429, headers: { 'retry-after': '7200' } });
    }
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
          models: ['gpt-6-sol', ...IDS.map((id) => `${id}-gpt/gpt-6-sol`)],
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
