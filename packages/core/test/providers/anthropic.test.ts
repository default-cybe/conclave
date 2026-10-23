import { afterAll, describe, expect, test } from 'bun:test';
import { AnthropicProvider, planAnthropicThinking } from '../../src/providers/anthropic';
import { lookupModel } from '../../src/providers/catalog';
import { tagSignature } from '../../src/providers/signatures';
import { ProviderError, type ChatRequest } from '../../src/providers/types';
import type { ProviderConfig } from '../../src/config/schema';
import { collect, doneOf, expectReject, jsonResponse, mockServer, sseResponse, type SseItem } from './mock';

const ev = (type: string, data: Record<string, unknown>): SseItem => ({ event: type, data: { type, ...data } });

const textStream: SseItem[] = [
  ev('message_start', {
    message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } },
  }),
  ': comment line\n\n',
  ev('ping', {}),
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
  ev('content_block_stop', { index: 0 }),
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
  ev('message_stop', {}),
];

const longName = 'mcp__some_really_long_server_name__and_an_even_longer_tool_name_that_goes_on';

const toolStream: SseItem[] = [
  ev('message_start', { message: { id: 'msg_2', usage: { input_tokens: 20, output_tokens: 1 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'check.' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
  ev('content_block_stop', { index: 0 }),
  ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }),
  ev('content_block_stop', { index: 1 }),
  ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'PLACEHOLDER', input: {} } }),
  ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"q": 1' } }),
  ev('content_block_stop', { index: 2 }),
  ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }),
];

let wireLongName = '';
const server = mockServer((req, body, n) => {
  const url = new URL(req.url);
  if (url.pathname === '/v1/models') {
    const after = url.searchParams.get('after_id');
    return jsonResponse(
      after
        ? { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }], has_more: false }
        : { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1_000_000, max_tokens: 128_000 }], has_more: true, last_id: 'claude-opus-5-5' },
    );
  }
  if (url.pathname === '/v1/messages/count_tokens') return jsonResponse({ input_tokens: 1234 });
  const scenario = body?.metadata?.user_id ?? 'text';
  if (scenario === 'rate') {
    return jsonResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }, 429, { 'retry-after': '12' });
  }
  if (scenario === 'cache-split') {
    // the usage of a request whose cache writes used both lifetimes
    const usage = { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 } };
    return sseResponse([ev('message_start', { message: { id: 'msg_c', model: 'claude-sonnet-5-5', usage } }), ...textStream.slice(3)]);
  }
  if (scenario === 'midstream') {
    return sseResponse([textStream[0], ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })]);
  }
  if (scenario === 'tools') {
    wireLongName = body.tools[1].name;
    const items = toolStream.map((it) =>
      typeof it === 'object' && JSON.stringify(it.data).includes('PLACEHOLDER')
        ? ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: wireLongName, input: {} } })
        : it,
    );
    return sseResponse(items, { chunk: 5 });
  }
  void n;
  return sseResponse(textStream, {
    headers: {
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-requests-reset': '2026-10-16T08:01:00Z',
    },
  });
});
afterAll(() => server.stop());

function provider(extra: Partial<ProviderConfig> = {}, apiKey = 'sk-test'): AnthropicProvider {
  return new AnthropicProvider({ id: 'anthropic', config: { type: 'anthropic', baseUrl: server.url, ...extra }, apiKey, headers: { 'x-extra': '1' } });
}

const base = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'claude-sonnet-5-5',
  system: [{ text: 'You are helpful.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  ...over,
});

