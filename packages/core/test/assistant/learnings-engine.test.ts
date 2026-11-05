/**
 * Learnings' capture through the real engine (engine.afterTurn): a chat with
 * memory on is read; an incognito session, a subagent and a chat with memory
 * off are not; nothing reaches the queue before the model check.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { assistantOf } from '../../src/assistant';

let t: TestEngine;
beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]], overrides: { memory: { enabled: true, autoExtract: false, autoInject: false, injectLimit: 0 } } as never });
});
afterAll(() => t.close());

const pending = () => t.engine.repos.kv.get<Array<{ sessionId: string; text: string }>>('learn.pending', []);

test('capture reads chats with memory on, and skips incognito, subagents and memory off', async () => {
  const { engine } = t;
  const say = (id: string, text: string) => engine.addMessage(id, { role: 'user', kind: 'normal', content: [{ type: 'text', text }] });
  const chat = await engine.createSession({ kind: 'chat', title: 'Chat' });
  const sub = await engine.createSession({ agent: 'explore', cwd: t.cwd, parentId: chat.id, tags: ['subagent'] });
  const off = await engine.createSession({ kind: 'chat', title: 'Off', chat: { memory: false } } as never);
  const incog = await engine.createSession({ kind: 'chat', title: 'Incognito' });
  // TODO(sessions.incognito, PR #254): create it with incognito: true once that PR is on main; until then the row is read with the flag set
  const get = engine.repos.sessions.get.bind(engine.repos.sessions);
  engine.repos.sessions.get = ((id: string) => (id === incog.id ? { ...get(id)!, incognito: true } : get(id))) as typeof get;
  for (const s of [chat, sub, off, incog]) {
    say(s.id, 'no, always use pnpm not npm');
    say(s.id, 'fix the build');
    engine.afterTurn(s.id, 1);
  }
  engine.repos.sessions.get = get;
  const got = pending();
  expect(got.filter((p) => p.sessionId === chat.id).map((p) => p.text)).toEqual(['no, always use pnpm not npm']);
  expect(got.filter((p) => p.sessionId !== chat.id)).toEqual([]);
  // one candidate is not a batch: no model call yet, nothing queued
  expect(assistantOf(engine)!.learnings.count()).toBe(0);
});
