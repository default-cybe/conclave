import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { ProviderRegistry } from '../../src/providers/registry';
import { SplitWireProvider, splitAccount, wirePattern } from '../../src/providers/split';
import { jsonResponse, mockServer, sseResponse } from './mock';

const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'CLIPROXY_API_KEY', 'CONCLAVE_MODEL'];
const saved: Record<string, string | undefined> = {};

/** A CLIProxyAPI that speaks every wire. */
const server = mockServer((req) => {
  const url = new URL(req.url);
  if (url.pathname === '/v1/responses')
    return sseResponse([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'from responses' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } } } },
    ]);
  if (url.pathname.startsWith('/v1beta/models/'))
    return sseResponse([{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'from gemini' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } }]);
  if (url.pathname === '/v1/models') return jsonResponse({ object: 'list', data: [{ id: 'claude-opus-5-5', owned_by: 'anthropic' }, { id: 'gpt-6-astra', owned_by: 'openai' }] });
  if (url.pathname === '/v1/messages')
    return sseResponse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from messages' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
  return sseResponse([
    { data: { id: 'c1', choices: [{ index: 0, delta: { content: 'from chat' } }] } },
    { data: { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
    'data: [DONE]\n\n',
  ]);
});

let home = '';
let config: ConfigStore;
let registry: ProviderRegistry;

beforeAll(() => {
  for (const k of KEY_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'conclave-split-'));
  config = new ConfigStore(home);
  config.setSecret('values', 'cliproxy.clientKey', 'client-key-1');
  registry = new ProviderRegistry(config);
});

afterAll(() => {
  registry.dispose();
  server.stop();
  rmSync(home, { recursive: true, force: true });
  for (const k of KEY_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const entry = (models: string[]) => ({
  type: 'openai' as const,
  subscription: 'cliproxy',
  name: 'CLIProxyAPI',
  baseUrl: `${server.url}/v1`,
  apiKey: '${secret:cliproxy.clientKey}',
  enabled: true,
  models,
  anthropicWire: { baseUrl: server.url, models: ['claude-*', '*/claude-*'] },
});

async function text(stream: AsyncIterable<{ type: string; text?: string }>): Promise<string> {
  let out = '';
  for await (const ev of stream) if (ev.type === 'text_delta') out += ev.text;
  return out;
}

describe('patterns and accounts', () => {
  test('a star is any run of characters, the rest is literal', () => {
    expect(wirePattern('claude-*').test('claude-opus-5-5')).toBe(true);
    expect(wirePattern('claude-*').test('neu/claude-opus-5-5')).toBe(false);
    expect(wirePattern('*/claude-*').test('neu/claude-opus-5-5')).toBe(true);
    expect(wirePattern('gpt-6.1').test('gpt-641')).toBe(false);
  });

  test('the account is the part before the last slash', () => {
    expect(splitAccount('neu/claude-opus-5-5')).toEqual({ account: 'neu', model: 'claude-opus-5-5' });
    expect(splitAccount('gpt-6-astra')).toEqual({ account: '', model: 'gpt-6-astra' });
  });
});

describe('one provider over two wires', () => {
  test('Claude models go to /v1/messages, the rest to /chat/completions, with the client key', async () => {
    config.setRuntime({ providers: { cliproxy: entry(['claude-opus-5-5', 'gpt-6-astra', 'neu/claude-opus-5-5']) } } as any, 'cliproxy');
    const p = registry.get('cliproxy');
    expect(p).toBeInstanceOf(SplitWireProvider);
    server.requests.length = 0;
    const req = (model: string) => ({ model, system: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], maxTokens: 16 });
    expect(await text(p!.stream(req('claude-opus-5-5')))).toBe('from messages');
    expect(await text(p!.stream(req('neu/claude-opus-5-5')))).toBe('from messages');
    expect(await text(p!.stream(req('gpt-6-astra')))).toBe('from chat');
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/messages', '/v1/messages', '/v1/chat/completions']);
    // the prefix stays on the wire: CLIProxyAPI picks the account by it
    expect(server.requests[1].body.model).toBe('neu/claude-opus-5-5');
    expect(server.requests[0].headers['x-api-key']).toBe('client-key-1');
    expect(server.requests[2].headers.authorization).toBe('Bearer client-key-1');
  });

  test('model info: the catalog ignores the prefix, the name says which account', () => {
    const p = registry.get('cliproxy')!;
    const main = p.model('claude-opus-5-5');
    const second = p.model('neu/claude-opus-5-5');
    expect(main.name).toBe('Claude Opus 5.5');
    expect(second.name).toBe('Claude Opus 5.5, neu');
    expect(second.contextWindow).toBe(main.contextWindow);
    expect(main.caching).toBe('explicit');
    expect(second.ref).toBe('cliproxy/neu/claude-opus-5-5');
    // a signed in plan: no per-token price, so pickers say "plan" and usage shows no API cost
    expect([main.inputPrice, main.outputPrice, main.cacheReadPrice, main.cacheWritePrice]).toEqual([0, 0, 0, 0]);
  });

  test('refs with an account prefix resolve to the provider', () => {
    const r = registry.resolve('cliproxy/neu/claude-opus-5-5');
    expect(r).toMatchObject({ provider: 'cliproxy', model: 'neu/claude-opus-5-5' });
  });
});

describe('GPT over Responses, Gemini over its own wire', () => {
  const wires = (models: string[]) => ({ ...entry(models), geminiWire: { baseUrl: server.url, models: ['gemini-*'] }, responsesWire: { models: ['gpt-*', '*/gpt-*'] } });
  /** A turn after a Read whose result carries a PNG. */
  const afterRead = (model: string, extra: object = {}) => ({
    model,
    system: [],
    maxTokens: 16,
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'read it' }] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_1', name: 'Read', input: { path: 'a.png' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 'call_1', content: [{ type: 'text' as const, text: 'a.png' }, { type: 'image' as const, mediaType: 'image/png', data: 'QUJD' }] }] },
    ],
    ...extra,
  });

  test('each model takes its own wire; the image stays inside its tool result', async () => {
    config.setRuntime({ providers: { cliproxy: wires(['claude-opus-5-5', 'gpt-6-sol', 'gemini-3-flash', 'neu/gemini-3-flash', 'kimi-k3']) } } as any, 'cliproxy');
    const p = registry.get('cliproxy')!;
    server.requests.length = 0;
    expect(await text(p.stream(afterRead('gpt-6-sol')))).toBe('from responses');
    expect(await text(p.stream(afterRead('gemini-3-flash')))).toBe('from gemini');
    expect(await text(p.stream(afterRead('claude-opus-5-5')))).toBe('from messages');
    expect(await text(p.stream(afterRead('neu/gemini-3-flash')))).toBe('from chat');
    expect(await text(p.stream(afterRead('kimi-k3')))).toBe('from chat');
    expect(server.requests.map((r) => r.path)).toEqual([
      '/v1/responses',
      '/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
      '/v1/messages',
      '/v1/chat/completions',
      '/v1/chat/completions',
    ]);
    const [responses, gemini] = server.requests;
    expect(responses.headers.authorization).toBe('Bearer client-key-1');
    expect(responses.body.input.find((i: any) => i.type === 'function_call_output')).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: 'a.png' },
        { type: 'input_image', image_url: 'data:image/png;base64,QUJD', detail: 'auto' },
      ],
    });
    expect(gemini.headers['x-goog-api-key']).toBe('client-key-1');
    const parts = gemini.body.contents.flatMap((c: any) => c.parts);
    expect(parts.find((x: any) => x.functionResponse).functionResponse.name).toBe('Read');
  });

  test('a Cyber access program still takes Responses, even for a model no wire names', async () => {
    config.setRuntime({ providers: { cliproxy: { ...entry(['codex-x']), responsesWire: { models: [] } } } } as any, 'cliproxy');
    const p = registry.get('cliproxy')!;
    server.requests.length = 0;
    expect(await text(p.stream(afterRead('codex-x', { accessPrograms: { cyber: 'standard' } })))).toBe('from responses');
    expect(await text(p.stream(afterRead('codex-x')))).toBe('from chat');
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/responses', '/v1/chat/completions']);
    expect(server.requests[0].body.access_programs).toBeDefined();
    config.setRuntime({}, 'cliproxy');
  });
});

