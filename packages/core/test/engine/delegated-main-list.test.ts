/**
 * Delegated work and Move to main list (session/delegated.ts,
 * engine/delegate.ts moveToMainList): a Delegate call's session stays out of
 * the main list until the owner moves it; then it is a normal session of its
 * kind, its parentId kept for history and the caller's finished call still
 * pointing at it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, type Block, type RequestBody, type TestEngine } from './harness';
import { delegateRefusal } from '../../src/engine/delegate';
import { chainFor } from '../../src/session/limit-tree';
import { delegateMark, isDelegated, movedSession, movedToMain, underParent } from '../../src/session/delegated';
import type { EngineEvent, Session, ToolResultBlock } from '../../src/types';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BRIEF = 'CHILD-BRIEF: list the TODOs in this folder.';
const isChild = (body: RequestBody) => firstUserText(body).includes('CHILD-BRIEF');
const call = (input: Record<string, unknown> = {}): Block => ({ tool: 'Delegate', input: { to: 'code', prompt: BRIEF, description: 'List the TODOs', ...input } });

function resultOf(t: TestEngine, sessionId: string): ToolResultBlock | undefined {
  for (const m of t.engine.getMessages(sessionId)) for (const b of m.content) if (b.type === 'tool_result') return b;
  return undefined;
}

/** A chat that delegated one job, which answered. */
async function delegatedOnce(): Promise<{ t: TestEngine; chat: Session; child: Session }> {
  const te = await startTestEngine({ script: [[call()], [{ text: 'Two TODOs.' }]], route: (body) => (isChild(body) ? [{ text: 'TODO: a, b' }] : undefined) });
  const chat = await te.engine.createSession({ kind: 'chat', title: 'Capstone' });
  await te.run(chat.id, 'ask code for the todos');
  const child = te.engine.listSessions({ parentId: chat.id })[0];
  return { t: te, chat, child };
}

describe('delegated work', () => {
  test('is marked, runs under its caller and stays out of the top-level list', async () => {
    const r = await delegatedOnce();
    t = r.t;
    expect(isDelegated(r.child)).toBe(true);
    expect(underParent(r.child)).toBe(true);
    expect(r.child.tags).toEqual(['subagent', 'delegated']);
    expect(r.child.meta?.subagent).toBe(true);
    const top = t.engine.listSessions({ parentId: null }).map((s) => s.id);
    expect(top).toContain(r.chat.id);
    expect(top).not.toContain(r.child.id);
  });
});

describe('Move to main list', () => {
  test('clears the marks, keeps parentId and the place as movedFrom, and lists it as a normal session', async () => {
    const r = await delegatedOnce();
    t = r.t;
    const events: EngineEvent[] = [];
    t.engine.bus.on((e) => void events.push(e));
    const place = delegateMark(r.child)!;

    const moved = t.engine.moveToMainList(r.child.id);
    expect(moved.parentId).toBe(r.chat.id);
    expect(moved.tags).toEqual([]);
    expect(moved.meta?.subagent).toBeUndefined();
    expect(moved.meta?.delegate).toBeUndefined();
    expect(moved.meta?.movedFrom).toMatchObject({ ...place, at: expect.any(Number) });
    expect(movedToMain(moved)).toBe(true);
    expect(isDelegated(moved)).toBe(false);
    expect(underParent(moved)).toBe(false);
    // the hub keeps it so, and the apps hear of it
    expect(t.engine.getSession(r.child.id)).toEqual(moved);
    expect(events.some((e) => e.type === 'session.updated' && e.session.id === r.child.id)).toBe(true);

    // a top-level session now, and still its caller's child for history
    expect(t.engine.listSessions({ parentId: null }).map((s) => s.id)).toContain(r.child.id);
    expect(t.engine.listSessions({ parentId: r.chat.id }).map((s) => s.id)).toEqual([r.child.id]);

    // the caller's finished call still names it and where it ran
    const res = resultOf(t, r.chat.id)!;
    expect(res.meta?.sessionId).toBe(r.child.id);
    expect((res.meta?.delegate as { device: string }).device).toBe('local');

    // a primary session now: it may hand work on, and its limits are its own
    expect(delegateRefusal(t.engine, moved, 0)).toBeUndefined();
    expect(t.engine.runnerFor(r.child.id).depth).toBe(0);
    t.engine.patchMeta(r.chat.id, { limits: { tokens: 5 } });
    expect(chainFor(t.engine, t.engine.getSession(r.child.id)!).map((n) => n.key)).not.toContain(`session:${r.chat.id}`);
    // its approvals and questions show in it, not in the chat it came from
    expect(t.engine.askOrigin(r.child.id)).toEqual({ rootSessionId: r.child.id });

    // moving it again changes nothing
    expect(t.engine.moveToMainList(r.child.id).meta?.movedFrom).toEqual(moved.meta?.movedFrom);
  });

  test('only delegated work moves, and not while it works on the job', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const chat = await t.engine.createSession({ kind: 'chat' });
    expect(() => t!.engine.moveToMainList(chat.id)).toThrow('Only delegated work moves to the main list.');
    const sub = await t.engine.createSession({ agent: 'explore', cwd: t.cwd, parentId: chat.id, tags: ['subagent'] });
    expect(() => t!.engine.moveToMainList(sub.id)).toThrow('Only delegated work moves');
    const busy = await t.engine.createSession({ agent: 'coder', cwd: t.cwd, parentId: chat.id, tags: ['subagent', 'delegated'] });
    t.engine.patchMeta(busy.id, { subagent: true, delegate: { to: 'code', device: 'local', deviceName: 'hub', toolUseId: 'tu_1' } });
    t.engine.setStatus(busy.id, 'running');
    expect(() => t!.engine.moveToMainList(busy.id)).toThrow('still working on the job');
    t.engine.setStatus(busy.id, 'idle');
    expect(t.engine.moveToMainList(busy.id).tags).toEqual([]);
    expect(() => t!.engine.moveToMainList('ses_nope')).toThrow('not found');
  });

  test('movedSession is pure: it keeps other meta and tags', () => {
    const s = { id: 's', tags: ['subagent', 'delegated', 'mine'], meta: { subagent: true, delegate: { to: 'assistant', deviceName: 'hub' }, untrusted: true }, parentId: 'p', updatedAt: 1 } as unknown as Session;
    const m = movedSession(s, 50);
    expect(m.tags).toEqual(['mine']);
    expect(m.meta).toEqual({ untrusted: true, movedFrom: { to: 'assistant', deviceName: 'hub', at: 50 } });
    expect(m.updatedAt).toBe(50);
    expect(m.parentId).toBe('p');
    // the original is untouched
    expect(s.meta?.delegate).toBeDefined();
  });
});
