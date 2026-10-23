import { afterEach, describe, expect, test } from 'bun:test';
import { BUILTIN_AGENTS } from '../../src/extensions/builtin-agents';
import { chatAllowsTool, chatSettings, mergeChatSettings } from '../../src/session/chat';
import type { ModelInfo } from '../../src/providers/types';
import { startTestEngine, until, type TestEngine } from './harness';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const toolNames = (body: string) => ((JSON.parse(body) as { tools?: Array<{ name: string }> }).tools ?? []).map((x) => x.name).sort();

describe('the chat agent', () => {
  test('ships with only the web, maps, memory, Delegate and ConclaveHelp tools, global memory, in the picker', () => {
    const chat = BUILTIN_AGENTS.find((a) => a.name === 'chat')!;
    expect(chat).toBeDefined();
    expect(chat.primary).toBe(true);
    expect(chat.memory).toBe('global');
    expect([...(chat.tools ?? [])].sort()).toEqual(['ConclaveHelp', 'Delegate', 'Directions', 'MapImage', 'MemoryForget', 'MemorySave', 'MemorySearch', 'PlaceDetails', 'PlaceSearch', 'SessionRead', 'SessionSearch', 'WebFetch', 'WebSearch']);
    expect(chat.prompt).toContain('Continue as a session');
    expect(chat.prompt).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('chat switches', () => {
  test('a missing switch is on, a patch keeps the others, bad values are refused', () => {
    expect(chatSettings({ kind: 'chat' })).toEqual({ webSearch: true, memory: true });
    expect(chatSettings({})).toBeUndefined();
    const a = mergeChatSettings(undefined, { memory: false });
    expect(a).toEqual({ webSearch: true, memory: false });
    expect(mergeChatSettings(a, { thinking: 'high' })).toEqual({ webSearch: true, memory: false, thinking: 'high' });
    expect(mergeChatSettings({ webSearch: true, memory: true, thinking: 'low' }, { thinking: null })).toEqual({ webSearch: true, memory: true });
    expect(() => mergeChatSettings(a, { webSearch: 'yes' })).toThrow('chat.webSearch must be true or false');
    // Effort keeps the old values and takes Claude's two levels above high
    expect(mergeChatSettings(a, { thinking: 'xhigh' }).thinking).toBe('xhigh');
    expect(mergeChatSettings(a, { thinking: 'max' }).thinking).toBe('max');
    expect(() => mergeChatSettings(a, { thinking: 'extreme' })).toThrow('chat.thinking must be off, low, medium, high, xhigh, max or ultra');
    expect(chatAllowsTool({ webSearch: false, memory: true }, 'WebFetch')).toBe(false);
    expect(chatAllowsTool({ webSearch: true, memory: false }, 'MemorySave')).toBe(false);
    expect(chatAllowsTool(undefined, 'Bash')).toBe(true);
  });
});

describe('chat sessions in the engine', () => {
  test('create marks the session, picks the chat agent and the hub, and lists apart from agent sessions', async () => {
    t = await startTestEngine({ script: [[{ text: 'hi' }]] });
    const { engine } = t;
    const old = await engine.createSession({ title: 'agent work', cwd: t.cwd });
    const chat = await engine.createSession({ kind: 'chat', chat: { webSearch: false } });
    expect(chat.kind).toBe('chat');
    expect(chat.agent).toBe('chat');
    expect(chat.device).toBe('local');
    expect(chat.mode).toBe('agent');
    expect(chat.chat).toEqual({ webSearch: false, memory: true });
    expect(old.kind).toBeUndefined();

    // stored and returned
    expect(engine.getSession(chat.id)?.kind).toBe('chat');
    expect(engine.getSession(chat.id)?.chat).toEqual({ webSearch: false, memory: true });
    expect(engine.getSession(old.id)?.kind).toBeUndefined();

    expect(engine.listSessions({ kind: 'chat' }).map((s) => s.id)).toEqual([chat.id]);
    expect(engine.listSessions({ kind: 'agent' }).map((s) => s.id)).toEqual([old.id]);
    expect(engine.listSessions({}).length).toBe(2);

    await expect(engine.createSession({ kind: 'chat', chat: { thinking: 'extreme' as never } })).rejects.toThrow('chat.thinking');
  });

  test('patching switches merges them; Continue as a session clears kind and switches', async () => {
    t = await startTestEngine({ script: [[{ text: 'hi' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat' });
    const a = engine.updateSession(chat.id, { chat: { memory: false } });
    expect(a.chat).toEqual({ webSearch: true, memory: false });
    const b = engine.updateSession(chat.id, { chat: { thinking: 'medium' }, title: 'Renamed' });
    expect(b.chat).toEqual({ webSearch: true, memory: false, thinking: 'medium' });
    expect(() => engine.updateSession(chat.id, { chat: { memory: 'no' as never } })).toThrow('chat.memory must be true or false');

    // branch keeps the chat a chat
    const fork = engine.forkSession(chat.id);
    expect(fork.kind).toBe('chat');
    expect(engine.getSession(fork.id)?.chat?.thinking).toBe('medium');

    // a chat has no device or folder to change (found in a real run: a chat that moved to a Mac folder)
    expect(() => engine.updateSession(chat.id, { cwd: '/tmp/elsewhere' })).toThrow('A chat runs on the hub and has no device or folder');
    expect(engine.getSession(chat.id)?.cwd).toBe(chat.cwd);

    const moved = engine.updateSession(chat.id, { kind: 'agent', agent: 'assistant', device: 'local', cwd: t.cwd });
    expect(moved.kind).toBeUndefined();
    expect(moved.chat).toBeUndefined();
    expect(engine.getSession(chat.id)?.kind).toBeUndefined();
    expect(engine.listSessions({ kind: 'agent' }).map((s) => s.id)).toContain(chat.id);
  });

  test('a chat turn offers only the tools its switches allow, takes no checkpoint and gets a title', async () => {
    t = await startTestEngine({ script: [[{ text: 'Use ss -ltnp.' }]] });
    const { engine } = t;
    const chat = await engine.createSession({ kind: 'chat', cwd: t.cwd });
    await t.run(chat.id, 'what listens on 8080 on madx?');
    expect(toolNames(t.requests[0])).toEqual(['ConclaveHelp', 'Delegate', 'Directions', 'MapImage', 'MemoryForget', 'MemorySave', 'MemorySearch', 'PlaceDetails', 'PlaceSearch', 'SessionRead', 'SessionSearch', 'WebFetch', 'WebSearch']);
    expect(engine.checkpoints(chat.id)).toEqual([]);
    // the chore model answers "ok"; the title is set after the first reply
    expect(await until(() => engine.getSession(chat.id)?.title !== 'New chat')).toBe(true);

    engine.updateSession(chat.id, { chat: { webSearch: false } });
    await t.run(chat.id, 'and on pve?');
    expect(toolNames(t.requests[1])).toEqual(['ConclaveHelp', 'Delegate', 'MemoryForget', 'MemorySave', 'MemorySearch', 'SessionRead', 'SessionSearch']);

    // memory off and web off: only Delegate, which reaches the owner's own devices, and the shipped docs
    engine.updateSession(chat.id, { chat: { memory: false } });
    const agent = engine.agentFor(engine.getSession(chat.id)!);
    expect(engine.toolsFor(engine.getSession(chat.id)!, agent, 'agent', 0).map((x) => x.name)).toEqual(['Delegate', 'ConclaveHelp']);

    const plain = await engine.createSession({ agent: 'chat', cwd: t.cwd });
    expect(engine.toolsFor(plain, agent, 'agent', 0).map((x) => x.name).sort()).toEqual(['ConclaveHelp', 'Delegate', 'Directions', 'MapImage', 'MemoryForget', 'MemorySave', 'MemorySearch', 'PlaceDetails', 'PlaceSearch', 'SessionRead', 'SessionSearch', 'WebFetch', 'WebSearch']);
  });

  test("a chat's thinking switch wins over the agent", async () => {
    t = await startTestEngine({ script: [[{ text: 'hi' }]] });
    const { engine } = t;
    const info = { thinking: true } as ModelInfo;
    const chat = await engine.createSession({ kind: 'chat', chat: { thinking: 'high' } });
    const agent = { ...engine.agentFor(chat), thinking: 'low' as const };
    expect(engine.thinkingFor(agent, info, chat)).toEqual({ effort: 'high' });
    expect(engine.thinkingFor(agent, info, engine.updateSession(chat.id, { chat: { thinking: 'off' } }))).toBeUndefined();
    expect(engine.thinkingFor(agent, info, engine.updateSession(chat.id, { chat: { thinking: null } }))).toEqual({ effort: 'low' });
    expect(engine.thinkingFor(agent, { thinking: false } as ModelInfo, chat)).toBeUndefined();
    const plain = await engine.createSession({ cwd: t.cwd });
    expect(engine.thinkingFor(agent, info, plain)).toEqual({ effort: 'low' });
  });
});

describe('memory off leaves no trace', () => {
  test('a chat with memory off gets no profile and no recalled notes; memory on gets both', async () => {
    t = await startTestEngine({
      script: [[{ text: 'Noted.' }]],
      overrides: { memory: { enabled: true, autoExtract: false, autoInject: true, injectLimit: 5 } } as never,
    });
    const { engine } = t;
    await engine.memory.save({ content: 'The owner runs Proxmox on madx.', kind: 'profile', scope: 'global' });
    await engine.memory.save({ content: 'Paperless runs in CT 112 on madx.', kind: 'fact', scope: 'global' });
    const on = await engine.createSession({ kind: 'chat' });
    await t.run(on.id, 'where does paperless run on madx?');
    const withMemory = t.requests[0];
    expect(withMemory).toContain('The owner runs Proxmox on madx.');
    expect(withMemory).toContain('Paperless runs in CT 112');

    const off = await engine.createSession({ kind: 'chat', chat: { memory: false, webSearch: true } });
    await t.run(off.id, 'where does paperless run on madx?');
    const without = t.requests[1];
    expect(without).not.toContain('The owner runs Proxmox on madx.');
    expect(without).not.toContain('Paperless runs in CT 112');
    expect(toolNames(without)).toEqual(['ConclaveHelp', 'Delegate', 'Directions', 'MapImage', 'PlaceDetails', 'PlaceSearch', 'WebFetch', 'WebSearch']);
  });
});

describe('thinking blocks carry their duration', () => {
  test('from the request to the next block, or to the end', async () => {
    const { timeThinking } = await import('../../src/session/stream');
    const content = [
      { type: 'thinking' as const, thinking: 'a' },
      { type: 'text' as const, text: 'b' },
      { type: 'thinking' as const, thinking: 'c' },
    ];
    timeThinking(content, new Map([[0, 1_200], [1, 4_000], [2, 5_000]]), 1_000, 9_000);
    expect(content[0]).toMatchObject({ durationMs: 3_000 });
    expect(content[2]).toMatchObject({ durationMs: 4_000 });
    expect('durationMs' in content[1]).toBe(false);
  });
});