describe('a gateway comes after the vendor', () => {
  test('without an Anthropic key, aliases and bare ids use the signed in subscription', () => {
    config.setRuntime({ providers: { cliproxy: entry(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-astra']) } } as any, 'cliproxy');
    expect(registry.resolve('opus')).toMatchObject({ provider: 'cliproxy', model: 'claude-opus-5-5' });
    expect(registry.resolve('claude-sonnet-5-5').provider).toBe('cliproxy');
  });

  test('with an Anthropic key the vendor wins, as before', () => {
    config.setSecret('providers', 'anthropic', 'sk-ant-test');
    try {
      expect(registry.resolve('opus').provider).toBe('anthropic');
      expect(registry.resolve('claude-sonnet-5-5').provider).toBe('anthropic');
      // an explicit ref still goes where it says
      expect(registry.resolve('cliproxy/claude-sonnet-5-5').provider).toBe('cliproxy');
    } finally {
      config.setSecret('providers', 'anthropic', undefined);
    }
  });
});

describe('runtime layers', () => {
  test('each part of the hub has its own layer; clearing one leaves the other', () => {
    config.setRuntime({ server: { publicUrl: 'https://a.trycloudflare.com' } } as any);
    config.setRuntime({ providers: { cliproxy: entry(['gpt-6-astra']) } } as any, 'cliproxy');
    expect(config.get().server.publicUrl).toBe('https://a.trycloudflare.com');
    expect(config.get().providers.cliproxy.baseUrl).toBe(`${server.url}/v1`);
    config.setRuntime({}, 'cliproxy');
    expect(config.get().server.publicUrl).toBe('https://a.trycloudflare.com');
    // back to the default entry, which stays off
    expect(config.get().providers.cliproxy.enabled).toBe(false);
    expect(config.get().providers.cliproxy.baseUrl).toBe('http://127.0.0.1:8317/v1');
    // nothing of it reached the file
    expect(JSON.stringify(config.getUser())).not.toContain('trycloudflare');
    config.setRuntime({});
    expect(config.get().server.publicUrl).toBeUndefined();
  });

  test('a listing through the provider asks /v1/models when no list is set', async () => {
    config.setRuntime({ providers: { cliproxy: { ...entry([]), models: undefined } } } as any, 'cliproxy');
    const models = await registry.get('cliproxy')!.listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'gpt-6-astra']);
    config.setRuntime({}, 'cliproxy');
  });
});
