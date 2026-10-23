import { afterAll, describe, expect, test } from 'bun:test';
import { OpenAIProvider } from '../../src/providers/openai';
import { readSignature, tagSignature } from '../../src/providers/signatures';
import { wireToolName } from '../../src/providers/tool-names';
import type { ChatRequest, StreamEvent } from '../../src/providers/types';
import type { ProviderConfig } from '../../src/config/schema';
import { collect, doneOf, expectReject, jsonResponse, mockServer, routedFetch, sseResponse, type SseItem } from './mock';

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): SseItem => ({
  data: { id: 'chatcmpl-1', model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: null }], ...extra },
});
const finish = (reason: string): SseItem => ({ data: { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: reason }] } });
const usage = (u: Record<string, unknown>): SseItem => ({ data: { id: 'chatcmpl-1', choices: [], usage: u } });

const longName = 'mcp__filesystem_server_with_a_long_name__read_multiple_files_with_metadata_and_more';

const scenarios: Record<string, SseItem[]> = {
  text: [
    chunk({ role: 'assistant', reasoning_content: 'Think ' }),
    chunk({ reasoning_content: 'hard.' }),
    chunk({ content: 'Hi' }),
    chunk({ content: ' there' }),
    finish('stop'),
    usage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 5 },
    }),
    'data: [DONE]\n\n',
  ],
  parallel: [
    chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'LONG', arguments: '{"x"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: ':2}' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] }),
    finish('tool_calls'),
    'data: [DONE]\n\n',
  ],
  // Some servers reuse index 0 for every call and send whole arguments.
  reuse: [
    chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path":"a"}' } }] }),
    chunk({ tool_calls: [{ index: 0, id: 'call_2', function: { name: 'Read', arguments: '{"path":"b"}' } }] }),
    finish('stop'),
    'data: [DONE]\n\n',
  ],
  midstream: [chunk({ content: 'partial' }), { data: { error: { message: 'Provider returned error', code: 502 } } }],
};

const server = mockServer((req, body) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith('/models')) {
    return jsonResponse({
      data: [
        { id: 'gpt-5.5' },
        { id: 'text-embedding-3-small' },
        { id: 'whisper-1' },
        { id: 'gpt-5.4-mini' },
        { id: 'gpt-realtime' },
      ],
    });
  }
  if (url.pathname.endsWith('/embeddings')) {
    return jsonResponse({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: [i, i + 0.5] })).reverse() });
  }
  if (url.pathname.endsWith('/responses')) {
    return sseResponse([
      { data: { type: 'response.created', response: { id: 'resp_1', model: body.model } } },
      { data: { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } } },
      { data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'via responses' } },
      { data: { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } } },
    ]);
  }
  const scenario = (body.messages.at(-1)?.content as string) ?? 'text';
  if (scenario === 'quota') {
    return jsonResponse({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429);
  }
  return sseResponse(scenarios[scenario] ?? scenarios.text, {
    chunk: 9,
    headers: { 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '99', 'x-ratelimit-reset-requests': '600ms' },
  });
});
afterAll(() => server.stop());

function compat(extra: Partial<ProviderConfig> = {}) {
  return new OpenAIProvider({ id: 'deepseek', config: { type: 'openai', baseUrl: `${server.url}/v1`, ...extra }, apiKey: 'sk-ds' });
}
function official() {
  return new OpenAIProvider({ id: 'openai', config: { type: 'openai', baseUrl: 'https://api.openai.com/v1' }, apiKey: 'sk-oa', fetch: routedFetch(server.url) });
}
const ask = (text: string, over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'deepseek-v4-pro',
  system: [{ text: 'sys one' }, { text: 'sys two' }],
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...over,
});

describe('OpenAIProvider streaming', () => {
  test('text, reasoning_content and usage with cached and reasoning tokens', async () => {
    const events = await collect(compat().stream(ask('text')));
    expect(events[0]).toEqual({ type: 'start', id: 'chatcmpl-1', model: 'deepseek-v4-pro' });
    expect(events[1]).toMatchObject({ type: 'rate_limit' });
    expect(events.filter((e) => e.type === 'thinking_delta').map((e: any) => e.text)).toEqual(['Think ', 'hard.']);
    const done = doneOf(events);
    expect(done.content[0]).toMatchObject({ type: 'thinking', thinking: 'Think hard.' });
    expect(readSignature((done.content[0] as any).signature)).toEqual({ kind: 'openai-chat', model: 'deepseek-v4-pro', payload: '' });
    expect(done.content[1]).toEqual({ type: 'text', text: 'Hi there' });
    expect(done.stopReason).toBe('end_turn');
    expect(done.usage).toEqual({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5 });

    const req = server.requests.at(-1)!;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-ds');
    expect(req.body.stream_options).toEqual({ include_usage: true });
    expect(req.body.messages[0]).toEqual({ role: 'system', content: 'sys one\n\nsys two' });
    expect(req.body.messages[1]).toEqual({ role: 'user', content: 'text' });
  });

  test('parallel tool calls accumulate by index; id only in the first chunk; long names map back', async () => {
    const tools = [
      { name: 'Read', description: 'read', inputSchema: { type: 'object' } },
      { name: longName, description: 'long', inputSchema: { type: 'object' } },
    ];
    // The mock sends "LONG" as the wire name; swap in the real shortened name.
    const wire = wireToolName(longName);
    scenarios.parallel[1] = chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: wire, arguments: '{"x"' } }] });
    const events = await collect(compat().stream(ask('parallel', { tools })));
    const req = server.requests.at(-1)!;
    expect(req.body.tools[1].function.name).toBe(wire);
    expect(wire.length).toBeLessThanOrEqual(64);

    const starts = events.filter((e) => e.type === 'tool_use_start') as Array<Extract<StreamEvent, { type: 'tool_use_start' }>>;
    expect(starts.map((s) => [s.id, s.name])).toEqual([
      ['call_a', 'Read'],
      ['call_b', longName],
    ]);
    const done = doneOf(events);
    expect(done.stopReason).toBe('tool_use');
    expect(done.content).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'Read', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'call_b', name: longName, input: { x: 2 } },
    ]);
  });

  test('index reuse with different ids gives separate calls', async () => {
    const done = doneOf(await collect(compat().stream(ask('reuse', { tools: [{ name: 'Read', description: 'r', inputSchema: { type: 'object' } }] }))));
    expect(done.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } },
      { type: 'tool_use', id: 'call_2', name: 'Read', input: { path: 'b' } },
    ]);
    expect(done.stopReason).toBe('tool_use');
  });

  test('error chunk mid-stream', async () => {
    const err = await expectReject(collect(compat().stream(ask('midstream'))));
    expect(err.kind).toBe('server');
  });

  test('HTTP 429 insufficient_quota', async () => {
    const err = await expectReject(collect(compat().stream(ask('quota'))));
    expect(err.kind).toBe('quota');
  });
});

