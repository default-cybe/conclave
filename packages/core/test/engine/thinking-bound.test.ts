/**
 * Fable and Mythos 5.2 bind replayed thinking to the request prefix before it:
 * an edited prefix is a 400 "The block is bound to a different conversation"
 * unless block_binding drop_block reaches the API. When a route loses it, the
 * runner retries once with no replayed thinking instead of failing the turn.
 *
 *   bun test packages/core/test/engine/thinking-bound.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from './harness';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BOUND = 'messages.1.content.0: The block is bound to a different conversation';

/** Answers the binding 400 while a request replays thinking, at most `times` times. */
function refuseThinking(times: number) {
  let left = times;
  return (_b: unknown, text: string) => (text.includes('"type":"thinking"') && left-- > 0 ? { status: 400, error: BOUND } : undefined);
}

async function withHistory(t: TestEngine) {
  const s = await t.engine.createSession({ title: 'bound', agent: 'coder', cwd: t.cwd, model: 'mock/claude-fable-5-2' });
  t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'First question' }] });
  t.engine.addMessage(s.id, {
    role: 'assistant',
    kind: 'normal',
    model: 'mock/claude-fable-5-2',
    content: [
      { type: 'thinking', thinking: 'old reasoning', signature: 'sig-old' },
      { type: 'text', text: 'First answer' },
    ],
  });
  return s;
}

describe('thinking bound to an edited prefix', () => {
  test('the request asks for drop_block; a 400 anyway is retried once without replayed thinking', async () => {
    t = await startTestEngine({ models: ['claude-fable-5-2'], script: [[{ text: 'Recovered.' }]], route: refuseThinking(1) });
    const s = await withHistory(t);
    await t.run(s.id, 'Second question');

    expect(t.requests.length).toBe(2);
    const first = JSON.parse(t.requests[0]);
    expect(first.thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'drop_block' });
    expect(t.requests[0]).toContain('"type":"thinking"');
    expect(t.requests[1]).not.toContain('"type":"thinking"');
    const last = t.engine.repos.messages.list(s.id).filter((m) => m.role === 'assistant').at(-1);
    expect(last?.stopReason).not.toBe('error');
    expect(last?.content).toEqual([{ type: 'text', text: 'Recovered.' }]);
  });

  test('after the retry, a tool loop keeps the thinking it makes; only the old thinking stays out', async () => {
    t = await startTestEngine({
      models: ['claude-fable-5-2'],
      script: [[{ thinking: 'new reasoning', signature: 'sig-new' }, { tool: 'Glob', input: { pattern: '*.md' } }], [{ text: 'Done.' }]],
      route: refuseThinking(1),
    });
    const s = await withHistory(t);
    await t.run(s.id, 'Second question');

    expect(t.requests.length).toBe(3);
    expect(t.requests[1]).not.toContain('"type":"thinking"');
    expect(t.requests[2]).not.toContain('sig-old');
    expect(t.requests[2]).toContain('sig-new');
    const last = t.engine.repos.messages.list(s.id).filter((m) => m.role === 'assistant').at(-1);
    expect(last?.content).toEqual([{ type: 'text', text: 'Done.' }]);
  });

  test('retried once per turn: a second binding 400 ends the turn with the error', async () => {
    t = await startTestEngine({ models: ['claude-fable-5-2'], script: [[{ text: 'never' }]], route: () => ({ status: 400, error: BOUND }) });
    const s = await withHistory(t);
    await t.run(s.id, 'Second question');
    expect(t.requests.length).toBe(2);
  });
});
