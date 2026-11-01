/**
 * One entry per model on a real engine (providers/merge.ts): a Claude plan
 * behind a fake CLIProxyAPI and an API key behind a fake Anthropic API both
 * serve claude-sonnet-5-5. The model list shows it once with its route, a
 * ref that names either provider follows the owner's order (also after the
 * key is gone), a signed out plan hands the call to the key, and the usage
 * row says which provider paid.
 *
 *   bun test packages/core/test/accounts/model-list.test.ts
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

function sse(text: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

let plan: 'ok' | 'signed-out' = 'ok';
const cpa = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text();
    if (new URL(req.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] });
    if (plan === 'signed-out') return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'token expired' } }, { status: 401 });
    return sse('from the plan');
  },
});
const anthropic = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text();
    if (new URL(req.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }], has_more: false });
    return sse('from the key');
  },
});

const cred = (name: string): CliproxyCredentialFacts => ({ name, provider: 'claude', email: `${name}@example.test`, disabled: false, windows: [], cooldowns: [], models: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }], authIndex: name });

const homes: string[] = [];

async function hub(withKey: boolean): Promise<Engine> {
  const home = mkdtempSync(join(tmpdir(), 'conclave-model-list-'));
  homes.push(home);
  const engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'anthropic/claude-sonnet-5-5',
      smallModel: 'anthropic/claude-sonnet-5-5',
      providers: {
        // without the key it has no address on this machine either: a local server would count as set up
        anthropic: withKey ? { type: 'anthropic', baseUrl: `http://127.0.0.1:${anthropic.port}`, apiKey: 'test-key-not-real', models: ['claude-sonnet-5-5'] } : { type: 'anthropic', apiKeyEnv: 'CONCLAVE_TEST_NO_KEY', models: ['claude-sonnet-5-5'] },
        cliproxy: {
          type: 'openai',
          baseUrl: `http://127.0.0.1:${cpa.port}/v1`,
          apiKey: 'test-client-key',
          enabled: true,
          models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
          anthropicWire: { baseUrl: `http://127.0.0.1:${cpa.port}`, models: ['claude-*'] },
          subscription: 'cliproxy',
        },
      },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
      limits: { maxRetries: 0, autoResume: false, fallbacks: {}, resumePrompt: 'go on' },
    } as never,
  });
  if (withKey) engine.config.update({ models: { accounts: [{ id: 'api-anthropic', vendor: 'anthropic', kind: 'api', provider: 'anthropic' }] } } as never);
  accountsOf(engine)!.setCliproxy({ provider: 'cliproxy', management: true, refreshedAt: Date.now() - 1000, credentials: [cred('claude-one.json')] });
  return engine;
}

let both: Engine;
let planOnly: Engine;

beforeAll(async () => {
  both = await hub(true);
  planOnly = await hub(false);
});

afterAll(async () => {
  await both.shutdown();
  await planOnly.shutdown();
  cpa.stop(true);
  anthropic.stop(true);
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const find = async (engine: Engine, ref: string) => (await engine.listModels()).flatMap((g) => g.models).find((m) => m.ref === ref);

describe('the model list', () => {
  test('Sonnet 5.5 once: the plan first, the key after, in words', async () => {
    expect(await find(both, 'cliproxy/claude-sonnet-5-5')).toMatchObject({ via: 'your Claude plan, then API key', refs: ['cliproxy/claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5'] });
    expect((await find(both, 'anthropic/claude-sonnet-5-5'))?.sameAs).toBe('cliproxy/claude-sonnet-5-5');
    // only the plan offers Opus here
    expect(await find(both, 'cliproxy/claude-opus-5-5')).toMatchObject({ via: 'your Claude plan' });
  });

  test('the owner moves the key first: the list follows', async () => {
    const acc = accountsOf(both)!;
    acc.setOrder({ vendor: 'anthropic', order: ['api-anthropic', 'claude-one'] });
    expect(await find(both, 'anthropic/claude-sonnet-5-5')).toMatchObject({ via: 'API key, then your Claude plan' });
    expect((await find(both, 'cliproxy/claude-sonnet-5-5'))?.sameAs).toBe('anthropic/claude-sonnet-5-5');
    acc.setOrder({ vendor: 'anthropic', order: ['claude-one', 'api-anthropic'] });
  });
});

describe('old ids and the route', () => {
  test('either provider ref goes to the first route in the order', () => {
    expect(both.providers.resolve('anthropic/claude-sonnet-5-5').provider).toBe('cliproxy');
    expect(both.providers.resolve('cliproxy/claude-sonnet-5-5').provider).toBe('cliproxy');
  });

  test('a session that names the key keeps working once the key is gone: the plan takes it', async () => {
    expect(planOnly.providers.resolve('anthropic/claude-sonnet-5-5').provider).toBe('cliproxy');
    const r = await streamCompletion(planOnly, 'anthropic/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test' });
    expect(r.content).toEqual([{ type: 'text', text: 'from the plan' }]);
  });

  test('a signed out plan hands the call to the key, and the usage row says the key paid', async () => {
    plan = 'signed-out';
    try {
      const s = await both.createSession({ title: 'signed out' });
      const r = await streamCompletion(both, 'cliproxy/claude-sonnet-5-5', { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { purpose: 'test', sessionId: s.id });
      expect(r.content).toEqual([{ type: 'text', text: 'from the key' }]);
      const row = both.repos.usage.recent(5, { sessionId: s.id })[0];
      expect(row).toMatchObject({ provider: 'anthropic', account: 'api-anthropic', model: 'claude-sonnet-5-5' });
      const notes = both.repos.messages.list(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
      expect(notes.some((n) => n.includes('refused the sign in'))).toBe(true);
    } finally {
      plan = 'ok';
    }
  });
});
