/**
 * Cyber access programs on ChatGPT plan models (providers/access-programs.ts):
 * the choices per model, the Responses wire that carries them through
 * CLIProxyAPI, the program that served, ChatGPT's errors in words, and the
 * retiring Daybreak aliases.
 *
 *   bun test packages/core/test/providers/access-programs.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { ProviderRegistry } from '../../src/providers/registry';
import { accessProgramError, cyberChoices, retiredAlias, servedNotice } from '../../src/providers/access-programs';
import { classifyHttpError } from '../../src/providers/errors';
import { mergeChatSettings } from '../../src/session/chat';
import { jsonResponse, mockServer, sseResponse } from './mock';

const server = mockServer((req) => {
  const url = new URL(req.url);
  if (url.pathname === '/v1/models') return jsonResponse({ object: 'list', data: [{ id: 'gpt-6-sol' }] });
  if (url.pathname === '/v1/responses')
    return sseResponse([
      { data: { type: 'response.created', response: { id: 'r1', model: 'gpt-6-sol' } } },
      { data: { type: 'response.output_text.delta', output_index: 0, delta: 'hi' } },
      // an account without Blue approval is served standard
      { data: { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 }, access_programs: { cyber: 'standard' } } } },
    ]);
  return sseResponse([{ data: { id: 'c1', choices: [{ index: 0, delta: { content: 'from chat' }, finish_reason: 'stop' }] } }, 'data: [DONE]\n\n']);
});
const home = mkdtempSync(join(tmpdir(), 'conclave-cyber-'));
const config = new ConfigStore(home);
const registry = new ProviderRegistry(config);
config.setRuntime({ providers: { cliproxy: { type: 'openai', subscription: 'cliproxy', baseUrl: `${server.url}/v1`, apiKey: 'k', enabled: true, models: ['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-cyber', 'claude-opus-5-5'], anthropicWire: { baseUrl: server.url, models: ['claude-*'] } } } } as any, 'cliproxy');

afterAll(() => {
  registry.dispose();
  server.stop();
  rmSync(home, { recursive: true, force: true });
});

const req = (model: string, accessPrograms?: { cyber: 'standard' | 'daybreak_blue' | 'daybreak_red' }) => ({ model, system: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], maxTokens: 16, ...(accessPrograms ? { accessPrograms } : {}) });

describe('cyber access', () => {
  test("the doc's table: Blue on GPT-6 Sol, 6.1 Sol and 6 Astra, Red only on gpt-5.6-cyber, Standard on other GPT models, nothing elsewhere", () => {
    expect(cyberChoices('gpt-6-sol')).toEqual(['standard', 'daybreak_blue']);
    expect(cyberChoices('neu/gpt-6.1-sol')).toEqual(['standard', 'daybreak_blue']);
    expect(cyberChoices('gpt-6-astra')).toEqual(['standard', 'daybreak_blue']);
    expect(cyberChoices('gpt-5.6-cyber')).toEqual(['daybreak_red']);
    expect(cyberChoices('gpt-5.6-sol')).toEqual(['standard']);
    expect(cyberChoices('gpt-image-2')).toEqual([]);
    expect(cyberChoices('claude-opus-5-5')).toEqual([]);
  });

  test('the plan model offers the choice; a Claude model on the same gateway does not', () => {
    expect(registry.resolveAt('cliproxy', 'gpt-6-sol').info.cyber).toEqual(['standard', 'daybreak_blue']);
    expect(registry.resolveAt('cliproxy', 'claude-opus-5-5').info.cyber).toBeUndefined();
  });

  test('with a program the call goes over /v1/responses with access_programs, and the served one comes back; without, Chat Completions and no field', async () => {
    const p = registry.get('cliproxy')!;
    server.requests.length = 0;
    let done: any;
    for await (const ev of p.stream(req('gpt-6-sol', { cyber: 'daybreak_blue' }))) if (ev.type === 'done') done = ev;
    expect(server.requests.at(-1)!.path).toBe('/v1/responses');
    expect(server.requests.at(-1)!.body.access_programs).toEqual({ cyber: 'daybreak_blue' });
    expect(done.accessPrograms).toEqual({ cyber: 'standard' });
    for await (const _ of p.stream(req('gpt-6-sol'))) void _;
    expect(server.requests.at(-1)!.path).toBe('/v1/chat/completions');
    expect(server.requests.at(-1)!.body.access_programs).toBeUndefined();
    expect(servedNotice('daybreak_blue', 'standard')).toContain('Daybreak Blue was asked for');
  });

  test("ChatGPT's three errors read as what to do, and are the request's fault, not the account's", () => {
    const e403 = classifyHttpError('cliproxy', 403, undefined, JSON.stringify({ error: { code: 'access_program_not_enabled', message: 'not enabled' } }));
    expect(e403.kind).toBe('bad_request');
    expect(e403.message).toContain('not approved for that Cyber access program');
    expect(classifyHttpError('cliproxy', 400, undefined, JSON.stringify({ error: { code: 'unsupported_access_program', message: 'x' } })).message).toContain('does not take the Cyber access program');
    expect(classifyHttpError('cliproxy', 400, undefined, JSON.stringify({ error: { code: 'invalid_access_program', message: 'bogus_value' } })).message).toContain('bogus_value');
    expect(accessProgramError(undefined, 'The requested Cyber access program is not authorized for this model.')).toContain('does not take');
    expect(accessProgramError('rate_limit_exceeded', 'slow down')).toBeUndefined();
  });

  test('a saved ref to a retiring alias runs on its named model; the session setting is checked', () => {
    expect(retiredAlias('gpt-daybreak-blue-latest')).toEqual({ model: 'gpt-5.6-sol', cyber: 'daybreak_blue' });
    expect(registry.resolve('cliproxy/gpt-daybreak-red-latest')).toMatchObject({ provider: 'cliproxy', model: 'gpt-5.6-cyber' });
    expect(registry.resolve('cliproxy/gpt-daybreak-blue-latest')).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(mergeChatSettings(undefined, { cyber: 'daybreak_blue' }).cyber).toBe('daybreak_blue');
    expect(mergeChatSettings({ webSearch: true, memory: true, cyber: 'standard' }, { cyber: null }).cyber).toBeUndefined();
    expect(() => mergeChatSettings(undefined, { cyber: 'daybreak' })).toThrow('chat.cyber must be');
  });
});
