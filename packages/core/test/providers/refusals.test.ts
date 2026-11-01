/**
 * Refusals the providers signal, each mapped to the stop reason "refusal"
 * that the refusal fallback (session/refusal-fallback.ts) walks on. Reply
 * text alone is never read as a refusal.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { OpenAIProvider } from '../../src/providers/openai';
import { OpenAIResponsesProvider } from '../../src/providers/openai-responses';
import { GeminiProvider } from '../../src/providers/gemini';
import type { ChatRequest } from '../../src/providers/types';
import { collect, doneOf, mockServer, sseResponse, type SseItem } from './mock';

/** The scenario name is the last user message's text. */
const ask = (scenario: string, model: string): ChatRequest => ({ model, system: [], messages: [{ role: 'user', content: [{ type: 'text', text: scenario }] }] });

function scenarioOf(body: any): string {
  if (Array.isArray(body?.messages)) {
    const c = body.messages.at(-1)?.content;
    return typeof c === 'string' ? c : (c?.[0]?.text ?? '');
  }
  if (Array.isArray(body?.input)) {
    const c = body.input.at(-1)?.content;
    return typeof c === 'string' ? c : (c?.[0]?.text ?? '');
  }
  return body?.contents?.at(-1)?.parts?.[0]?.text ?? '';
}

// ----- Anthropic: stop_reason refusal (and Z.ai's sensitive on its Anthropic endpoint) -----

const anthropicEvents = (stop: string, text = 'I can not help with that.'): SseItem[] => [
  { event: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 0 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop, stop_details: { category: 'cyber' } }, usage: { output_tokens: 3 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

// ----- OpenAI Chat Completions: refusal content, content_filter; Z.ai: sensitive -----

const chunk = (delta: Record<string, unknown>, finish: string | null = null): SseItem => ({ data: { id: 'c1', model: 'x', choices: [{ index: 0, delta, finish_reason: finish }] } });
const chatScenarios: Record<string, SseItem[]> = {
  'refusal-field': [chunk({ role: 'assistant', refusal: "I'm sorry, " }), chunk({ refusal: 'I can not help.' }), chunk({}, 'stop'), 'data: [DONE]\n\n'],
  'content-filter': [chunk({ content: 'Partial' }), chunk({}, 'content_filter'), 'data: [DONE]\n\n'],
  sensitive: [chunk({ content: '' }), chunk({}, 'sensitive'), 'data: [DONE]\n\n'],
  // text that reads like a refusal but ends normally is an answer
  'says-sorry': [chunk({ content: "I'm sorry, but I can't help with that." }), chunk({}, 'stop'), 'data: [DONE]\n\n'],
};

// ----- OpenAI Responses: refusal deltas, a refusal part, content_filter -----

const resp = (type: string, extra: Record<string, unknown> = {}): SseItem => ({ data: { type, ...extra } });
const responsesScenarios: Record<string, SseItem[]> = {
  'refusal-delta': [
    resp('response.created', { response: { id: 'r1', model: 'gpt-5.5' } }),
    resp('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg1' } }),
    resp('response.refusal.delta', { item_id: 'msg1', output_index: 0, delta: 'No.' }),
    resp('response.completed', { response: { usage: { input_tokens: 2, output_tokens: 1 } } }),
  ],
  'refusal-part': [
    resp('response.created', { response: { id: 'r1', model: 'gpt-5.5' } }),
    resp('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg1' } }),
    resp('response.output_item.done', { output_index: 0, item: { type: 'message', id: 'msg1', content: [{ type: 'refusal', refusal: 'I will not do that.' }] } }),
    resp('response.completed', { response: { usage: { input_tokens: 2, output_tokens: 1 } } }),
  ],
  filtered: [
    resp('response.created', { response: { id: 'r1', model: 'gpt-5.5' } }),
    resp('response.incomplete', { response: { incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 2, output_tokens: 1 } } }),
  ],
};

// ----- Gemini: finishReason SAFETY and the like, promptFeedback.blockReason -----

const geminiScenarios: Record<string, SseItem[]> = {
  safety: [{ data: { candidates: [{ content: { parts: [{ text: 'Part' }] }, finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } } }],
  prohibited: [{ data: { candidates: [{ content: { parts: [] }, finishReason: 'PROHIBITED_CONTENT' }] } }],
  blocked: [{ data: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 3 } } }],
  normal: [{ data: { candidates: [{ content: { parts: [{ text: 'Sorry, I cannot.' }] }, finishReason: 'STOP' }] } }],
};

