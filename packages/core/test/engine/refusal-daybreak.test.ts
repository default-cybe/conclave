/**
 * Refusal retries with Daybreak Blue (session/refusal-fallback.ts): a ChatGPT
 * plan marked "Use when a model refuses" whose own model list has a Daybreak
 * alias (CliproxyCredentialFacts.daybreak) runs the refused turn again with
 * access_programs {cyber: daybreak_blue}: a GPT turn on a model that takes
 * Blue, else GPT-6-Sol; a refused Claude turn on GPT-6-Sol. The session's own
 * Cyber access is not changed. A fake CLIProxyAPI answers every wire; nothing
 * reaches chatgpt.com.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import { accountsOf } from '../../src/accounts/attached';
import type { CliproxyCredentialFacts } from '../../src/accounts/service';
import type { Message, TextBlock } from '../../src/types';

const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const calls: Array<{ path: string; body: any }> = [];

// refuses everything except a Responses call that asks for Daybreak Blue
const cpa = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/v1/models') return Response.json({ object: 'list', data: [] });
    const body = (await req.json().catch(() => ({}))) as any;
    calls.push({ path, body });
    if (path === '/v1/messages') {
      const ev = [
        { type: 'message_start', message: { id: 'm1', model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I can not help.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ];
      return new Response(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/v1/responses') {
      const blue = body.access_programs?.cyber === 'daybreak_blue';
      return sse([
        { type: 'response.created', response: { id: 'r1', model: body.model } },
        blue ? { type: 'response.output_text.delta', output_index: 0, delta: 'Blue answers.' } : { type: 'response.refusal.delta', output_index: 0, delta: 'No.' },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 }, ...(body.access_programs ? { access_programs: body.access_programs } : {}) } },
      ]);
    }
    return sse([{ id: 'c1', choices: [{ index: 0, delta: { content: 'No.' }, finish_reason: 'content_filter' }] }, '[DONE]']);
  },
});

const cred = (name: string, prefix: string, models: string[], extra: Partial<CliproxyCredentialFacts> = {}): CliproxyCredentialFacts => ({ name, provider: name.startsWith('claude') ? 'claude' : 'codex', email: `${prefix}@example.test`, prefix, disabled: false, windows: [], cooldowns: [], models: models.map((id) => ({ id })), authIndex: name, ...extra });

let engine: Engine;
let home: string;
let cwd: string;

/** kai: approved for Daybreak (or not), marked; cmu: a plain ChatGPT plan; one: a Claude plan. */
function feed(approved: boolean) {
  accountsOf(engine)!.setCliproxy({
    provider: 'cliproxy',
    management: true,
    refreshedAt: Date.now() - 1000,
    credentials: [
      cred('codex-kai.json', 'kai', ['gpt-6-sol', 'gpt-5.5'], approved ? { daybreak: ['daybreak_blue'] } : {}),
      cred('codex-cmu.json', 'cmu', ['gpt-6-sol']),
      cred('claude-one.json', 'one', ['claude-opus-5-5']),
    ],
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-daybreak-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'conclave-daybreak-cwd-'));
  engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'cliproxy/cmu/gpt-6-sol',
      smallModel: 'cliproxy/cmu/gpt-6-sol',
      providers: {
        cliproxy: {
          type: 'openai',
          baseUrl: `http://127.0.0.1:${cpa.port}/v1`,
          apiKey: 'test-client-key',
          enabled: true,
          models: ['kai/gpt-6-sol', 'kai/gpt-5.5', 'cmu/gpt-6-sol', 'one/claude-opus-5-5'],
          // the plan's own names (the server's planMeta)
          modelMeta: { 'gpt-6-sol': { name: 'GPT-6-Sol' } },
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
      accounts: [
        { id: 'codex-kai', vendor: 'openai', kind: 'subscription', credential: 'codex-kai.json', refusal: true },
        { id: 'codex-cmu', vendor: 'openai', kind: 'subscription', credential: 'codex-cmu.json' },
        { id: 'claude-one', vendor: 'anthropic', kind: 'subscription', credential: 'claude-one.json' },
      ],
      refusalFallback: { enabled: true },
    },
  } as never);
});

beforeEach(() => {
  calls.length = 0;
  feed(true);
});

