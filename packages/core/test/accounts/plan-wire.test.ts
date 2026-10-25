/**
 * Both Claude plans at their limit, an Antigravity plan that lists only
 * claude-sonnet-5-5-high, and a key. CLIProxyAPI never gives the bare id to
 * the Antigravity plan, so the hub must send that plan's own prefixed id
 * instead of moving the call to the key (the owner's live order: plans,
 * then the key, Antigravity unlisted).
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

/** Replies start with a signed thinking block when set. */
let thinkingReply = false;
function sse(text: string, signature = 'sig'): Response {
  const t = thinkingReply ? 1 : 0;
  const events = [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 0 } } },
    ...(t
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
          { type: 'content_block_stop', index: 0 },
        ]
      : []),
    { type: 'content_block_start', index: t, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: t, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: t },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const sent: string[] = [];
/** The thinking signatures each request to CLIProxyAPI replayed, by wire id. */
const thinkingSent: Array<{ model: string; signatures: string[] }> = [];
let apiCalls = 0;
/** Wire ids the fake CLIProxyAPI refuses with a 429; others answer. */
let refused = new Set(['claude-sonnet-5-5']);
const cpa = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { model: string; messages: Array<{ content: unknown }> };
    sent.push(body.model);
    thinkingSent.push({ model: body.model, signatures: [...JSON.stringify(body.messages).matchAll(/"signature":"([^"]+)"/g)].map((m) => m[1]) });
    if (refused.has(body.model)) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'all credentials are limited' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return sse(`from ${body.model}`, `sig-${body.model}`);
  },
});
const anthropic = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text();
    apiCalls++;
    return sse('from the key');
  },
});

const claude = (name: string): CliproxyCredentialFacts => ({ name, provider: 'claude', email: `${name}@example.test`, disabled: false, windows: [], cooldowns: [], models: [{ id: 'claude-sonnet-5-5' }], authIndex: name });
const ag = (name: string, prefix: string): CliproxyCredentialFacts => ({ name: `${name}.json`, provider: 'antigravity', email: `${name}@example.test`, disabled: false, windows: [], cooldowns: [], models: [{ id: 'claude-sonnet-5-5-high' }, { id: 'gemini-3-flash' }], authIndex: name, prefix });
const antigravity = ag('antigravity-g', 'backup-gemini');
/** A fresh read: blocks the 429s left are gone. */
const feed = (...extra: CliproxyCredentialFacts[]) => accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() + 1, credentials: [claude('claude-one.json'), claude('claude-two.json'), antigravity, ...extra] });
const call = () => streamCompletion(engine, 'anthropic/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test' });

let engine: Engine;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-planwire-'));
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
          models: ['claude-sonnet-5-5', 'backup-gemini/claude-sonnet-5-5-high', 'spare-gemini/claude-sonnet-5-5-high'],
          anthropicWire: { baseUrl: `http://127.0.0.1:${cpa.port}`, models: ['claude-*', '*/claude-*'] },
          subscription: 'cliproxy',
        },
      },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
      limits: { maxRetries: 0, autoResume: false, fallbacks: {}, resumePrompt: 'go on' },
    } as never,
  });
  engine.config.update({
    models: {
      accounts: [{ id: 'api-anthropic', vendor: 'anthropic', kind: 'api', provider: 'anthropic' }],
      // the owner's saved order: both Claude plans, then the key; the Antigravity plan is not in it
      routes: [{ vendor: 'anthropic', match: 'claude-sonnet-5-5', order: ['claude-one', 'claude-two', 'api-anthropic'] }],
    },
  } as never);
  accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() - 1000, credentials: [claude('claude-one.json'), claude('claude-two.json'), antigravity] });
});

afterAll(async () => {
  await engine.shutdown();
  cpa.stop(true);
  anthropic.stop(true);
  rmSync(home, { recursive: true, force: true });
});

