import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ApiError, ConclaveClient } from '@conclave/core/client/index.ts';
import type { Session } from '@conclave/core/types.ts';
import { OWNER, startHub, type TestHub } from './helpers';

let hub: TestHub;
let client: ConclaveClient;

beforeAll(() => {
  hub = startHub();
  client = new ConclaveClient({ baseUrl: hub.url, token: OWNER });
});
afterAll(() => hub.stop());

const status = (p: Promise<unknown>) => p.then(() => 200, (e: ApiError) => e.status);

describe('GET /api/sessions?kind', () => {
  test('passes kind to the engine and lists chats apart from agent sessions', async () => {
    const now = Date.now();
    const base: Session = {
      id: 'ses_chat1', title: 'Chat', agent: 'chat', model: 'anthropic/claude-sonnet-5-5', mode: 'agent', permissionMode: 'default', cwd: '/home/me', device: 'local',
      status: 'idle', tags: [], pinned: false, archived: false, createdAt: now, updatedAt: now,
      stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    };
    hub.engine.repos.sessions.insert({ ...base, kind: 'chat', chat: { webSearch: true, memory: false } });
    hub.engine.repos.sessions.insert({ ...base, id: 'ses_agent1', title: 'Agent', agent: 'coder' });

    const chats = await client.listSessions({ kind: 'chat' });
    expect(chats.map((s) => s.id)).toEqual(['ses_chat1']);
    expect(chats[0].chat).toEqual({ webSearch: true, memory: false });
    expect((await client.listSessions({ kind: 'agent' })).map((s) => s.id)).toEqual(['ses_agent1']);
    expect((await client.listSessions()).length).toBe(2);
    expect(hub.engine.calls.filter((c) => c.method === 'listSessions').map((c) => (c.args[0] as { kind?: string }).kind)).toEqual(['chat', 'agent', undefined]);
  });

  test('an unknown kind is a 400 that names the choices', async () => {
    expect(await status(client.request('GET', '/api/sessions', undefined, { kind: 'jury' }))).toBe(400);
  });
});
