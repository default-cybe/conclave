/**
 * Messages sent while a session is busy (docs/design/CHAT-AND-MOTION.md 2.11).
 * They wait in the runner and apps see them: each has an id from the send,
 * session.queue lists them in the order they will run, and the user message
 * that takes one's place carries its id in meta.pendingIds. A message sent
 * while the session is idle runs as before, with no queue events.
 */
import { describe, expect, test } from 'bun:test';
import type { EngineEventEnvelope, Message, QueuedMessage } from '../../src/types';
import { STEER_NOTE } from '../../src/session/runner';
import { startTestEngine, until, type Step, type TestEngine } from '../engine/harness';

type Seen = { type: string; queue?: string[]; message?: Message };

/** Queue events (their ids) and created messages, in the order the bus sent them. */
function watch(t: TestEngine, sessionId: string): Seen[] {
  const seen: Seen[] = [];
  t.engine.bus.on((e: EngineEventEnvelope) => {
    if (e.type === 'session.queue' && e.sessionId === sessionId) seen.push({ type: e.type, queue: e.queue.map((q) => q.id) });
    if (e.type === 'message.created' && e.message.sessionId === sessionId) seen.push({ type: e.type, message: e.message });
  });
  return seen;
}

const queues = (seen: Seen[]) => seen.filter((s) => s.type === 'session.queue').map((s) => s.queue);
const userTexts = (t: TestEngine, id: string) =>
  t.engine
    .getMessages(id)
    .filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>')))
    .map((m) => (m.content.find((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>')) as { text: string }).text);

async function engineWith(script: Step[]): Promise<{ t: TestEngine; id: string }> {
  const t = await startTestEngine({ script });
  const s = await t.engine.createSession({ title: 'Queue', cwd: t.cwd });
  return { t, id: s.id };
}

/** Send the first message and wait until its turn runs and its first request is with the model. */
async function startTurn(t: TestEngine, id: string, text = 'first') {
  const r = await t.engine.send(id, { text });
  expect(r).toEqual({ queued: false });
  expect(await until(() => t.engine.getSession(id)?.status === 'running' && t.requests.length >= 1)).toBe(true);
}

const slow = (text: string, delayMs = 700): Step => ({ blocks: [{ text }], delayMs });

describe('the queue while a turn runs', () => {
  test('a message sent while busy gets an id, is listed at once, and its user message takes its place when its turn starts', async () => {
    const { t, id } = await engineWith([slow('one'), [{ text: 'two' }]]);
    try {
      const seen = watch(t, id);
      await startTurn(t, id);
      const r = await t.engine.send(id, { text: 'second', attachments: [{ mediaType: 'text/plain', data: 'aGk=', name: 'notes.txt' }] });
      expect(r.queued).toBe(true);
      expect(r.pendingId).toMatch(/^q_/);
      const listed = t.engine.queue(id);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: r.pendingId, text: 'second', whenBusy: 'queue', attachments: [{ name: 'notes.txt', mediaType: 'text/plain' }] } satisfies Partial<QueuedMessage>);
      expect(listed[0].at).toBeGreaterThan(0);
      expect(queues(seen)).toEqual([[r.pendingId!]]);
      // nothing of it is in the transcript yet
      expect(userTexts(t, id)).toEqual(['first']);

      await t.engine.runnerFor(id).waitIdle();
      expect(userTexts(t, id)).toEqual(['first', 'second']);
      const second = t.engine.getMessages(id).find((m) => m.role === 'user' && (m.content[0] as { text?: string }).text === 'second')!;
      expect(second.meta).toMatchObject({ pendingIds: [r.pendingId], whenBusy: 'queue' });
      // the message arrives before the event that drops it, so an app never shows neither
      const created = seen.findIndex((s) => s.message?.id === second.id);
      const dropped = seen.findIndex((s, i) => i > created && s.type === 'session.queue' && !s.queue!.includes(r.pendingId!));
      expect(created).toBeGreaterThan(-1);
      expect(dropped).toBe(created + 1);
      // and until then it stayed listed, also while its turn started
      expect(seen.slice(0, created).filter((s) => s.type === 'session.queue').every((s) => s.queue!.includes(r.pendingId!))).toBe(true);
      expect(t.engine.queue(id)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  test('several wait in send order; the id an app proposes is kept, a malformed or taken one is replaced', async () => {
    const { t, id } = await engineWith([slow('one'), [{ text: 'two' }], [{ text: 'three' }]]);
    try {
      await startTurn(t, id);
      const a = await t.engine.send(id, { text: 'a', pendingId: 'web_a1b2c3' });
      const b = await t.engine.send(id, { text: 'b', pendingId: 'web_a1b2c3' });
      const c = await t.engine.send(id, { text: 'c', pendingId: 'no spaces!' });
      expect(a.pendingId).toBe('web_a1b2c3');
      expect(b.pendingId).not.toBe('web_a1b2c3');
      expect(c.pendingId).toMatch(/^q_/);
      expect(t.engine.queue(id).map((q) => q.text)).toEqual(['a', 'b', 'c']);
      await t.engine.runnerFor(id).waitIdle();
      expect(userTexts(t, id)).toEqual(['first', 'a', 'b', 'c']);
    } finally {
      await t.close();
    }
  });

  test('removing one takes it off before it runs; a started or unknown one cannot be removed', async () => {
    const { t, id } = await engineWith([slow('one'), [{ text: 'two' }]]);
    try {
      const seen = watch(t, id);
      await startTurn(t, id);
      const a = await t.engine.send(id, { text: 'keep' });
      const b = await t.engine.send(id, { text: 'drop' });
      t.engine.unqueue(id, b.pendingId!);
      expect(t.engine.queue(id).map((q) => q.id)).toEqual([a.pendingId!]);
      expect(queues(seen).at(-1)).toEqual([a.pendingId!]);
      expect(() => t.engine.unqueue(id, b.pendingId!)).toThrow('not waiting');
      expect(() => t.engine.unqueue(id, 'q_nothing')).toThrow('not waiting');
      await t.engine.runnerFor(id).waitIdle();
      expect(userTexts(t, id)).toEqual(['first', 'keep']);
    } finally {
      await t.close();
    }
  });

  test('Stop holds the queue and says so: listed, held, until Send runs one or the x removes it', async () => {
    const { t, id } = await engineWith([slow('one', 1_500), [{ text: 'two' }]]);
    try {
      const seen = watch(t, id);
      await startTurn(t, id);
      const a = await t.engine.send(id, { text: 'later' });
      const s = await t.engine.send(id, { text: 'now', whenBusy: 'steer' });
      expect(queues(seen).at(-1)).toEqual([s.pendingId!, a.pendingId!]);
      t.engine.abort(id);
      // the event says what waits now: the same messages, held, steering first
      expect(queues(seen).at(-1)).toEqual([s.pendingId!, a.pendingId!]);
      expect(t.engine.queue(id).map((q) => [q.id, q.held, q.whenBusy])).toEqual([
        [s.pendingId, true, 'queue'],
        [a.pendingId, true, 'queue'],
      ]);
      await t.engine.runnerFor(id).waitIdle();
      expect(userTexts(t, id)).toEqual(['first']);
      t.engine.unqueue(id, s.pendingId!);
      t.engine.sendQueued(id, a.pendingId!);
      expect(await until(() => userTexts(t, id).length === 2)).toBe(true);
      await t.engine.runnerFor(id).waitIdle();
      expect(userTexts(t, id)).toEqual(['first', 'later']);
      expect(t.engine.queue(id)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  test('steering joins the running turn at its next step as your words, and leaves the list', async () => {
    const { t, id } = await engineWith([{ blocks: [{ tool: 'TodoWrite', input: { todos: [{ content: 'look', status: 'in_progress', activeForm: 'Looking' }] } }], delayMs: 600 }, [{ text: 'done' }]]);
    try {
      const seen = watch(t, id);
      await startTurn(t, id);
      const s = await t.engine.send(id, { text: 'use the other branch', whenBusy: 'steer' });
      expect(s.queued).toBe(true);
      expect(t.engine.queue(id)).toMatchObject([{ id: s.pendingId, whenBusy: 'steer', text: 'use the other branch' }]);
      await t.engine.runnerFor(id).waitIdle();
      const steer = t.engine.getMessages(id).find((m) => m.meta?.whenBusy === 'steer')!;
      expect(steer.meta).toMatchObject({ pendingIds: [s.pendingId] });
      // your words as you sent them; the note for the model is a reminder apps do not show
      expect(steer.content[0]).toEqual({ type: 'text', text: 'use the other branch' });
      expect((steer.content.at(-1) as { text: string }).text).toContain(STEER_NOTE);
      // it joined the turn: the model's second request carries it, and no second turn ran
      expect(t.requests).toHaveLength(2);
      expect(t.requests[1]).toContain('use the other branch');
      expect(queues(seen).at(-1)).toEqual([]);
      const created = seen.findIndex((x) => x.message?.id === steer.id);
      expect(seen[created + 1]).toEqual({ type: 'session.queue', queue: [] });
    } finally {
      await t.close();
    }
  });

  test('queued messages join the running turn right after its tool call, in order, before the next model call', async () => {
    const { t, id } = await engineWith([{ blocks: [{ tool: 'TodoWrite', input: { todos: [{ content: 'look', status: 'in_progress', activeForm: 'Looking' }] } }], delayMs: 600 }, [{ text: 'done' }]]);
    try {
      const seen = watch(t, id);
      await startTurn(t, id);
      const a = await t.engine.send(id, { text: 'also a' });
      const b = await t.engine.send(id, { text: 'also b' });
      expect(t.engine.queue(id).map((q) => q.whenBusy)).toEqual(['queue', 'queue']);
      await t.engine.runnerFor(id).waitIdle();
      // one turn: the second model call already carries both, in send order
      expect(t.requests).toHaveLength(2);
      expect(t.requests[1].indexOf('also a')).toBeGreaterThan(-1);
      expect(t.requests[1].indexOf('also a')).toBeLessThan(t.requests[1].indexOf('also b'));
      expect(userTexts(t, id)).toEqual(['first', 'also a', 'also b']);
      const joined = t.engine.getMessages(id).filter((m) => m.meta?.pendingIds);
      expect(joined.map((m) => m.meta)).toEqual([
        { whenBusy: 'steer', pendingIds: [a.pendingId] },
        { whenBusy: 'steer', pendingIds: [b.pendingId] },
      ]);
      // after the tool results, before the reply that read them
      const seqOf = (pred: (m: Message) => boolean) => t.engine.getMessages(id).find(pred)!.seq;
      expect(seqOf((m) => m.content.some((x) => x.type === 'tool_result'))).toBeLessThan(joined[0].seq);
      expect(joined[1].seq).toBeLessThan(seqOf((m) => m.role === 'assistant' && m.content.some((x) => x.type === 'text' && x.text === 'done')));
      expect(queues(seen).at(-1)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  test('a message sent while the model only writes text (no tool call) waits for the turn to end', async () => {
    const { t, id } = await engineWith([slow('one'), [{ text: 'two' }]]);
    try {
      await startTurn(t, id);
      const a = await t.engine.send(id, { text: 'zq-later-word' });
      await t.engine.runnerFor(id).waitIdle();
      expect(t.requests).toHaveLength(2);
      expect(t.requests[0]).not.toContain('zq-later-word');
      expect(t.requests[1]).toContain('zq-later-word');
      const m = t.engine.getMessages(id).find((x) => x.meta?.pendingIds)!;
      expect(m.meta).toEqual({ pendingIds: [a.pendingId], whenBusy: 'queue' });
    } finally {
      await t.close();
    }
  });

  test('steering that comes too late for the turn runs next as its own turn', async () => {
    // one step and no tools: the turn has no next step to join
    const { t, id } = await engineWith([slow('one'), [{ text: 'two' }]]);
    try {
      const seen = watch(t, id);
      await startTurn(t, id);
      const s = await t.engine.send(id, { text: 'also this', whenBusy: 'steer' });
      await until(() => t.engine.queue(id)[0]?.whenBusy === 'queue' || userTexts(t, id).length === 2);
      await t.engine.runnerFor(id).waitIdle();
      expect(userTexts(t, id)).toEqual(['first', 'also this']);
      const m = t.engine.getMessages(id).find((x) => x.meta?.pendingIds)!;
      expect(m.meta).toMatchObject({ pendingIds: [s.pendingId], whenBusy: 'queue' });
      // listed as steering, then as queued, then gone
      const kinds = seen.filter((x) => x.type === 'session.queue').map((x) => x.queue!.length);
      expect(kinds[0]).toBe(1);
      expect(kinds.at(-1)).toBe(0);
      expect(t.requests).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  test('a message sent while idle runs as before: no id, no queue events, no meta', async () => {
    const { t, id } = await engineWith([[{ text: 'one' }]]);
    try {
      const seen = watch(t, id);
      const r = await t.engine.send(id, { text: 'hello', pendingId: 'web_idle01' });
      expect(r).toEqual({ queued: false });
      await t.engine.runnerFor(id).waitIdle();
      expect(queues(seen)).toEqual([]);
      const user = t.engine.getMessages(id).find((m) => m.role === 'user')!;
      expect(user.meta?.pendingIds).toBeUndefined();
      expect(user.meta?.whenBusy).toBeUndefined();
      expect(t.engine.queue(id)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  test('auto inputs (a loop follow-up, a resume) wait unlisted', async () => {
    const { t, id } = await engineWith([slow('one'), [{ text: 'two' }]]);
    try {
      const seen = watch(t, id);
      await startTurn(t, id);
      const r = await t.engine.runnerFor(id).enqueue({ text: 'continue' }, { auto: true });
      expect(r).toEqual({ queued: true });
      expect(t.engine.queue(id)).toEqual([]);
      await t.engine.runnerFor(id).waitIdle();
      expect(queues(seen)).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