describe('a plan that lists only a variant', () => {
  test('the per model order holds it before the key', () => {
    const route = accountsOf(engine)!.status().routes.find((r) => r.match === 'claude-sonnet-5-5');
    expect(route?.order).toEqual(['claude-one', 'claude-two', 'antigravity-g', 'api-anthropic']);
  });

  test('both Claude plans refuse: the call goes to the Antigravity plan by its own id, not to the key', async () => {
    const r = await streamCompletion(engine, 'anthropic/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test' });
    expect(r.content).toEqual([{ type: 'text', text: 'from backup-gemini/claude-sonnet-5-5-high' }]);
    expect(apiCalls).toBe(0);
    expect(sent).toEqual(['claude-sonnet-5-5', 'backup-gemini/claude-sonnet-5-5-high']);
    expect(r.served).toMatchObject({ provider: 'cliproxy', account: 'antigravity-g' });
  });

  test('the next call knows the Claude plans are blocked and goes straight to the plan', async () => {
    sent.length = 0;
    const r = await streamCompletion(engine, 'anthropic/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test' });
    expect(r.content).toEqual([{ type: 'text', text: 'from backup-gemini/claude-sonnet-5-5-high' }]);
    expect(sent).toEqual(['backup-gemini/claude-sonnet-5-5-high']);
    expect(apiCalls).toBe(0);
  });

  test('the first Antigravity plan refuses too: the second one takes the call, not the key', async () => {
    feed(ag('antigravity-s', 'spare-gemini'));
    refused = new Set(['claude-sonnet-5-5', 'backup-gemini/claude-sonnet-5-5-high']);
    sent.length = 0;
    const before = apiCalls;
    const r = await call();
    expect(sent).toEqual(['claude-sonnet-5-5', 'backup-gemini/claude-sonnet-5-5-high', 'spare-gemini/claude-sonnet-5-5-high']);
    expect(r.content).toEqual([{ type: 'text', text: 'from spare-gemini/claude-sonnet-5-5-high' }]);
    expect(apiCalls).toBe(before);
  });

  test('Antigravity first in the order refuses: the Claude plan after it takes the bare id before the key', async () => {
    accountsOf(engine)!.setOrder({ vendor: 'anthropic', match: 'claude-sonnet-5-5', order: ['antigravity-g', 'claude-one', 'api-anthropic', 'claude-two'] });
    feed();
    refused = new Set(['backup-gemini/claude-sonnet-5-5-high']);
    sent.length = 0;
    const before = apiCalls;
    const r = await call();
    expect(sent).toEqual(['backup-gemini/claude-sonnet-5-5-high', 'claude-sonnet-5-5']);
    expect(r.content).toEqual([{ type: 'text', text: 'from claude-sonnet-5-5' }]);
    expect(apiCalls).toBe(before);
  });

  test("a member's call billed to the hub never gets one of the owner's plans by name", async () => {
    const bob = engine.people.create({ name: 'bob', settings: { providers: { cliproxy: {} } } }).id;
    feed();
    refused = new Set(['claude-sonnet-5-5']);
    sent.length = 0;
    const err = await streamCompletion(engine, 'anthropic/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test', accountId: bob }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'rate_limit' });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m === 'claude-sonnet-5-5')).toBe(true);
  });

  test("thinking Antigravity signed is stored with its vendor and never replayed to a Claude plan, and the reverse", async () => {
    accountsOf(engine)!.setOrder({ vendor: 'anthropic', match: 'claude-sonnet-5-5', order: ['claude-one', 'claude-two', 'api-anthropic'] });
    const s = await engine.createSession({ cwd: home, title: 'think', model: 'anthropic/claude-sonnet-5-5' } as never);
    const runner = engine.runnerFor(s.id);
    const turn = async (text: string) => {
      await runner.enqueue({ text });
      await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
    };
    thinkingReply = true;
    try {
      // the Claude plans are spent: Antigravity answers, with thinking it signed
      feed();
      refused = new Set(['claude-sonnet-5-5']);
      await turn('one');
      const first = engine.getMessages(s.id).filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!;
      expect(first.content.some((b) => b.type === 'thinking')).toBe(true);
      expect(first.meta?.signedBy).toBe('gemini');
      // a Claude plan has room again: the next turn goes there, without Antigravity's thinking
      feed();
      refused = new Set();
      thinkingSent.length = 0;
      await turn('two');
      expect(thinkingSent).toEqual([{ model: 'claude-sonnet-5-5', signatures: [] }]);
      const second = engine.getMessages(s.id).filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!;
      expect(second.meta?.signedBy).toBe('anthropic');
      // the Claude plans are spent again: Antigravity gets no Claude-signed thinking either
      feed();
      refused = new Set(['claude-sonnet-5-5']);
      thinkingSent.length = 0;
      await turn('three');
      // each account gets back only the thinking it signed
      expect(thinkingSent).toEqual([
        { model: 'claude-sonnet-5-5', signatures: ['sig-claude-sonnet-5-5'] },
        { model: 'backup-gemini/claude-sonnet-5-5-high', signatures: ['sig-backup-gemini/claude-sonnet-5-5-high'] },
      ]);
    } finally {
      thinkingReply = false;
    }
  }, 30_000);

  test('five calls in a row falling back to the same account post one notice', async () => {
    accountsOf(engine)!.setOrder({ vendor: 'anthropic', match: 'claude-sonnet-5-5', order: ['claude-one', 'claude-two', 'api-anthropic'] });
    const s = await engine.createSession({ cwd: home, title: 'spam' } as never);
    refused = new Set(['claude-sonnet-5-5', 'backup-gemini/claude-sonnet-5-5-high']);
    for (let i = 0; i < 5; i++) {
      // a fresh read each time: every call starts on the plans and falls back again
      feed();
      await streamCompletion(engine, 'anthropic/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test', sessionId: s.id });
    }
    const said = engine.getMessages(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
    // one for Antigravity, one for the key: each destination once
    expect(said.filter((n) => n.includes('Using backup-gemini') || n.includes('Using antigravity'))).toHaveLength(1);
    expect(said.filter((n) => n.includes('for this call'))).toHaveLength(2);
  });

  test('every plan refuses: the key takes the call once', async () => {
    accountsOf(engine)!.setOrder({ vendor: 'anthropic', match: 'claude-sonnet-5-5', order: ['antigravity-g', 'claude-one', 'api-anthropic', 'claude-two'] });
    feed();
    refused = new Set(['backup-gemini/claude-sonnet-5-5-high', 'claude-sonnet-5-5']);
    sent.length = 0;
    const before = apiCalls;
    const r = await call();
    expect(sent).toEqual(['backup-gemini/claude-sonnet-5-5-high', 'claude-sonnet-5-5']);
    expect(r.content).toEqual([{ type: 'text', text: 'from the key' }]);
    expect(apiCalls).toBe(before + 1);
  });
});
