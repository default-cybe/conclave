/**
 * Unread conversations (session/unread.ts): a finished turn stamps
 * meta.doneAt, markSeen stamps meta.seenAt without moving the session in
 * the lists (updatedAt stays).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from './harness';
import { isUnread } from '../../src/session/unread';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('unread', () => {
  test('the rule: finished after last seen; no stamp reads as seen', () => {
    expect(isUnread({ meta: undefined })).toBe(false);
    expect(isUnread({ meta: { doneAt: 5 } })).toBe(true);
    expect(isUnread({ meta: { doneAt: 5, seenAt: 4 } })).toBe(true);
    expect(isUnread({ meta: { doneAt: 5, seenAt: 5 } })).toBe(false);
  });

  test('a finished turn is unread until the owner opens it, and opening keeps its place', async () => {
    t = await startTestEngine({ script: [[{ text: 'Done.' }]] });
    const s = await t.engine.createSession({ kind: 'chat', title: 'Plan' });
    await t.run(s.id, 'hello');
    const after = t.engine.getSession(s.id)!;
    expect(typeof after.meta?.doneAt).toBe('number');
    expect(isUnread(after)).toBe(true);
    const seen = t.engine.markSeen(s.id);
    expect(isUnread(seen)).toBe(false);
    expect(seen.updatedAt).toBe(after.updatedAt);
    expect(isUnread(t.engine.getSession(s.id)!)).toBe(false);
  });

  test('Pause is the owner stopping it: no unread', async () => {
    t = await startTestEngine({ script: [] });
    const s = await t.engine.createSession({ kind: 'chat', title: 'Plan' });
    t.engine.setStatus(s.id, 'running');
    t.engine.setStatus(s.id, 'paused');
    expect(t.engine.getSession(s.id)!.meta?.doneAt).toBeUndefined();
  });
});