describe('OpenAIProvider request mapping', () => {
  test('tool results become tool messages; images follow in a user message', () => {
    // set to see images: the catalog has DeepSeek V4 Pro as text only
    const body = compat({ modelOverrides: { 'deepseek-v4-pro': { vision: true } } }).buildBody({
      model: 'deepseek-v4-pro',
      system: [],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'mine', signature: tagSignature('openai-chat', 'deepseek-v4-pro') },
            { type: 'thinking', thinking: 'other model', signature: tagSignature('openai-chat', 'kimi-k3') },
            { type: 'text', text: 'Taking a screenshot.' },
            { type: 'tool_use', id: 'call_1', name: longName, input: { a: 1 } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call_1',
              content: [
                { type: 'text', text: 'shot taken' },
                { type: 'image', mediaType: 'image/png', data: 'QUJD' },
              ],
            },
            { type: 'text', text: 'what do you see?' },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_x', content: 'boom', isError: true }] },
      ],
    }) as any;
    const m = body.messages;
    expect(m[1]).toEqual({
      role: 'assistant',
      content: 'Taking a screenshot.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: wireToolName(longName), arguments: '{"a":1}' } }],
      reasoning_content: 'mine',
    });
    expect(m[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'shot taken' });
    expect(m[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Images returned by tool call call_1:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'text', text: 'what do you see?' },
      ],
    });
    expect(m[4]).toEqual({ role: 'tool', tool_call_id: 'call_x', content: 'Error: boom' });
  });

  test('official OpenAI: max_completion_tokens, prompt_cache_key, reasoning_effort, no temperature for reasoning models', () => {
    const body = official().buildBody({ ...ask('x'), model: 'gpt-5.5', maxTokens: 500, cacheKey: 'sess-1', temperature: 0.3, thinking: { effort: 'high' } }) as any;
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
    expect(body.prompt_cache_key).toBe('sess-1');
    expect(body.reasoning_effort).toBe('high');
    expect(body.temperature).toBeUndefined();
  });

  test('compatible servers: max_tokens, no prompt_cache_key, vendor reasoning switch', () => {
    const body = compat().buildBody({ ...ask('x'), maxTokens: 500, cacheKey: 'sess-1', temperature: 0.3, thinking: { effort: 'low' } }) as any;
    expect(body.max_tokens).toBe(500);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.temperature).toBe(0.3);
    expect(body.reasoning_effort).toBe('low');
    const router = new OpenAIProvider({ id: 'openrouter', config: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' } });
    expect((router.buildBody({ ...ask('x'), model: 'anthropic/claude-sonnet-5.5', thinking: { budgetTokens: 3000 } }) as any).reasoning).toEqual({ max_tokens: 3000 });
  });

  test('tool_choice and response_format', () => {
    const body = compat().buildBody({
      ...ask('x'),
      tools: [{ name: 'A', description: 'a', inputSchema: { type: 'object' } }],
      toolChoice: 'any',
      responseSchema: { type: 'object' },
    }) as any;
    expect(body.tool_choice).toBe('required');
    expect(body.response_format.type).toBe('json_schema');
  });
});

describe('OpenAIProvider routing, models and embeddings', () => {
  test('Responses-only models on api.openai.com go to /responses', async () => {
    const done = doneOf(await collect(official().stream({ ...ask('x'), model: 'gpt-5.3-codex' })));
    expect(server.requests.at(-1)!.path).toBe('/v1/responses');
    expect(done.content).toEqual([{ type: 'text', text: 'via responses' }]);
  });

  test('listModels filters non-chat models on OpenAI', async () => {
    const models = await official().listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
    expect(models[0]).toMatchObject({ ref: 'openai/gpt-5.5', inputPrice: 5 });
  });

  test('embed keeps input order', async () => {
    expect(await compat().embed(['a', 'b', 'c'], 'text-embedding-3-small')).toEqual([
      [0, 0.5],
      [1, 1.5],
      [2, 2.5],
    ]);
  });
});
