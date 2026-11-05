/**
 * Same model for all work (session/model-pin.ts): with chat.sameModel on,
 * Task, workflow agents, Delegate and nested subagents run on the session's
 * model instead of the profile's model or a tier word; a provider/model the
 * call names still wins; routines never inherit it; a member pins only to a
 * model their account may use.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, type RequestBody, type TestEngine } from './harness';
import { afterToolResult, noHarnesses, runScript, systemText } from '../workflows/helpers';
import { runDelegate } from '../../src/engine/delegate';
import { modelPin } from '../../src/session/model-pin';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const PIN = 'mock/claude-opus-5-5';
const FAST = 'mock/claude-haiku-4-5';
const DEEP = 'mock/claude-sonnet-5-5';
const setup = {
  models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'],
  overrides: { models: { tiers: { fast: FAST, deep: DEEP } } } as never,
};
const has = (body: RequestBody, s: string) => firstUserText(body).includes(s);
const task = (prompt: string, input: Record<string, unknown> = {}) => ({ tool: 'Task', input: { description: 'job', prompt, subagent_type: 'verifier', ...input } });

async function pinned(t: TestEngine, extra: Record<string, unknown> = {}) {
  const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass', model: PIN, ...extra });
  return t.engine.updateSession(s.id, { chat: { sameModel: true } });
}

describe('Same model for all work', () => {
  test('persists on the session row, off by default, and adds one line to the system prompt', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]], ...setup });
    const plain = await t.engine.createSession({ cwd: t.cwd, model: PIN });
    expect(plain.chat?.sameModel).toBeUndefined();
    expect(modelPin(t.engine, plain)).toBeUndefined();
    const s = await pinned(t);
    expect(t.engine.repos.sessions.get(s.id)!.chat?.sameModel).toBe(true);
    expect(modelPin(t.engine, s)).toBe(PIN);
    await t.run(s.id, 'hi');
    expect(systemText(JSON.parse(t.requests[0]))).toContain(`Model pinned to ${PIN}: pass a model to Delegate, Task or Workflow only when the owner names one.`);
    // switching the model moves the pin; off clears it
    expect(modelPin(t.engine, t.engine.updateSession(s.id, { model: DEEP }))).toBe(DEEP);
    const off = t.engine.updateSession(s.id, { chat: { sameModel: false } });
    expect(t.engine.repos.sessions.get(s.id)!.chat?.sameModel).toBeUndefined();
    expect(modelPin(t.engine, off)).toBeUndefined();
    expect(() => t!.engine.updateSession(s.id, { chat: { sameModel: 'yes' } } as never)).toThrow('chat.sameModel must be true or false');
  });

  test('Task: the profile tier and a tier word run on the pin, a named provider/model wins, without the pin the tier applies', async () => {
    t = await startTestEngine({
      script: [[task('A-JOB'), task('B-JOB', { model: 'fast' }), task('C-JOB', { model: FAST })], [{ text: 'done' }], [task('D-JOB')], [{ text: 'done' }]],
      route: (body) => (/[A-D]-JOB/.test(firstUserText(body)) ? [{ text: 'checked' }] : undefined),
      ...setup,
    });
    const s = await pinned(t);
    await t.run(s.id, 'go');
    const kid = (job: string, parent = s.id) => t!.engine.listSessions({ parentId: parent }).find((c) => t!.engine.getMessages(c.id).some((m) => JSON.stringify(m.content).includes(job)))!;
    expect(kid('A-JOB').model).toBe(PIN);
    expect(kid('B-JOB').model).toBe(PIN);
    expect(kid('C-JOB').model).toBe(FAST);
    // the child carries the switch, so its own hand-offs pin too
    expect(kid('A-JOB').chat?.sameModel).toBe(true);
    // a fallback swap stays possible: the pin is not a model the owner named
    expect(kid('A-JOB').meta?.pinnedModel).toBeUndefined();
    const plain = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass', model: PIN });
    await t.run(plain.id, 'go');
    expect(kid('D-JOB', plain.id).model).toBe(DEEP);
    expect(kid('D-JOB', plain.id).chat?.sameModel).toBeUndefined();
  });

  test('a nested subagent runs on the chat model, also under a child that was named another model', async () => {
    t = await startTestEngine({
      script: [[task('OUTER-JOB', { model: FAST, subagent_type: 'general-purpose' })], [{ text: 'done' }]],
      route: (body) => {
        if (has(body, 'INNER-JOB')) return [{ text: 'inner done' }];
        if (has(body, 'OUTER-JOB')) return afterToolResult(body) ? [{ text: 'outer done' }] : [task('INNER-JOB', { subagent_type: 'general-purpose' })];
        return undefined;
      },
      ...setup,
    });
    const s = await pinned(t);
    await t.run(s.id, 'go');
    const outer = t.engine.listSessions({ parentId: s.id })[0];
    expect(outer.model).toBe(FAST);
    const inner = t.engine.listSessions({ parentId: outer.id })[0];
    expect(inner.model).toBe(PIN);
    expect(inner.chat?.sameModel).toBe(true);
  });

  test('workflow agents: tier word and profile model run on the pin, a named model wins; unpinned the tier applies', async () => {
    t = await startTestEngine({ script: [[{ text: 'unused' }]], route: (body) => (has(body, 'WF-') ? [{ text: 'ok' }] : undefined), ...setup });
    noHarnesses(t.engine);
    const script = `export const meta = { name: 'pin', description: 'x' }
await agent('WF-TIER', { model: 'deep', label: 'tier' })
await agent('WF-PROFILE', { agentType: 'verifier', label: 'profile' })
await agent('WF-NAMED', { model: '${FAST}', label: 'named' })
return 'ok'`;
    const s = await pinned(t);
    const run = await runScript(t, script, { sessionId: s.id });
    expect(run.status).toBe('done');
    const step = (label: string, parent: string) => t!.engine.listSessions({ parentId: parent }).find((c) => (c.meta?.workflow as { label?: string } | undefined)?.label === label)!;
    expect(step('tier', s.id).model).toBe(PIN);
    expect(step('profile', s.id).model).toBe(PIN);
    expect(step('named', s.id).model).toBe(FAST);
    const plain = await t.engine.createSession({ cwd: t.cwd, model: PIN });
    await runScript(t, script, { sessionId: plain.id });
    expect(step('tier', plain.id).model).toBe(DEEP);
    expect(step('profile', plain.id).model).toBe(DEEP);
  });

  test('Delegate: the child runs on the chat model and carries the pin; a named model wins', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]], route: (body) => (has(body, 'DLG-') ? [{ text: 'done' }] : undefined), ...setup });
    const chat = await t.engine.createSession({ kind: 'chat', model: PIN });
    t.engine.updateSession(chat.id, { chat: { sameModel: true } });
    const req = { to: 'code' as const, title: 'x', readOnly: true, background: false, toolUseId: 't1', depth: 0 };
    const a = await runDelegate(t.engine, chat.id, { ...req, prompt: 'DLG-A', model: 'fast' });
    const child = t.engine.getSession(a.sessionId)!;
    expect(child.model).toBe(PIN);
    expect(child.chat?.sameModel).toBe(true);
    expect(child.meta?.pinnedModel).toBeUndefined();
    expect(modelPin(t.engine, child)).toBe(PIN);
    const b = await runDelegate(t.engine, chat.id, { ...req, prompt: 'DLG-B', model: FAST });
    expect(t.engine.getSession(b.sessionId)!.model).toBe(FAST);
    expect(t.engine.getSession(b.sessionId)!.meta?.pinnedModel).toBe(true);
  });

  test('a routine started from a pinned chat does not inherit the pin', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }], [{ text: 'ok' }]], ...setup });
    await pinned(t);
    const r = t.engine.routines.create({ name: 'Daily', schedule: '20 8 * * *', prompt: 'Say ok', cwd: t.cwd, notify: 'never' });
    const run = await t.engine.routines.runNow(r.id, 'manual');
    const s = t.engine.getSession(run.sessionId!)!;
    expect(s.chat?.sameModel).toBeUndefined();
    expect(modelPin(t.engine, s)).toBeUndefined();
  });

  test('a member cannot pin to a model their account may not use', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]], ...setup });
    const alice = t.engine.people.create({ name: 'alice' });
    const hers = await t.engine.createSession({ kind: 'chat', model: PIN }, alice.id);
    expect(() => t!.engine.updateSession(hers.id, { chat: { sameModel: true } })).toThrow('Same model for all work needs a model your account may use');
    // a row that has the switch anyway (set before a grant was taken back) pins nothing
    t.engine.repos.sessions.update({ ...hers, chat: { webSearch: true, memory: true, sameModel: true } });
    expect(modelPin(t.engine, t.engine.getSession(hers.id)!)).toBeUndefined();
  });
});