const server = mockServer((req, body) => {
  const path = new URL(req.url).pathname;
  const s = scenarioOf(body);
  if (path.endsWith('/v1/messages')) return sseResponse(anthropicEvents(s === 'sensitive' ? 'sensitive' : s === 'refusal' ? 'refusal' : 'end_turn'));
  if (path.endsWith('/responses')) return sseResponse(responsesScenarios[s]);
  if (path.endsWith('/chat/completions')) return sseResponse(chatScenarios[s]);
  return sseResponse(geminiScenarios[s]);
});
afterAll(() => server.stop());

const anthropic = () => new AnthropicProvider({ id: 'anthropic', config: { type: 'anthropic', baseUrl: server.url }, apiKey: 'k' });
const chat = () => new OpenAIProvider({ id: 'zai', config: { type: 'openai', baseUrl: `${server.url}/v1` }, apiKey: 'k' });
const responses = () => new OpenAIResponsesProvider({ id: 'openai', config: { type: 'openai', baseUrl: `${server.url}/v1`, responsesApi: true }, apiKey: 'k' });
const gemini = () => new GeminiProvider({ id: 'google', config: { type: 'gemini', baseUrl: server.url }, apiKey: 'k' });

describe('provider refusals map to stop reason refusal', () => {
  test('Anthropic: stop_reason refusal; Z.ai sensitive on its Anthropic endpoint; a normal end stays end_turn', async () => {
    expect(doneOf(await collect(anthropic().stream(ask('refusal', 'claude-opus-5-5')))).stopReason).toBe('refusal');
    expect(doneOf(await collect(anthropic().stream(ask('sensitive', 'glm-5.3')))).stopReason).toBe('refusal');
    expect(doneOf(await collect(anthropic().stream(ask('fine', 'claude-opus-5-5')))).stopReason).toBe('end_turn');
  });

  test('OpenAI Chat: the refusal field (shown as text), content_filter, and Z.ai sensitive; sorry-text alone is an answer', async () => {
    const r = doneOf(await collect(chat().stream(ask('refusal-field', 'gpt-5.5'))));
    expect(r.stopReason).toBe('refusal');
    expect(r.content).toEqual([{ type: 'text', text: "I'm sorry, I can not help." }]);
    expect(doneOf(await collect(chat().stream(ask('content-filter', 'gpt-5.5')))).stopReason).toBe('refusal');
    expect(doneOf(await collect(chat().stream(ask('sensitive', 'glm-5.3')))).stopReason).toBe('refusal');
    expect(doneOf(await collect(chat().stream(ask('says-sorry', 'gpt-5.5')))).stopReason).toBe('end_turn');
  });

  test('OpenAI Responses: refusal deltas, a refusal part with no deltas, and content_filter', async () => {
    expect(doneOf(await collect(responses().stream(ask('refusal-delta', 'gpt-5.5')))).stopReason).toBe('refusal');
    const part = doneOf(await collect(responses().stream(ask('refusal-part', 'gpt-5.5'))));
    expect(part.stopReason).toBe('refusal');
    expect(part.content[0]).toEqual({ type: 'text', text: 'I will not do that.' });
    expect(doneOf(await collect(responses().stream(ask('filtered', 'gpt-5.5')))).stopReason).toBe('refusal');
  });

  test('Gemini: finishReason SAFETY and PROHIBITED_CONTENT, and a blocked prompt; STOP with sorry-text is an answer', async () => {
    expect(doneOf(await collect(gemini().stream(ask('safety', 'gemini-3.1-pro-preview')))).stopReason).toBe('refusal');
    expect(doneOf(await collect(gemini().stream(ask('prohibited', 'gemini-3.1-pro-preview')))).stopReason).toBe('refusal');
    expect(doneOf(await collect(gemini().stream(ask('blocked', 'gemini-3.1-pro-preview')))).stopReason).toBe('refusal');
    expect(doneOf(await collect(gemini().stream(ask('normal', 'gemini-3.1-pro-preview')))).stopReason).toBe('end_turn');
  });
});
