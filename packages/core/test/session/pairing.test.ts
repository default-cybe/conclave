import { describe, expect, test } from 'bun:test';
import type { ContentBlock } from '../../src/types';
import type { ProviderMessage } from '../../src/providers/types';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { ProviderError } from '../../src/providers/types';
import { CONTINUE_NOTE, MISSING_RESULT, flattenLastToolTurn, guardTranscript, isTranscriptShapeError } from '../../src/session/pairing';
import { buildProviderMessages } from '../../src/session/transcript';
import type { Message } from '../../src/types';

const use = (id: string, name = 'Read'): ContentBlock => ({ type: 'tool_use', id, name, input: {} });
const res = (id: string, content = 'ok'): ContentBlock => ({ type: 'tool_result', toolUseId: id, content });
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const types = (m: ProviderMessage) => m.content.map((b) => (b.type === 'tool_use' ? `use:${b.id}` : b.type === 'tool_result' ? `res:${b.toolUseId}` : b.type));

describe('guardTranscript', () => {
  test('signed interleaved thinking keeps its exact block sequence when assistant messages merge', () => {
    const first = { type: 'thinking' as const, thinking: ' first\n\n', signature: 'signed-first' };
    const second = { type: 'thinking' as const, thinking: 'second\r\n', signature: 'signed-second' };
    const redacted = { type: 'redacted_thinking' as const, data: 'opaque-data' };
    const blocks = [first, use('a'), second, redacted, text('after thinking'), use('b')];
    const original = JSON.stringify(blocks);
    const input: ProviderMessage[] = [
      { role: 'user', content: [text('go')] },
      { role: 'assistant', content: blocks.slice(0, 2) },
      { role: 'assistant', content: blocks.slice(2) },
      { role: 'user', content: [res('a'), res('b')] },
    ];
    const guarded = guardTranscript(input);
    expect(JSON.stringify(guarded.messages[1].content)).toBe(original);
    expect(guardTranscript(guarded.messages).messages).toEqual(guarded.messages);
    expect(JSON.stringify(blocks)).toBe(original);
    const provider = new AnthropicProvider({ id: 'cliproxy', config: { type: 'anthropic' } });
    const body = provider.buildBody({ model: 'claude-opus-5-5', system: [], messages: guarded.messages });
    expect(JSON.stringify((body.messages as Array<{ content: unknown }>)[1].content)).toBe(original);
  });

  test('a valid transcript passes unchanged', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: [text('go')] },
      { role: 'assistant', content: [text('ok'), use('a'), use('b')] },
      { role: 'user', content: [res('a'), res('b')] },
    ];
    const g = guardTranscript(msgs);
    expect(g.repairs).toEqual([]);
    expect(g.messages).toEqual(msgs);
  });

  test('text after the calls moves in front of them', () => {
    const g = guardTranscript([
      { role: 'user', content: [text('go')] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, text('a'), use('a'), text('[x: {}]')] },
      { role: 'user', content: [res('a')] },
    ]);
    expect(types(g.messages[1])).toEqual(['thinking', 'text', 'text', 'use:a']);
  });

  test('a missing result gets an error result, results follow call order and lead the message', () => {
    const g = guardTranscript([
      { role: 'user', content: [text('go')] },
      { role: 'assistant', content: [use('a'), use('b'), use('c')] },
      { role: 'user', content: [text('note'), res('c'), res('a')] },
    ]);
    expect(types(g.messages[2])).toEqual(['res:a', 'res:b', 'res:c', 'text']);
    const b = g.messages[2].content[1] as { content: string; isError: boolean };
    expect(b.content).toBe(MISSING_RESULT);
    expect(b.isError).toBe(true);
  });

  test('a transcript that ends with calls gets their results; one that ends with text gets a user turn', () => {
    const calls = guardTranscript([{ role: 'user', content: [text('go')] }, { role: 'assistant', content: [use('a')] }]);
    expect(calls.messages.at(-1)!.role).toBe('user');
    expect(types(calls.messages.at(-1)!)).toEqual(['res:a']);
    const prose = guardTranscript([{ role: 'user', content: [text('go')] }, { role: 'assistant', content: [text('half')] }]);
    expect(prose.messages.at(-1)).toEqual({ role: 'user', content: [text(CONTINUE_NOTE)] });
  });

  test('stray and duplicate results become text; empty messages go; same roles merge; a user turn comes first', () => {
    const g = guardTranscript([
      { role: 'assistant', content: [text('hi')] },
      { role: 'user', content: [] },
      { role: 'user', content: [res('zzz'), text('q')] },
      { role: 'assistant', content: [use('a')] },
      { role: 'user', content: [res('a'), res('a', 'again')] },
    ]);
    expect(g.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(types(g.messages[2])).toEqual(['text', 'text']);
    expect(types(g.messages[4])).toEqual(['res:a', 'text']);
  });

  test('flattenLastToolTurn turns the last calls and their results into text and drops that turn\'s thinking', () => {
    const out = flattenLastToolTurn([
      { role: 'user', content: [text('go')] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, use('a')] },
      { role: 'user', content: [res('a', 'file body')] },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(types(out[1])).toEqual(['text']);
    expect((out[1].content[0] as { text: string }).text).toContain('[result: file body]');
    expect(out[2].content).toEqual([text(CONTINUE_NOTE)]);
  });

  test('shape errors are told apart from other 400s', () => {
    const e = (m: string) => new ProviderError('bad_request', m, { status: 400 });
    expect(isTranscriptShapeError(e('This model does not support assistant message prefill. The conversation must end with a user message.'))).toBe(true);
    expect(isTranscriptShapeError(e('messages.3: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_1'))).toBe(true);
    expect(isTranscriptShapeError(e('messages.4.content.0: unexpected `tool_use_id` found in `tool_result` blocks'))).toBe(true);
    expect(isTranscriptShapeError(e('max_tokens: must be at most 64000'))).toBe(false);
    expect(isTranscriptShapeError(new ProviderError('overloaded', 'prefill'))).toBe(false);
  });
});

describe('buildProviderMessages and calls the loop answered itself', () => {
  const msg = (role: 'user' | 'assistant', content: ContentBlock[], seq: number): Message =>
    ({ id: `m${seq}`, sessionId: 's', seq, role, kind: 'normal', content, createdAt: seq, model: 'mock/m' }) as Message;

  test('an unknown tool call stays a call with its result; a call to a tool not offered now becomes text in front of the calls', () => {
    const all = [
      msg('user', [text('go')], 1),
      msg('assistant', [text('doing'), use('a', 'Edit'), use('b', 'x'), use('c', 'Gone')], 2),
      msg('user', [
        { type: 'tool_result', toolUseId: 'a', content: 'edited' },
        { type: 'tool_result', toolUseId: 'b', content: 'Unknown tool: x', isError: true, meta: { unknownTool: true } },
        { type: 'tool_result', toolUseId: 'c', content: 'gone result' },
      ], 3),
    ];
    const out = buildProviderMessages(all, { modelRef: 'mock/m', toolNames: new Set(['Edit']), cache: false });
    expect(types(out[1])).toEqual(['text', 'text', 'use:a', 'use:b']);
    expect((out[1].content[1] as { text: string }).text).toContain('[Gone:');
    expect(types(out[2])).toEqual(['res:a', 'res:b']);
  });
});