describe('AnthropicProvider streaming', () => {
  test('text, usage and rate limit headers', async () => {
    const events = await collect(provider().stream(base()));
    expect(events[0]).toEqual({ type: 'start', id: 'msg_1', model: 'claude-sonnet-5-5' });
    expect(events[1].type).toBe('rate_limit');
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text);
    expect(deltas).toEqual(['Hel', 'lo']);
    const done = doneOf(events);
    expect(done.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(done.stopReason).toBe('end_turn');
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 });

    const req = server.requests.at(-1)!;
    expect(req.path).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-test');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['x-extra']).toBe('1');
    expect(req.body.stream).toBe(true);
    expect(req.body.max_tokens).toBe(64_000);
  });

  test('cache writes split by lifetime: the 1 hour part is read from usage.cache_creation and priced at 2x input', async () => {
    const done = doneOf(await collect(provider().stream(base({ userId: 'cache-split' }))));
    expect(done.usage).toEqual({ inputTokens: 4, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 1000, cacheWrite1hTokens: 600 });
    const { computeCost } = await import('../../src/providers/catalog');
    // 4 x $2 + 7 x $10 + 400 x $2.50 + 600 x $4, per million
    expect(computeCost(lookupModel('anthropic', 'claude-sonnet-5-5'), done.usage)).toBeCloseTo((4 * 2 + 7 * 10 + 400 * 2.5 + 600 * 4) / 1e6, 12);
  });

  test('thinking with signature, parallel tool calls, shortened names, bad JSON', async () => {
    const tools = [
      { name: 'Read', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: longName, description: 'long', inputSchema: { type: 'object' } },
    ];
    const events = await collect(provider().stream(base({ tools, userId: 'tools' })));
    expect(wireLongName.length).toBeLessThanOrEqual(64);
    expect(wireLongName).not.toBe(longName);

    expect(events.filter((e) => e.type === 'thinking_delta')).toHaveLength(2);
    const starts = events.filter((e) => e.type === 'tool_use_start');
    expect(starts).toEqual([
      { type: 'tool_use_start', index: 1, id: 'toolu_1', name: 'Read' },
      { type: 'tool_use_start', index: 2, id: 'toolu_2', name: longName },
    ]);
    const done = doneOf(events);
    expect(done.stopReason).toBe('tool_use');
    expect(done.content[0]).toEqual({ type: 'thinking', thinking: 'Let me check.', signature: 'sig-abc' });
    expect(done.content[1]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } });
    const bad = done.content[2] as { type: 'tool_use'; input: Record<string, unknown> };
    expect(bad.input._raw).toBe('{"q": 1');
    expect(typeof bad.input._parseError).toBe('string');
    expect(done.usage).toEqual({ inputTokens: 20, outputTokens: 40 });
  });

  test('HTTP 429 becomes a classified ProviderError', async () => {
    const err = await expectReject(collect(provider().stream(base({ userId: 'rate' }))));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(12_000);
  });

  test('mid-stream error event', async () => {
    const err = await expectReject(collect(provider().stream(base({ userId: 'midstream' }))));
    expect(err.kind).toBe('overloaded');
  });

  test('bearer auth for auth-token configs', async () => {
    await collect(provider({ apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' }, 'tok').stream(base()));
    const req = server.requests.at(-1)!;
    expect(req.headers.authorization).toBe('Bearer tok');
    expect(req.headers['x-api-key']).toBeUndefined();
  });
});

describe('AnthropicProvider request mapping', () => {
  test('cache_control: last tool, cached system blocks, cached messages, newest 4 kept', () => {
    const body = provider().buildBody(
      base({
        tools: [
          { name: 'A', description: 'a', inputSchema: { type: 'object' } },
          { name: 'B', description: 'b', inputSchema: { type: 'object' } },
        ],
        system: [
          { text: 'stable', cache: true },
          { text: 'project', cache: true },
          { text: 'no cache' },
        ],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'one' }], cache: true },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'answer' },
              { type: 'thinking', thinking: 't', signature: 'sig' },
            ],
            cache: true,
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see results' },
              { type: 'tool_result', toolUseId: 'toolu.1', content: 'ok' },
            ],
            cache: true,
          },
        ],
      }),
    ) as any;
    const marked = (x: any) => x.cache_control?.type === 'ephemeral';
    // 6 candidates (tool, 2 system, 3 messages): the two oldest are dropped.
    expect(marked(body.tools[1])).toBe(false);
    expect(marked(body.system[0])).toBe(false);
    expect(marked(body.system[1])).toBe(true);
    expect(marked(body.system[2])).toBe(false);
    expect(marked(body.messages[0].content[0])).toBe(true);
    // Thinking blocks cannot carry cache_control: the text before it does.
    expect(marked(body.messages[1].content[0])).toBe(true);
    expect(marked(body.messages[1].content[1])).toBe(false);
    // Tool results lead the user turn, and the last block gets the breakpoint.
    expect(body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(marked(body.messages[2].content[1])).toBe(true);
    const all = JSON.stringify(body).match(/"cache_control"/g) ?? [];
    expect(all).toHaveLength(4);
  });

  test('cacheTtl goes on every breakpoint of a Claude request, and only there', () => {
    const req = (model: string, cacheTtl?: '5m' | '1h') =>
      provider().buildBody(
        base({ model, cacheTtl, tools: [{ name: 'A', description: 'a', inputSchema: { type: 'object' } }], system: [{ text: 's', cache: true }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], cache: true }] }),
      ) as any;
    const marks = (b: any) => [b.tools[0].cache_control, b.system[0].cache_control, b.messages[0].content[0].cache_control];
    expect(marks(req('claude-sonnet-5-5', '5m'))).toEqual(Array(3).fill({ type: 'ephemeral', ttl: '5m' }));
    expect(marks(req('claude-opus-5-5', '1h'))).toEqual(Array(3).fill({ type: 'ephemeral', ttl: '1h' }));
    expect(marks(req('claude-sonnet-5-5'))).toEqual(Array(3).fill({ type: 'ephemeral' }));
    // an Anthropic-compatible gateway serving another model gets the plain marker, and none on tools
    expect(marks(req('glm-5', '5m'))).toEqual([undefined, { type: 'ephemeral' }, { type: 'ephemeral' }]);
  });

  test('Z.ai: no cache_control on any tool for a GLM model (it keeps only the marked tool), a Claude model keeps the tools breakpoint', () => {
    const tools = ['Read', 'Bash', 'Glob', 'StructuredOutput', 'ToolSearch'].map((name) => ({ name, description: name, inputSchema: { type: 'object' as const } }));
    const zai = new AnthropicProvider({ id: 'zai', config: { type: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' }, apiKey: 'k' });
    const body = (model: string) =>
      zai.buildBody(base({ model, tools, system: [{ text: 's', cache: true }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], cache: true }] })) as any;
    const glm = body('glm-5.3');
    expect(glm.tools).toHaveLength(5);
    expect(glm.tools.some((t: any) => t.cache_control)).toBe(false);
    expect(glm.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(glm.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body('claude-sonnet-5-5').tools[4].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('two breakpoints keep both', () => {
    const body = provider().buildBody(
      base({ tools: [{ name: 'A', description: 'a', inputSchema: { type: 'object' } }], system: [{ text: 's', cache: true }] }),
    ) as any;
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].eager_input_streaming).toBeUndefined();
  });

  test('content blocks: images, documents, tool results with errors and images, foreign thinking dropped', () => {
    const body = provider().buildBody(
      base({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', mediaType: 'image/png', data: 'AAAA' },
              { type: 'image', mediaType: 'image/png', url: 'https://x/y.png' },
              { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', title: 'spec' },
              { type: 'document', mediaType: 'text/plain', data: Buffer.from('hello doc').toString('base64') },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'mine', signature: 'anthropic-sig' },
              { type: 'thinking', thinking: 'theirs', signature: tagSignature('openai-chat', 'gpt-5.5') },
              { type: 'thinking', thinking: 'unsigned' },
              { type: 'redacted_thinking', data: 'zzz' },
              { type: 'tool_use', id: 'call_1', name: 'Shot', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                toolUseId: 'call_1',
                isError: true,
                content: [
                  { type: 'text', text: 'failed' },
                  { type: 'image', mediaType: 'image/jpeg', data: 'BBBB' },
                ],
              },
            ],
          },
        ],
      }),
    ) as any;
    const [u, a, r] = body.messages;
    expect(u.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(u.content[1]).toEqual({ type: 'image', source: { type: 'url', url: 'https://x/y.png' } });
    expect(u.content[2]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'spec' });
    expect(u.content[3]).toEqual({ type: 'text', text: '<document name="document" type="text/plain">\nhello doc\n</document>' });
    expect(a.content.map((b: any) => b.type)).toEqual(['thinking', 'redacted_thinking', 'tool_use']);
    expect(a.content[0].signature).toBe('anthropic-sig');
    expect(r.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      is_error: true,
      content: [
        { type: 'text', text: 'failed' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
      ],
    });
  });

  test('responseSchema uses output_config on the first-party API only', () => {
    const native = new AnthropicProvider({ id: 'anthropic', config: { type: 'anthropic' }, apiKey: 'k' });
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect((native.buildBody(base({ responseSchema: schema })) as any).output_config.format).toEqual({ type: 'json_schema', schema });
    const gateway = provider().buildBody(base({ responseSchema: schema })) as any;
    expect(gateway.output_config).toBeUndefined();
    expect(gateway.system.at(-1).text).toContain('JSON');
  });

  test('stop sequences that are only whitespace are dropped (the API answers 400 to them)', () => {
    expect((provider().buildBody(base({ stopSequences: ['\n'] })) as any).stop_sequences).toBeUndefined();
    expect((provider().buildBody(base({ stopSequences: ['\n', 'END'] })) as any).stop_sequences).toEqual(['END']);
  });
});