afterAll(async () => {
  await engine.shutdown();
  cpa.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

async function turn(sessionId: string, text: string) {
  const runner = engine.runnerFor(sessionId);
  await runner.enqueue({ text });
  await Promise.race([runner.waitIdle(), Bun.sleep(15_000)]);
}

const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);
/** The turn's calls: chores (a title) go without tools. */
const turnCalls = () => calls.filter((c) => Array.isArray(c.body.tools) && c.body.tools.length > 0);

describe('refusal retries with Daybreak Blue on an approved plan', () => {
  test('a refused GPT-6-Sol turn runs again on the approved plan with daybreak_blue; the session keeps its own Cyber access', async () => {
    const s = await engine.createSession({ cwd, title: 'gpt', model: 'cliproxy/cmu/gpt-6-sol', chat: { cyber: 'standard' } } as never);
    await turn(s.id, 'Explain this exploit chain.');
    const responses = turnCalls().filter((c) => c.path === '/v1/responses');
    // cmu with the session's standard, then kai with Blue: same model
    expect(responses.map((c) => [c.body.model, c.body.access_programs?.cyber])).toEqual([
      ['cmu/gpt-6-sol', 'standard'],
      ['kai/gpt-6-sol', 'daybreak_blue'],
    ]);
    const msgs = engine.getMessages(s.id);
    expect(notices(msgs).join('\n')).toContain('Answered by GPT-6-Sol, Daybreak Blue (kai@example.test).');
    expect(msgs.filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!.model).toBe('cliproxy/kai/gpt-6-sol');
    expect(engine.getSession(s.id)!.chat?.cyber).toBe('standard');
  }, 30_000);

  test('a model without Blue on the approved plan itself: tried again there on gpt-6-sol with daybreak_blue', async () => {
    const s = await engine.createSession({ cwd, title: 'gpt55', model: 'cliproxy/kai/gpt-5.5' } as never);
    await turn(s.id, 'Explain this exploit chain.');
    const turnsOnly = turnCalls().filter((c) => c.body.model?.startsWith('kai/'));
    expect(turnsOnly.map((c) => [c.path, c.body.model, c.body.access_programs?.cyber])).toEqual([
      ['/v1/chat/completions', 'kai/gpt-5.5', undefined],
      ['/v1/responses', 'kai/gpt-6-sol', 'daybreak_blue'],
    ]);
    expect(engine.getSession(s.id)!.chat?.cyber).toBeUndefined();
  }, 30_000);

  test('a refused Claude turn goes to the approved plan as gpt-6-sol with daybreak_blue', async () => {
    const s = await engine.createSession({ cwd, title: 'claude', model: 'cliproxy/one/claude-opus-5-5' } as never);
    await turn(s.id, 'Explain this exploit chain.');
    expect(calls.some((c) => c.path === '/v1/messages' && c.body.model === 'one/claude-opus-5-5')).toBe(true);
    const blue = turnCalls().filter((c) => c.path === '/v1/responses');
    expect(blue.map((c) => [c.body.model, c.body.access_programs])).toEqual([['kai/gpt-6-sol', { cyber: 'daybreak_blue' }]]);
    expect(notices(engine.getMessages(s.id)).join('\n')).toContain('Opus 5.5 (one@example.test) declined. Answered by GPT-6-Sol, Daybreak Blue (kai@example.test).');
  }, 30_000);

  test('without approval (no Daybreak alias in its list) the marked plan retries a GPT turn as before, and a Claude refusal does not reach it', async () => {
    feed(false);
    const g = await engine.createSession({ cwd, title: 'plain', model: 'cliproxy/cmu/gpt-6-sol' } as never);
    await turn(g.id, 'Explain this exploit chain.');
    expect(turnCalls().map((c) => [c.path, c.body.model, c.body.access_programs])).toEqual([
      ['/v1/chat/completions', 'cmu/gpt-6-sol', undefined],
      ['/v1/chat/completions', 'kai/gpt-6-sol', undefined],
    ]);
    calls.length = 0;
    const c = await engine.createSession({ cwd, title: 'plain claude', model: 'cliproxy/one/claude-opus-5-5' } as never);
    await turn(c.id, 'Explain this exploit chain.');
    expect(turnCalls().filter((x) => x.path !== "/v1/messages")).toEqual([]);
  }, 30_000);
});
