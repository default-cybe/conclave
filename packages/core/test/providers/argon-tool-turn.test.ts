import { describe, expect, test } from 'bun:test';
import { classifyHttpError } from '../../src/providers/errors';
import { GeminiProvider } from '../../src/providers/gemini';
import { OpenAIProvider } from '../../src/providers/openai';
import type { ChatRequest, ProviderMessage } from '../../src/providers/types';

// the shape of the three builders that died on 2026-11-02 (wfr_0mvyt11cdf0bfwxi4w6): after a usage-limit
// fallback to Gemini 4 Argon on Antigravity, a long tool loop whose last user turn held only tool results
const messages: ProviderMessage[] = [
  { role: 'user', content: [{ type: 'text', text: '<conversation_summary>...</conversation_summary>' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'Read-1-1', name: 'Read', input: { file_path: '/a.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 'Read-1-1', content: 'one' }, { type: 'text', text: '<system-reminder>\nrules\n</system-reminder>' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'Edit-2-1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } },
      { type: 'tool_use', id: 'Edit-2-2', name: 'Edit', input: { file_path: '/a.ts', old_string: 'c', new_string: 'd' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', toolUseId: 'Edit-2-1', content: 'updated' },
      { type: 'tool_result', toolUseId: 'Edit-2-2', content: 'updated' },
    ],
  },
];
const req = (model: string): ChatRequest => ({ model, system: [{ text: 'sys' }], messages, tools: [{ name: 'Read', description: 'r', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } }] }) as ChatRequest;

describe('Gemini 4 Argon tool-result turns', () => {
  test('Chat Completions (an account-prefixed id): a turn of only tool results ends with a text naming the tools', () => {
    const p = new OpenAIProvider({ id: 'cliproxy', config: { type: 'openai', baseUrl: 'http://127.0.0.1:8317/v1' } });
    const body = p.buildBody(req('backup-gemini2/gemini-4-argon-high')) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(body.messages.at(-1)!.content).toBe('Edit\nEdit');
    // the turn that already has text gets no label
    expect(body.messages[4].content).toBe('<system-reminder>\nrules\n</system-reminder>');
  });

  test('native Gemini wire: the label joins the functionResponse turn', () => {
    const p = new GeminiProvider({ id: 'cliproxy', config: { type: 'gemini', baseUrl: 'http://127.0.0.1:8317' } });
    const body = p.buildBody(req('gemini-4-argon-high')) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    const last = body.contents.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.parts.map((x) => Object.keys(x)[0])).toEqual(['functionResponse', 'functionResponse', 'text']);
    expect(last.parts[2].text).toBe('Edit\nEdit');
  });

  test('other models are sent as before', () => {
    const chat = new OpenAIProvider({ id: 'cliproxy', config: { type: 'openai', baseUrl: 'http://127.0.0.1:8317/v1' } }).buildBody(req('gemini-3.8-flash')) as { messages: Array<{ role: string }> };
    expect(chat.messages.at(-1)!.role).toBe('tool');
    const native = new GeminiProvider({ id: 'g', config: { type: 'gemini' } }).buildBody(req('gemini-3.8-flash')) as { contents: Array<{ parts: unknown[] }> };
    expect(native.contents.at(-1)!.parts).toHaveLength(2);
  });
});

describe('a 400 names the rejected field', () => {
  test("Google's fieldViolations", () => {
    const body = JSON.stringify({
      error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'contents[12].parts[1]', description: 'x' }] }] },
    });
    expect(classifyHttpError('cliproxy', 400, {}, body).message).toBe('cliproxy 400 400: Request contains an invalid argument. (rejected field: contents[12].parts[1])');
  });

  test("OpenAI's param, left out when the message already says it", () => {
    const e = classifyHttpError('openai', 400, {}, JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid value.', param: 'input[3].content[0].image_url' } }));
    expect(e.message).toBe('openai 400 invalid_request_error: Invalid value. (rejected field: input[3].content[0].image_url)');
    const same = classifyHttpError('openai', 400, {}, JSON.stringify({ error: { type: 'invalid_request_error', message: "Invalid 'tools[0].name'.", param: 'tools[0].name' } }));
    expect(same.message).toBe("openai 400 invalid_request_error: Invalid 'tools[0].name'.");
    expect(classifyHttpError('x', 400, {}, JSON.stringify({ error: { message: 'bad', param: '' } })).message).toBe('x 400: bad');
  });
});
