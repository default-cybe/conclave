import { afterEach, describe, expect, test } from 'bun:test';
import { startTestEngine, until, type TestEngine } from './harness';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('rewind', () => {
  test('keeps messages up to and including the seq it is given', async () => {
    t = await startTestEngine({ script: [[{ text: 'first answer' }], [{ text: 'second answer' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'one');
    await t.run(chat.id, 'two');
    const all = engine.getMessages(chat.id);
    const second = all.filter((m) => m.role === 'user').at(-1)!;

    // Edit and Retry drop the message itself: the clients send seq - 1
    await engine.rewind(chat.id, second.seq - 1);
    const left = engine.getMessages(chat.id);
    expect(left.map((m) => m.seq)).toEqual(all.filter((m) => m.seq < second.seq).map((m) => m.seq));
    expect(left.at(-1)?.role).toBe('assistant');
    expect(engine.getSession(chat.id)?.stats.messages).toBe(left.length);
  });
});

describe('second opinions', () => {
  test('name the reply they answer, and keep pointing at its copy in a branch', async () => {
    t = await startTestEngine({ script: [[{ text: 'Use ss -ltnp.' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'what listens on 8080?');
    const reply = engine.getMessages(chat.id).find((m) => m.role === 'assistant' && m.kind === 'normal')!;
    await engine.secondOpinion(chat.id, { reviewer: 'mock/claude-sonnet-5-5', messageId: reply.id });
    const aside = engine.getMessages(chat.id).find((m) => m.kind === 'aside')!;
    expect(aside.meta?.messageId).toBe(reply.id);

    const fork = engine.forkSession(chat.id);
    const copies = engine.getMessages(fork.id);
    const copyReply = copies.find((m) => m.role === 'assistant' && m.kind === 'normal')!;
    const copyAside = copies.find((m) => m.kind === 'aside')!;
    expect(copyReply.id).not.toBe(reply.id);
    expect(copyAside.meta?.messageId).toBe(copyReply.id);
  });
});

describe('usage of a chat', () => {
  test('counts under the source "chat"; agent sessions stay "api"', async () => {
    t = await startTestEngine({ script: [[{ text: 'hi' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'hello there');
    const agent = await engine.createSession({ cwd: t.cwd });
    await t.run(agent.id, 'hello there');
    expect(await until(() => engine.repos.usage.aggregate('source').length >= 2)).toBe(true);
    const sources = engine.repos.usage.aggregate('source').map((b) => b.key).sort();
    expect(sources).toEqual(['api', 'chat']);
  });
});

describe('a failed turn', () => {
  test('says what to do when the key is missing, refused, or out of credit', async () => {
    const { turnErrorText } = await import('../../src/session/runner');
    const { ProviderError } = await import('../../src/providers/types');
    t = await startTestEngine({ script: [[{ text: 'hi' }]] });
    const { engine } = t;
    expect(turnErrorText(engine, new ProviderError('auth', 'nokey 401 authentication_error', { provider: 'nokey' }))).toBe('Nokey has no API key on this hub. Add one in Settings, Providers, or switch model, then retry.');
    expect(turnErrorText(engine, new ProviderError('auth', 'mock 401 invalid key', { provider: 'mock' }))).toContain('did not accept its API key (mock 401 invalid key). Check the key in Settings, Providers');
    expect(turnErrorText(engine, new ProviderError('quota', 'credit balance is too low', { provider: 'mock' }))).toContain('out of credit');
    expect(turnErrorText(engine, new Error('boom'))).toBe('boom');
  });
});
