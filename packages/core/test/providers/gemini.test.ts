import { afterAll, describe, expect, test } from 'bun:test';
import { GeminiProvider, geminiThinkingConfig, sanitizeGeminiSchema } from '../../src/providers/gemini';
import { lookupModel } from '../../src/providers/catalog';
import { readSignature } from '../../src/providers/signatures';
import type { ContentBlock } from '../../src/types';
import type { ChatRequest } from '../../src/providers/types';
import { collect, doneOf, expectReject, jsonResponse, mockServer, sseResponse, type SseItem } from './mock';

const turn: SseItem[] = [
  {
    data: {
      responseId: 'r1',
      modelVersion: 'gemini-3.1-pro-preview',
      candidates: [{ content: { role: 'model', parts: [{ text: 'Considering the ', thought: true }] } }],
    },
  },
  { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'files.', thought: true }] } }] } },
  { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'I will read ' }] } }] } },
  { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'both.' }] } }] } },
  {
    data: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'Read', args: { path: 'a.ts' } }, thoughtSignature: 'SIG_A' },
              { functionCall: { name: 'Read', args: { path: 'b.ts' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 15, thoughtsTokenCount: 40, totalTokenCount: 175 },
    },
  },
];

const server = mockServer((req, body) => {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    return jsonResponse({
      models: [
        { name: 'models/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      ],
    });
  }
  if (url.pathname.endsWith(':batchEmbedContents')) return jsonResponse({ embeddings: body.requests.map((_: unknown, i: number) => ({ values: [i] })) });
  if (url.pathname.endsWith(':countTokens')) return jsonResponse({ totalTokens: 77 });
  const lastText = JSON.stringify(body.contents.at(-1));
  if (lastText.includes('limit')) {
    return jsonResponse(
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Resource has been exhausted',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }],
        },
      },
      429,
    );
  }
  if (lastText.includes('signed text')) {
    return sseResponse([
      { data: { candidates: [{ content: { parts: [{ text: 'Answer ', thoughtSignature: 'SIG_T' }] } }] } },
      { data: { candidates: [{ content: { parts: [{ text: 'done.' }] } }] } },
      { data: { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'SIG_END' }] }, finishReason: 'MAX_TOKENS' }] } },
    ]);
  }
  return sseResponse(turn, { chunk: 13 });
});
afterAll(() => server.stop());

const provider = () => new GeminiProvider({ id: 'google', config: { type: 'gemini', baseUrl: server.url }, apiKey: 'g-key' });
const ask = (text: string, over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'gemini-3.1-pro-preview',
  system: [{ text: 'Be precise.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  tools: [{ name: 'Read', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  ...over,
});

describe('GeminiProvider streaming', () => {
  let first: ContentBlock[] = [];

  test('thoughts, text, function calls with signature, usage', async () => {
    const events = await collect(provider().stream(ask('go', { thinking: { effort: 'high' }, maxTokens: 900 })));
    expect(events[0]).toEqual({ type: 'start', id: 'r1', model: 'gemini-3.1-pro-preview' });
    const done = doneOf(events);
    first = done.content;
    expect(done.content.map((b) => b.type)).toEqual(['thinking', 'text', 'thinking', 'tool_use', 'tool_use']);
    expect(done.content[0]).toEqual({ type: 'thinking', thinking: 'Considering the files.' });
    expect(done.content[1]).toEqual({ type: 'text', text: 'I will read both.' });
    expect(readSignature((done.content[2] as any).signature)).toEqual({ kind: 'gemini', model: 'gemini-3.1-pro-preview', payload: 'next:SIG_A' });
    expect(done.content[3]).toMatchObject({ type: 'tool_use', name: 'Read', input: { path: 'a.ts' } });
    expect(done.content[4]).toMatchObject({ type: 'tool_use', name: 'Read', input: { path: 'b.ts' } });
    expect((done.content[3] as any).id).not.toBe((done.content[4] as any).id);
    expect(done.stopReason).toBe('tool_use');
    expect(done.usage).toEqual({ inputTokens: 20, outputTokens: 55, cacheReadTokens: 100, reasoningTokens: 40 });

    const req = server.requests.at(-1)!;
    expect(req.path).toBe('/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse');
    expect(req.headers['x-goog-api-key']).toBe('g-key');
    expect(req.body.systemInstruction).toEqual({ parts: [{ text: 'Be precise.' }] });
    expect(req.body.generationConfig).toEqual({ maxOutputTokens: 900, thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } });
    expect(req.body.tools[0].functionDeclarations[0]).toEqual({
      name: 'Read',
      description: 'read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    });
  });

  test('replays signatures for the same model and pairs function responses by name', () => {
    const history = (model: string): ChatRequest =>
      ask('next', {
        model,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: first },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: (first[3] as any).id, content: 'A body' },
              { type: 'tool_result', toolUseId: (first[4] as any).id, content: 'missing', isError: true },
            ],
          },
        ],
      });
    const body = provider().buildBody(history('gemini-3.1-pro-preview')) as any;
    const model = body.contents[1];
    expect(model.role).toBe('model');
    expect(model.parts).toEqual([
      { text: 'I will read both.' },
      { functionCall: { name: 'Read', args: { path: 'a.ts' } }, thoughtSignature: 'SIG_A' },
      { functionCall: { name: 'Read', args: { path: 'b.ts' } } },
    ]);
    expect(body.contents[2].parts).toEqual([
      { functionResponse: { name: 'Read', response: { output: 'A body' } } },
      { functionResponse: { name: 'Read', response: { error: 'missing' } } },
    ]);

    // Another Gemini 3 model cannot use these signatures: the first call gets the skip value.
    const other = provider().buildBody(history('gemini-3-flash-preview')) as any;
    expect(other.contents[1].parts[1].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(other.contents[1].parts[2].thoughtSignature).toBeUndefined();
  });

  test('text part signatures round trip as next and prev', async () => {
    const done = doneOf(await collect(provider().stream(ask('signed text'))));
    expect(done.stopReason).toBe('max_tokens');
    expect(done.content.map((b) => b.type)).toEqual(['thinking', 'text', 'thinking']);
    const body = provider().buildBody(
      ask('again', {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          { role: 'assistant', content: done.content },
          { role: 'user', content: [{ type: 'text', text: 'again' }] },
        ],
      }),
    ) as any;
    // The leading signature rides on the text; the trailing one comes back as its own empty part, as Gemini sent it.
    expect(body.contents[1].parts).toEqual([
      { text: 'Answer done.', thoughtSignature: 'SIG_T' },
      { text: '', thoughtSignature: 'SIG_END' },
    ]);
  });

  test('429 RetryInfo', async () => {
    const err = await expectReject(collect(provider().stream(ask('limit'))));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(12_000);
  });

  test('tool choice by name', () => {
    const body = provider().buildBody(ask('x', { toolChoice: { name: 'Read' } })) as any;
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['Read'] } });
  });
});

