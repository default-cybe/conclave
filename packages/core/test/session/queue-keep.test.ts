/**
 * No waiting message is lost (docs/design/CHAT-AND-MOTION.md 2.11): a turn
 * that fails runs the next one, Stop holds what waits until the owner sends
 * or removes it, and a hub restart keeps the list, in its order.
 */
import { describe, expect, test } from 'bun:test';
import { createEngine } from '../../src/engine';
import { QUEUE_KEY } from '../../src/session/runner';
import { startTestEngine, until, type Step, type TestEngine } from '../engine/harness';

const userTexts = (t: Pick<TestEngine, 'engine'>, id: string) =>
  t.engine
    .getMessages(id)
    .filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>')))
    .map((m) => (m.content.find((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>')) as { text: string }).text);

const slow = (text: string, delayMs = 1_000): Step => ({ blocks: [{ text }], delayMs });

async function startTurn(t: TestEngine, id: string) {
  await t.engine.send(id, { text: 'first' });
  expect(await until(() => t.engine.getSession(id)?.status === 'running' && t.requests.length >= 1)).toBe(true);
}

describe('waiting messages are kept', () => {
  test('a turn that fails leaves the queue whole: the next ones run, in order', async () => {
    let n = 0;
    // the first model call takes a while and then fails (400): a failed turn; the queued turns answer ok
    const t = await startTestEngine({ script: [[{ text: 'ok' }]], route: () => (++n === 1 ? { status: 400, error: 'scripted failure', delayMs: 800 } : undefined) });
    try {
      const s = await t.engine.createSession({ title: 'Fail', cwd: t.cwd });
      await startTurn(t, s.id);
      for (const text of ['a', 'b', 'c']) await t.engine.send(s.id, { text });
      await t.engine.runnerFor(s.id).waitIdle();
      // each ran as its own turn after the failed one
      expect(n).toBe(4);
      expect(userTexts(t, s.id)).toEqual(['first', 'a', 'b', 'c']);
      expect(t.engine.queue(s.id)).toEqual([]);
      expect(t.engine.repos.kv.keys(QUEUE_KEY)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  test('Stop holds what waits; Send runs one, the x removes another', async () => {
    const t = await startTestEngine({ script: [slow('one', 1_500), [{ text: 'two' }]] });
    try {
      const s = await t.engine.createSession({ title: 'Stop', cwd: t.cwd });
      await startTurn(t, s.id);
      const a = await t.engine.send(s.id, { text: 'a' });
      const st = await t.engine.send(s.id, { text: 'steer', whenBusy: 'steer' });
      const b = await t.engine.send(s.id, { text: 'b' });
      t.engine.abort(s.id);
      await t.engine.runnerFor(s.id).waitIdle();
      // nothing ran, nothing is gone: all held, steering first as it would have joined first
      expect(userTexts(t, s.id)).toEqual(['first']);
      expect(t.engine.queue(s.id).map((q) => [q.id, q.held, q.whenBusy])).toEqual([
        [st.pendingId, true, 'queue'],
        [a.pendingId, true, 'queue'],
        [b.pendingId, true, 'queue'],
      ]);
      expect(t.engine.repos.kv.get<unknown[]>(QUEUE_KEY + s.id, [])).toHaveLength(3);
      t.engine.unqueue(s.id, st.pendingId!);
      t.engine.sendQueued(s.id, b.pendingId!);
      expect(await until(() => userTexts(t, s.id).length === 2)).toBe(true);
      await t.engine.runnerFor(s.id).waitIdle();
      expect(userTexts(t, s.id)).toEqual(['first', 'b']);
      // a stays held and listed until the owner sends or removes it
      expect(t.engine.queue(s.id).map((q) => [q.id, q.held])).toEqual([[a.pendingId, true]]);
      expect(() => t.engine.sendQueued(s.id, 'q_nothing')).toThrow('not waiting');
    } finally {
      await t.close();
    }
  });

  test('/btw answers from the transcript with one tool-less call, and changes neither the transcript nor the queue', async () => {
    const asked: string[] = [];
    const t = await startTestEngine({
      script: [slow('one', 1_200)],
      chore: (_body, text) => (text.includes('Side question') ? (asked.push(text), [{ text: 'it is about zq-topic' }]) : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 'Btw', cwd: t.cwd });
      await t.engine.send(s.id, { text: 'first about zq-topic' });
      expect(await until(() => t.requests.length >= 1)).toBe(true);
      const before = t.engine.getMessages(s.id).map((m) => m.id);
      expect(await t.engine.btw(s.id, 'what is this about?')).toEqual({ answer: 'it is about zq-topic' });
      expect(asked).toHaveLength(1);
      // the session's recent context went with it, and no tools
      expect(asked[0]).toContain('first about zq-topic');
      expect(JSON.parse(asked[0]).tools).toBeUndefined();
      expect(t.engine.getMessages(s.id).map((m) => m.id)).toEqual(before);
      expect(t.engine.queue(s.id)).toEqual([]);
      await t.engine.runnerFor(s.id).waitIdle();
      // the running turn never saw it
      expect(t.requests.some((r) => r.includes('what is this about?'))).toBe(false);
      await expect(t.engine.btw(s.id, '  ')).rejects.toThrow('Ask a question');
    } finally {
      await t.close();
    }
  });

  test('a hub restart keeps the queue: the new engine lists it and runs it in order', async () => {
    const t = await startTestEngine({ script: [slow('one', 1_500), [{ text: 'ok' }]] });
    let next: Awaited<ReturnType<typeof createEngine>> | undefined;
    try {
      const s = await t.engine.createSession({ title: 'Restart', cwd: t.cwd });
      await startTurn(t, s.id);
      const ids = [];
      for (const text of ['a', 'b', 'c']) ids.push((await t.engine.send(s.id, { text })).pendingId);
      const cfg = t.engine.config.get();
      await t.engine.shutdown();
      expect(t.engine.repos.kv.get<unknown[]>(QUEUE_KEY + s.id, [])).toHaveLength(3);

      next = await createEngine({
        home: t.home,
        noBackground: true,
        version: 'test',
        overrides: {
          defaultModel: cfg.defaultModel,
          smallModel: cfg.smallModel,
          providers: cfg.providers,
          permissions: cfg.permissions,
          memory: cfg.memory,
          models: cfg.models,
        } as never,
      });
      // listed at once after boot, in send order, none held
      expect(next.queue(s.id).map((q) => [q.id, q.held])).toEqual(ids.map((id) => [id, undefined]));
      await next.runnerFor(s.id).waitIdle();
      expect(userTexts({ engine: next }, s.id)).toEqual(['first', 'a', 'b', 'c']);
      // each took its bubble's place
      expect(next.getMessages(s.id).flatMap((m) => (m.meta?.pendingIds as string[] | undefined) ?? [])).toEqual(ids as string[]);
      expect(next.queue(s.id)).toEqual([]);
      expect(next.repos.kv.keys(QUEUE_KEY)).toEqual([]);
    } finally {
      await next?.shutdown();
      await t.close();
    }
  });
});
