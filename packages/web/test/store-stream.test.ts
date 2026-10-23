/**
 * The store under a stream of hub events (src/store/store.ts): a chunk
 * keeps the records that did not change, so the replies that are done are
 * not drawn again, and transcripts load once even when several views ask.
 *
 *   bun test packages/web/test/store-stream.test.ts
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { EngineEvent, Message } from '@conclave/core/types';
import { api, connectClient } from '../src/lib/api';
import { applyEvent, loadMessages, stopLive, useHub } from '../src/store/store';

let seq = 0;
const send = (e: EngineEvent) => applyEvent({ ...e, seq: ++seq, ts: 1000 + seq } as Parameters<typeof applyEvent>[0]);
const delta = (kind: 'text' | 'thinking' | 'tool_input', text: string, index = 0) => send({ type: 'message.delta', sessionId: 's1', messageId: 'm1', index, kind, text });

beforeEach(() => stopLive());

describe('streamed chunks', () => {
  test('a chunk for a message that already streams keeps the streaming record', () => {
    delta('text', 'Hel');
    const first = useHub.getState().streaming;
    delta('text', 'lo');
    const s = useHub.getState();
    expect(s.streaming).toBe(first);
    expect(s.messages.s1[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  test('tool input chunks leave the transcript as it is', () => {
    delta('text', 'Writing the file.');
    const before = useHub.getState().messages;
    delta('tool_input', JSON.stringify({ start: true, id: 'tu1', name: 'Write' }), 1);
    delta('tool_input', '{"path":"a.sql","content":"-- x', 1);
    const s = useHub.getState();
    expect(s.messages).toBe(before);
    expect(s.messages.s1[0].content).toHaveLength(1);
    expect(Object.keys(s)).not.toContain('toolInputs');
  });

  test('a tool input chunk for a new message starts it and marks it streaming', () => {
    delta('tool_input', JSON.stringify({ start: true, id: 'tu1', name: 'Read' }));
    const s = useHub.getState();
    expect(s.messages.s1.map((m) => m.id)).toEqual(['m1']);
    expect(s.streaming.m1).toBe(true);
  });

  test('the record changes only when a message stops streaming', () => {
    delta('text', 'Done.');
    const live = useHub.getState().streaming;
    send({ type: 'message.created', message: msg('u2', 'user') });
    expect(useHub.getState().streaming).toBe(live);
    send({ type: 'message.updated', message: { ...useHub.getState().messages.s1[0], stopReason: 'end_turn' } });
    expect(useHub.getState().streaming.m1).toBeUndefined();
  });
});

function msg(id: string, role: Message['role'], s = 2): Message {
  return { id, sessionId: 's1', seq: s, role, kind: 'normal', content: [{ type: 'text', text: id }], createdAt: 1 };
}

describe('loading a transcript', () => {
  test('views that ask at once share one request', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    let calls = 0;
    Object.assign(api(), {
      messages: async () => {
        calls++;
        return [msg('a', 'user', 1)];
      },
      todos: async () => [],
    });
    await Promise.all([loadMessages('s1'), loadMessages('s1'), loadMessages('s1')]);
    expect(calls).toBe(1);
    expect(useHub.getState().messages.s1.map((m) => m.id)).toEqual(['a']);
  });

  test('an older, slower answer never lands over a newer one', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    const answers: Array<(m: Message[]) => void> = [];
    Object.assign(api(), {
      messages: () => new Promise<Message[]>((r) => answers.push(r)),
      todos: async () => [],
    });
    const old = loadMessages('s1');
    const fresh = loadMessages('s1', true);
    answers[1]([msg('after-rewind', 'user', 1)]);
    await fresh;
    answers[0]([msg('before-rewind', 'user', 1), msg('dropped', 'assistant', 2)]);
    await old;
    expect(useHub.getState().messages.s1.map((m) => m.id)).toEqual(['after-rewind']);
  });

  // a new chat's first reply could start before its transcript came back: the answer, read before the reply existed, wiped it until a reload
  test('a reply that starts while the transcript loads stays', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    useHub.setState({ messages: {}, messagesLoaded: {} });
    let answer: (m: Message[]) => void = () => {};
    Object.assign(api(), {
      messages: () => new Promise<Message[]>((r) => (answer = r)),
      todos: async () => [],
    });
    const loading = loadMessages('s9');
    applyEvent({ type: 'message.created', message: { ...msg('u1', 'user', 1), sessionId: 's9' }, seq: ++seq, ts: 2000 });
    applyEvent({ type: 'message.created', message: { ...msg('r1', 'assistant', 2), sessionId: 's9' }, seq: ++seq, ts: 2001 });
    applyEvent({ type: 'message.delta', sessionId: 's9', messageId: 'r2', index: 0, kind: 'text', text: 'More', seq: ++seq, ts: 2002 });
    // the answer has the user's message only
    answer([{ ...msg('u1', 'user', 1), sessionId: 's9' }]);
    await loading;
    expect(useHub.getState().messages.s9.map((m) => m.id)).toEqual(['u1', 'r1', 'r2']);
  });

  test('a message from before the load that the hub dropped (a rewind) goes', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    useHub.setState({ messages: {}, messagesLoaded: {} });
    applyEvent({ type: 'message.created', message: { ...msg('old', 'assistant', 2), sessionId: 's8' }, seq: ++seq, ts: 2000 });
    let answer: (m: Message[]) => void = () => {};
    Object.assign(api(), {
      messages: () => new Promise<Message[]>((r) => (answer = r)),
      todos: async () => [],
    });
    const loading = loadMessages('s8', true);
    // its last update arrives late, after the load went out
    applyEvent({ type: 'message.updated', message: { ...msg('old', 'assistant', 2), sessionId: 's8', stopReason: 'end_turn' }, seq: ++seq, ts: 2001 });
    answer([{ ...msg('u1', 'user', 1), sessionId: 's8' }]);
    await loading;
    expect(useHub.getState().messages.s8.map((m) => m.id)).toEqual(['u1']);
  });
});

describe('tool output', () => {
  test('a finished run keeps its result, not its live output', () => {
    send({ type: 'tool.started', sessionId: 's1', messageId: 'm1', toolUseId: 't1', name: 'Bash', input: { command: 'bun test' } });
    send({ type: 'tool.progress', sessionId: 's1', toolUseId: 't1', text: 'x'.repeat(5000) });
    expect(useHub.getState().tools.t1.progress).toHaveLength(5000);
    send({ type: 'tool.completed', sessionId: 's1', toolUseId: 't1', result: { type: 'tool_result', toolUseId: 't1', content: '113 pass' } });
    const run = useHub.getState().tools.t1;
    expect(run.status).toBe('ok');
    expect(run.result?.content).toBe('113 pass');
    expect(run.progress).toBe('');
  });
});

describe('a deleted session', () => {
  test('takes its transcript with it, so a resync does not fetch it again', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    Object.assign(api(), { messages: async () => [msg('a', 'user', 1)], todos: async () => [] });
    await loadMessages('s1');
    send({ type: 'session.deleted', sessionId: 's1' });
    const s = useHub.getState();
    expect(s.messages.s1).toBeUndefined();
    expect(s.messagesLoaded.s1).toBeUndefined();
    expect(s.todos.s1).toBeUndefined();
  });
});