describe('Gemini helpers', () => {
  test('schema sanitizing', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      $defs: { Point: { type: 'object', properties: { x: { type: 'number', default: 0 } }, required: ['x'] } },
      properties: {
        name: { type: ['string', 'null'], description: 'n', examples: ['a'] },
        mode: { enum: ['fast', 'slow', null] },
        count: { type: 'integer', enum: [1, 2] },
        at: { type: 'string', format: 'date-time' },
        url: { type: 'string', format: 'uri' },
        point: { $ref: '#/$defs/Point' },
        maybe: { anyOf: [{ $ref: '#/$defs/Point' }, { type: 'null' }] },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        tags: { type: 'array' },
        fixed: { const: 'v1' },
        node: { $ref: '#/$defs/Node' },
      },
      required: ['name', 'ghost'],
    };
    expect(sanitizeGeminiSchema(schema as any)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'n', nullable: true },
        mode: { type: 'string', enum: ['fast', 'slow'], nullable: true },
        count: { type: 'string', enum: ['1', '2'] },
        at: { type: 'string', format: 'date-time' },
        url: { type: 'string' },
        point: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
        maybe: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], nullable: true },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        tags: { type: 'array', items: { type: 'string' } },
        fixed: { type: 'string', enum: ['v1'] },
        node: { type: 'object' },
      },
      required: ['name'],
    });
  });

  test('recursive refs stop instead of looping', () => {
    const schema = { type: 'object', $defs: { T: { type: 'object', properties: { child: { $ref: '#/$defs/T' } } } }, properties: { root: { $ref: '#/$defs/T' } } };
    const out = sanitizeGeminiSchema(schema as any) as any;
    expect(out.properties.root.properties.child).toEqual({ type: 'object' });
  });

  test('thinking config by generation', () => {
    const req = (t: ChatRequest['thinking']) => ({ ...ask('x'), thinking: t });
    expect(geminiThinkingConfig('gemini-2.5-flash', req({ budgetTokens: 2048 }), lookupModel('g', 'gemini-2.5-flash'))).toEqual({
      includeThoughts: true,
      thinkingBudget: 2048,
    });
    expect(geminiThinkingConfig('gemini-3.1-pro-preview', req({ effort: 'medium' }), lookupModel('g', 'gemini-3.1-pro-preview'))).toEqual({
      includeThoughts: true,
      thinkingLevel: 'high',
    });
    expect(geminiThinkingConfig('gemini-3-flash-preview', req({ effort: 'medium' }), lookupModel('g', 'gemini-3-flash-preview'))).toEqual({
      includeThoughts: true,
      thinkingLevel: 'medium',
    });
  });

  test('thinking off on Gemini 3 asks for the least thinking the model takes; 2.5 and no thinking field are unchanged', () => {
    const off = { ...ask('x'), thinking: { off: true } } as ChatRequest;
    const cfg = (id: string, r: ChatRequest = off) => geminiThinkingConfig(id, r, lookupModel('g', id));
    expect(cfg('gemini-3.1-flash-lite')).toEqual({ thinkingLevel: 'minimal' });
    expect(cfg('gemini-3-flash-preview')).toEqual({ thinkingLevel: 'minimal' });
    expect(cfg('gemini-3-pro')).toEqual({ thinkingLevel: 'low' });
    expect(cfg('gemini-3.1-pro-preview')).toEqual({ thinkingLevel: 'low' });
    // 3.8 Flash refuses minimal with a 400
    expect(cfg('gemini-3.8-flash')).toEqual({ thinkingLevel: 'low' });
    expect(cfg('gemini-2.5-flash')).toEqual({ includeThoughts: true });
    expect(cfg('gemini-3.1-flash-lite', ask('x'))).toEqual({ includeThoughts: true });
  });

  test('listModels, embed, countTokens', async () => {
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-3.1-pro-preview']);
    expect(models[0]).toMatchObject({ contextWindow: 1048576, inputPrice: 2 });
    expect(await provider().embed(['a', 'b'])).toEqual([[0], [1]]);
    expect(server.requests.at(-1)!.path).toBe('/v1beta/models/gemini-embedding-001:batchEmbedContents');
    expect(await provider().countTokens(ask('x'))).toBe(77);
  });
});
