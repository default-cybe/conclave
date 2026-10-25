/**
 * One notification per job, through the real engine: a session, its
 * subagents at any depth and the notices about them share one thread, so a
 * device replaces the last notice instead of stacking a new one.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import type { Notice } from '../../src/types';

let t: TestEngine;
const notices: Notice[] = [];

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  t.engine.bus.on((e) => {
    if (e.type === 'notice') notices.push(e.notice);
  });
});
afterAll(() => t.close());

test('a turn end in a session, its subagent and its sub-subagent shares the top session as thread', async () => {
  const { engine } = t;
  const chat = await engine.createSession({ kind: 'chat', title: 'Job' });
  const sub = await engine.createSession({ agent: 'explore', cwd: t.cwd, parentId: chat.id, tags: ['subagent'] });
  const deep = await engine.createSession({ agent: 'explore', cwd: t.cwd, parentId: sub.id, tags: ['subagent'] });
  const other = await engine.createSession({ kind: 'chat', title: 'Other' });
  for (const s of [chat, sub, deep, other]) engine.afterTurn(s.id, 1);
  await Bun.sleep(20);
  const threadOf = (sessionId: string) => notices.find((n) => n.sessionId === sessionId)?.thread;
  expect(threadOf(chat.id)).toBe(chat.id);
  expect(threadOf(sub.id)).toBe(chat.id);
  expect(threadOf(deep.id)).toBe(chat.id);
  expect(threadOf(other.id)).toBe(other.id);
  // a workflow run's outcome uses its host session's root (workflows/service.ts deliver)
  expect(engine.askOrigin(sub.id).rootSessionId).toBe(threadOf(chat.id)!);
});