describe('planAnthropicThinking', () => {
  const plan = (model: string, req: Partial<ChatRequest>, max = 64_000) =>
    planAnthropicThinking(model, base({ model, ...req }), lookupModel('anthropic', model, { type: 'anthropic' }), max);

  test('Claude 5 family: adaptive with summaries and effort, no sampling, no forced tool choice', () => {
    const p = plan('claude-opus-5-5', { thinking: { effort: 'high' } });
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(p.effort).toBe('high');
    expect(p.dropTemperature).toBe(true);
    expect(p.noForcedToolChoice).toBe(true);
    // Thinks by default, so summaries are requested even without req.thinking.
    expect(plan('claude-sonnet-5-5', {}).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(plan('claude-haiku-5-5', { thinking: { budgetTokens: 2000 } }).effort).toBe('low');
  });

  test('Opus 4.7: adaptive at its default effort with no level, disabled for Off', () => {
    expect(plan('claude-opus-4-7', {}).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(plan('claude-opus-4-7', {}).effort).toBeUndefined();
    expect(plan('claude-opus-4-7', { thinking: { effort: 'medium' } }).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    const off = plan('claude-opus-4-7', { thinking: { off: true } });
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.effort).toBeUndefined();
  });

  test('Effort request shapes per model (providers/effort.ts)', () => {
    const body = (model: string, thinking?: ChatRequest['thinking']) => provider().buildBody(base({ model, thinking })) as any;
    // Opus 5.5 at low: adaptive, output_config.effort low, no budget
    const low = body('claude-opus-5-5', { effort: 'low' });
    expect(low.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(low.output_config).toEqual({ effort: 'low' });
    // Opus 5.5 cannot stop thinking: Off is never disabled, it runs at its lowest level
    const opusOff = body('claude-opus-5-5', { off: true });
    expect(opusOff.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(opusOff.output_config).toEqual({ effort: 'low' });
    // Sonnet 5.5 Off: between_tools and nothing else, no effort (xhigh and max would be a 400)
    const sonnetOff = body('claude-sonnet-5-5', { off: true });
    expect(sonnetOff.thinking).toEqual({ type: 'between_tools' });
    expect(sonnetOff.output_config).toBeUndefined();
    // Opus 5 and Haiku 5.5 Off: disabled with no level (they take it only at high or below)
    for (const m of ['claude-opus-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
      const b = body(m, { off: true });
      expect(b.thinking).toEqual({ type: 'disabled' });
      expect(b.output_config).toBeUndefined();
    }
    // Opus 4.6 has no xhigh: it goes down to high; max stays
    expect(body('claude-opus-4-6', { effort: 'xhigh' }).output_config).toEqual({ effort: 'high' });
    expect(body('claude-opus-4-6', { effort: 'max' }).output_config).toEqual({ effort: 'max' });
    expect(body('claude-opus-4-6', { effort: 'max' }).thinking).toEqual({ type: 'adaptive' });
    // 4.6 Off leaves thinking out
    expect(body('claude-sonnet-4-6', { off: true }).thinking).toBeUndefined();
    // budget_tokens never reaches the adaptive models
    for (const m of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5']) {
      expect(JSON.stringify(body(m, { budgetTokens: 20_000 }))).not.toContain('budget_tokens');
    }
    // Haiku 4.5 keeps the budget; Off sends nothing
    expect(body('claude-haiku-4-5', { effort: 'low' }).thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(body('claude-haiku-4-5', { off: true }).thinking).toBeUndefined();
  });

  test('Sonnet 4.5 and gateways: enabled with budget below max_tokens', () => {
    const p = plan('claude-sonnet-4-5-20250929', { thinking: { budgetTokens: 2000 } });
    expect(p.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
    expect(p.dropTemperature).toBe(true);
    const tight = plan('claude-sonnet-4-5', { thinking: { budgetTokens: 10_000 } }, 4000);
    expect(tight.thinking).toEqual({ type: 'enabled', budget_tokens: 10_000 });
    expect(tight.maxTokens).toBe(18_192);
    expect(plan('glm-5', { thinking: { effort: 'low' } }).thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(plan('claude-sonnet-4-5', {}).thinking).toBeUndefined();
  });

  test('forced tool choice falls back to auto when thinking is on', () => {
    const tools = [{ name: 'A', description: 'a', inputSchema: { type: 'object' } }];
    const p = new AnthropicProvider({ id: 'anthropic', config: { type: 'anthropic' }, apiKey: 'k' });
    expect((p.buildBody(base({ model: 'claude-opus-5-5', tools, toolChoice: 'any', temperature: 0.2 })) as any).tool_choice).toEqual({ type: 'auto' });
    const old = p.buildBody(base({ model: 'claude-sonnet-4-5', tools, toolChoice: { name: 'A' }, temperature: 0.2 })) as any;
    expect(old.tool_choice).toEqual({ type: 'tool', name: 'A' });
    expect(old.temperature).toBe(0.2);
  });
});

describe('AnthropicProvider models and tokens', () => {
  test('listModels paginates and merges catalog data', async () => {
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    expect(models[0]).toMatchObject({ name: 'Claude Opus 5.5', contextWindow: 1_000_000, inputPrice: 4, ref: 'anthropic/claude-opus-5-5' });
    expect(server.requests.some((r) => r.path.includes('after_id=claude-opus-5-5'))).toBe(true);
  });

  test('configured models skip the endpoint', async () => {
    const models = await provider({ models: ['glm-5'] }).listModels();
    expect(models.map((m) => m.id)).toEqual(['glm-5']);
    expect(models[0].name).toBe('GLM-5');
  });

  test('countTokens', async () => {
    expect(await provider().countTokens(base())).toBe(1234);
    const req = server.requests.at(-1)!;
    expect(req.body.max_tokens).toBeUndefined();
    expect(req.body.stream).toBeUndefined();
  });
});
