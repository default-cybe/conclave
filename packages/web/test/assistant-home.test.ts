/**
 * The assistant is one thread (features/conversation/actions.ts
 * sendToAssistant): Home's composer in Assistant mode, Plan my day and Goals
 * send into GET /api/assistant/home and never start a session.
 *
 *   cd packages/web && bun test test/assistant-home.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import type { SendInput } from '@conclave/core/client';
import { api, connectClient } from '../src/lib/api';
import { sendToAssistant } from '../src/features/conversation/actions';
import { sessionOptions } from '../src/features/routines/RoutineEditor';

const home = { id: 'ses_home', agent: 'assistant', title: 'Assistant', pinned: true, meta: { home: true }, updatedAt: 1 } as unknown as Session;

describe('sendToAssistant', () => {
  test('every message goes into the home thread; no session is made', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    const sent: Array<[string, SendInput]> = [];
    let created = 0;
    Object.assign(api(), {
      assistantHome: async () => home,
      send: async (id: string, input: SendInput) => (sent.push([id, input]), { queued: false }),
      createSession: async () => (created++, home),
    });
    expect((await sendToAssistant({ text: 'Plan my day.' }))?.id).toBe('ses_home');
    expect((await sendToAssistant({ text: 'And tomorrow?', attachments: [] }))?.id).toBe('ses_home');
    expect(sent.map(([id, i]) => [id, i.text])).toEqual([
      ['ses_home', 'Plan my day.'],
      ['ses_home', 'And tomorrow?'],
    ]);
    expect(created).toBe(0);
  });

  test("a model picked on Home switches the thread's model first; the same model changes nothing", async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    const calls: string[] = [];
    Object.assign(api(), {
      assistantHome: async () => ({ ...home, model: 'anthropic/claude-sonnet-5-5' }),
      updateSession: async (id: string, patch: { model?: string }) => (calls.push(`update ${id} ${JSON.stringify(patch)}`), { ...home, model: patch.model, updatedAt: 2 }),
      send: async (id: string) => (calls.push(`send ${id}`), { queued: false }),
    });
    const s = await sendToAssistant({ text: 'hi' }, { model: 'openai/gpt-5.5' });
    expect(s?.model).toBe('openai/gpt-5.5');
    expect(calls).toEqual(['update ses_home {"model":"openai/gpt-5.5"}', 'send ses_home']);
    calls.length = 0;
    await sendToAssistant({ text: 'hi' }, { model: 'anthropic/claude-sonnet-5-5' });
    await sendToAssistant({ text: 'hi' });
    expect(calls).toEqual(['send ses_home', 'send ses_home']);
  });

  test('a refused send says so and opens nothing', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    Object.assign(api(), { assistantHome: async () => home, send: async () => Promise.reject(new Error('The hub is busy.')) });
    expect(await sendToAssistant({ text: 'hi' })).toBeUndefined();
  });
});

describe('the routine editor', () => {
  test('offers Post into the Assistant chat, except for a watch (save refuses it there)', () => {
    expect(sessionOptions({}).map((o) => o.value)).toEqual(['new', 'reuse', 'home']);
    expect(sessionOptions({}).at(-1)?.label).toBe('Post into the Assistant chat');
    expect(sessionOptions({ watch: { url: 'https://example.com' } as never }).map((o) => o.value)).toEqual(['new', 'reuse']);
  });
});
