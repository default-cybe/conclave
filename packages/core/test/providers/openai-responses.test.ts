import { afterAll, describe, expect, test } from 'bun:test';
import { OpenAIResponsesProvider } from '../../src/providers/openai-responses';
import { readSignature } from '../../src/providers/signatures';
import type { ContentBlock } from '../../src/types';
import type { ChatRequest } from '../../src/providers/types';
import { collect, doneOf, expectReject, mockServer, sseResponse, type SseItem } from './mock';

const e = (type: string, data: Record<string, unknown> = {}): SseItem => ({ event: type, data: { type, ...data } });

const toolTurn: SseItem[] = [
  e('response.created', { response: { id: 'resp_1', model: 'gpt-5.5' } }),
  e('response.in_progress', { response: { id: 'resp_1' } }),
  e('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } }),
  e('response.reasoning_summary_part.added', { item_id: 'rs_1', output_index: 0, summary_index: 0 }),
  e('response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Plan the ' }),
  e('response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'steps.' }),
  e('response.reasoning_summary_part.added', { item_id: 'rs_1', output_index: 0, summary_index: 1 }),
  e('response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, summary_index: 1, delta: 'Then act.' }),
  e('response.output_item.done', { output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC123', summary: [] } }),
  e('response.output_item.added', { output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } }),
  e('response.content_part.added', { item_id: 'msg_1', output_index: 1, content_index: 0 }),
  e('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Reading ' }),
  e('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'files.' }),
  e('response.output_item.done', { output_index: 1, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Reading files.' }] } }),
  e('response.output_item.added', { output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '' } }),
  e('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 2, delta: '{"path":' }),
  e('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 2, delta: '"a.ts"}' }),
  e('response.function_call_arguments.done', { item_id: 'fc_1', output_index: 2, arguments: '{"path":"a.ts"}' }),
  e('response.output_item.added', { output_index: 3, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Grep', arguments: '' } }),
  e('response.function_call_arguments.delta', { item_id: 'fc_2', output_index: 3, delta: '{"q":"x"}' }),
  e('response.output_item.done', { output_index: 3, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Grep', arguments: '{"q":"x"}' } }),
  e('response.completed', {
    response: {
      status: 'completed',
      usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 } },
    },
  }),
];

const server = mockServer((_req, body) => {
  const last = JSON.stringify(body.input.at(-1));
  if (last.includes('fail')) {
    return sseResponse([e('response.created', { response: { id: 'r' } }), e('response.failed', { response: { error: { code: 'rate_limit_exceeded', message: 'Slow down' } } })]);
  }
  if (last.includes('cut')) {
    return sseResponse([
      e('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'm' } }),
      e('response.output_text.delta', { item_id: 'm', output_index: 0, delta: 'partial' }),
      e('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]);
  }
  return sseResponse(toolTurn, { chunk: 11 });
});
afterAll(() => server.stop());

const provider = () => new OpenAIResponsesProvider({ id: 'openai', config: { type: 'openai', baseUrl: `${server.url}/v1`, responsesApi: true }, apiKey: 'sk-x' });

const ask = (text: string, over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'gpt-5.5',
  system: [{ text: 'Be brief.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  tools: [
    { name: 'Read', description: 'read', inputSchema: { type: 'object' } },
    { name: 'Grep', description: 'grep', inputSchema: { type: 'object' } },
  ],
  ...over,
});

describe('OpenAIResponsesProvider', () => {
  let firstTurn: ContentBlock[] = [];

  test('reasoning summary, encrypted reasoning, text, parallel function calls, usage', async () => {
    const events = await collect(provider().stream(ask('go', { thinking: { effort: 'medium' }, cacheKey: 'k' })));
    expect(events[0]).toEqual({ type: 'start', id: 'resp_1', model: 'gpt-5.5' });
    expect(
      events
        .filter((x) => x.type === 'thinking_delta')
        .map((x: any) => x.text)
        .join(''),
    ).toBe('Plan the steps.\n\nThen act.');
    const done = doneOf(events);
    firstTurn = done.content;
    const thinking = done.content[0] as any;
    expect(thinking.thinking).toBe('Plan the steps.\n\nThen act.');
    expect(readSignature(thinking.signature)).toMatchObject({ kind: 'openai-responses', model: 'gpt-5.5' });
    expect(JSON.parse(readSignature(thinking.signature)!.payload)).toEqual({ id: 'rs_1', enc: 'ENC123' });
    expect(done.content.slice(1)).toEqual([
      { type: 'text', text: 'Reading files.' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'call_2', name: 'Grep', input: { q: 'x' } },
    ]);
    expect(done.stopReason).toBe('tool_use');
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 30, cacheReadTokens: 20, reasoningTokens: 10 });

    const req = server.requests.at(-1)!;
    expect(req.path).toBe('/v1/responses');
    expect(req.body).toMatchObject({
      model: 'gpt-5.5',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      instructions: 'Be brief.',
      reasoning: { effort: 'medium', summary: 'auto' },
      parallel_tool_calls: true,
    });
    // Not api.openai.com, so no prompt_cache_key.
    expect(req.body.prompt_cache_key).toBeUndefined();
    expect(req.body.tools[0]).toMatchObject({ type: 'function', name: 'Read', strict: false });
  });

  test('replays encrypted reasoning only for the same model', () => {
    const history = (model: string): ChatRequest =>
      ask('next', {
        model,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: firstTurn },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'file body' },
              { type: 'tool_result', toolUseId: 'call_2', content: [{ type: 'image', mediaType: 'image/png', data: 'QQ==' }], isError: true },
            ],
          },
        ],
      });
    const same = provider().buildBody(history('gpt-5.5')) as any;
    expect(same.input.map((i: any) => i.type)).toEqual([
      'message',
      'reasoning',
      'message',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
    ]);
    expect(same.input[1]).toEqual({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan the steps.\n\nThen act.' }], encrypted_content: 'ENC123' });
    expect(same.input[3]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a.ts"}' });
    expect(same.input[5]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'file body' });
    // the image rides in its call's output, not a later user message the model may read as unrelated
    expect(same.input[6]).toEqual({
      type: 'function_call_output',
      call_id: 'call_2',
      output: [
        { type: 'input_text', text: 'Error: (image output follows)' },
        { type: 'input_image', image_url: 'data:image/png;base64,QQ==', detail: 'auto' },
      ],
    });

    const other = provider().buildBody(history('gpt-5.4')) as any;
    expect(other.input.some((i: any) => i.type === 'reasoning')).toBe(false);
  });

  test('response.failed is classified', async () => {
    const err = await expectReject(collect(provider().stream(ask('fail'))));
    expect(err.kind).toBe('rate_limit');
  });

  test('incomplete response maps to max_tokens', async () => {
    const done = doneOf(await collect(provider().stream(ask('cut'))));
    expect(done.stopReason).toBe('max_tokens');
    expect(done.content).toEqual([{ type: 'text', text: 'partial' }]);
  });
});
