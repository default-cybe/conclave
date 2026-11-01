/**
 * Approvals and questions from subagents name the chat the owner is in
 * (engine/ask-origin.ts): rootSessionId walks parentId (and a workflow
 * agent's run) up to the top session, and `from` says who asks. The request
 * keeps the asking session as sessionId. No paid calls.
 */
import { describe, expect, test } from 'bun:test';
import { askOrigin, type AskLookup } from '../../src/engine/ask-origin';
import type { ApprovalRequest, QuestionRequest, Session } from '../../src/types';
import { afterToolResult } from '../workflows/helpers';
import { firstUserText, startTestEngine, until } from '../engine/harness';

function ses(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    agent: 'assistant',
    model: 'mock/m',
    mode: 'agent',
    permissionMode: 'default',
    cwd: '/',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ...extra,
  };
}

function lookup(list: Session[], runs: Record<string, { sessionId?: string; name: string }> = {}): AskLookup {
  const byId = new Map(list.map((s) => [s.id, s]));
  return { session: (id) => byId.get(id), run: (id) => runs[id] };
}

describe('askOrigin', () => {
  const root = ses('ses_root', { title: 'Find my Lisbon mail' });
  const child = ses('ses_child', { agent: 'email', title: 'Find the booking mail', parentId: 'ses_root', tags: ['subagent'], meta: { subagent: true } });
  const grandchild = ses('ses_gc', { agent: 'explore', title: 'Read the thread', parentId: 'ses_child', tags: ['subagent'], meta: { subagent: true } });

  test('a top session is its own root and says nothing more', () => {
    expect(askOrigin(lookup([root]), 'ses_root')).toEqual({ rootSessionId: 'ses_root' });
  });

  test('one level of subagent: the parent is the root, from names the subagent', () => {
    expect(askOrigin(lookup([root, child]), 'ses_child')).toEqual({
      rootSessionId: 'ses_root',
      from: { sessionId: 'ses_child', agent: 'email', label: 'Find the booking mail', chain: ['ses_child'] },
    });
  });

  test('two levels: the top session is the root, the chain runs down to the asker', () => {
    expect(askOrigin(lookup([root, child, grandchild]), 'ses_gc')).toEqual({
      rootSessionId: 'ses_root',
      from: { sessionId: 'ses_gc', agent: 'explore', label: 'Read the thread', chain: ['ses_child', 'ses_gc'] },
    });
  });

  test("a workflow agent: its label and the run's workflow name; a row without parentId goes up through its run", () => {
    const meta = { subagent: true, workflow: { runId: 'wfr_1', seq: 3, label: 'search r1 3' } };
    const runs = { wfr_1: { sessionId: 'ses_root', name: 'deep-research' } };
    const want = { rootSessionId: 'ses_root', from: { sessionId: 'ses_wf', agent: 'workflow', label: 'search r1 3', workflow: { runId: 'wfr_1', name: 'deep-research' }, chain: ['ses_wf'] } };
    const withParent = ses('ses_wf', { agent: 'workflow', title: 'deep-research / search r1 3', parentId: 'ses_root', tags: ['subagent', 'workflow'], meta });
    expect(askOrigin(lookup([root, withParent], runs), 'ses_wf')).toEqual(want);
    const runOnly = ses('ses_wf', { agent: 'workflow', title: 'deep-research / search r1 3', tags: ['subagent', 'workflow'], meta });
    expect(askOrigin(lookup([root, runOnly], runs), 'ses_wf')).toEqual(want);
    // the run is gone: the title still names the workflow
    expect(askOrigin(lookup([root, withParent]), 'ses_wf').from?.workflow).toEqual({ runId: 'wfr_1', name: 'deep-research' });
  });

  test('a missing parent, a loop and an unknown session stop the walk', () => {
    const orphan = ses('ses_orphan', { parentId: 'ses_gone' });
    expect(askOrigin(lookup([orphan]), 'ses_orphan')).toEqual({ rootSessionId: 'ses_orphan' });
    const a = ses('ses_a', { parentId: 'ses_b' });
    const b = ses('ses_b', { parentId: 'ses_a' });
    expect(askOrigin(lookup([a, b]), 'ses_a').rootSessionId).toBe('ses_b');
    expect(askOrigin(lookup([]), 'ses_x')).toEqual({ rootSessionId: 'ses_x' });
  });
});

const isLeaf = (body: { messages?: unknown[] }) => firstUserText(body).includes('LEAF-BRIEF');
const isMid = (body: { messages?: unknown[] }) => firstUserText(body).includes('MID-BRIEF');

describe('the hub sets rootSessionId and from on real subagents', () => {
  test('one level: a subagent asks; the event names the top session, keeps the asker, and answering resolves it there', async () => {
    const seen: ApprovalRequest[] = [];
    const t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'Find the booking mail', prompt: 'LEAF-BRIEF find the mail', subagent_type: 'general-purpose' } }], [{ text: 'Found it.' }]],
      route: (body) => (isLeaf(body) ? (afterToolResult(body) ? [{ text: 'leaf done' }] : [{ tool: 'Bash', input: { command: 'git push origin main' } }]) : undefined),
    });
    const off = t.engine.bus.on((e) => {
      if (e.type === 'approval.requested') seen.push(structuredClone(e.approval));
    });
    try {
      const s = await t.engine.createSession({ title: 'Find my mail', cwd: t.cwd });
      await t.run(s.id, 'find my mail');
      const child = t.engine.listSessions({ parentId: s.id })[0]!;
      expect(child).toBeDefined();
      expect(seen.length).toBe(1);
      expect(seen[0].sessionId).toBe(child.id);
      expect(seen[0].rootSessionId).toBe(s.id);
      expect(seen[0].from).toEqual({ sessionId: child.id, agent: 'general-purpose', label: 'Find the booking mail', chain: [child.id] });
    } finally {
      off();
      await t.close();
    }
  }, 60_000);

  test('two levels: the grandchild asks and the top session is the root', async () => {
    const seen: ApprovalRequest[] = [];
    const t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'Look into it', prompt: 'MID-BRIEF go deeper', subagent_type: 'general-purpose' } }], [{ text: 'Done.' }]],
      route: (body) => {
        if (isLeaf(body)) return afterToolResult(body) ? [{ text: 'leaf done' }] : [{ tool: 'Bash', input: { command: 'git push origin main' } }];
        if (isMid(body)) return afterToolResult(body) ? [{ text: 'mid done' }] : [{ tool: 'Task', input: { description: 'Read the thread', prompt: 'LEAF-BRIEF read it', subagent_type: 'general-purpose' } }];
        return undefined;
      },
    });
    const off = t.engine.bus.on((e) => {
      if (e.type === 'approval.requested') seen.push(structuredClone(e.approval));
    });
    try {
      const s = await t.engine.createSession({ title: 'Top', cwd: t.cwd });
      await t.run(s.id, 'go');
      const mid = t.engine.listSessions({ parentId: s.id })[0]!;
      const leaf = t.engine.listSessions({ parentId: mid.id })[0]!;
      expect(leaf).toBeDefined();
      expect(seen.length).toBe(1);
      expect(seen[0]).toMatchObject({ sessionId: leaf.id, rootSessionId: s.id, from: { sessionId: leaf.id, label: 'Read the thread', chain: [mid.id, leaf.id] } });
    } finally {
      off();
      await t.close();
    }
  }, 60_000);

  test("questions carry it too; a child's request lists for its account, answers there, and a top session's request names itself", async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const asked: QuestionRequest[] = [];
    const off = t.engine.bus.on((e) => {
      if (e.type === 'question.asked') asked.push(structuredClone(e.question));
    });
    try {
      const top = await t.engine.createSession({ title: 'Assistant chat', cwd: t.cwd });
      const now = Date.now();
      const child: Session = { ...top, id: 'ses_child_q', title: 'Find the booking mail', agent: 'email', parentId: top.id, tags: ['subagent'], meta: { subagent: true }, createdAt: now, updatedAt: now };
      t.engine.repos.sessions.insert(child);
      const ac = new AbortController();
      const answer = t.engine.askUser(child.id, [{ question: 'Which inbox?', options: [{ label: 'Work' }, { label: 'Home' }] }], ac.signal);
      expect(asked[0]).toMatchObject({ sessionId: child.id, rootSessionId: top.id, from: { sessionId: child.id, agent: 'email', label: 'Find the booking mail', chain: [child.id] } });
      // the list the apps load carries the same fields
      const listed = t.engine.pendingQuestions('owner').find((q) => q.id === asked[0].id)!;
      expect(listed).toMatchObject({ sessionId: child.id, rootSessionId: top.id, from: { agent: 'email' } });
      expect(t.engine.pendingAccount(asked[0].id)).toBe('owner');
      expect(t.engine.answerQuestion(asked[0].id, { 'Which inbox?': 'Work' })).toBe(true);
      expect(await answer).toEqual({ 'Which inbox?': 'Work' });

      // the top session's own question names itself and says nothing more
      const own = t.engine.askUser(top.id, [{ question: 'Now?', options: [{ label: 'Yes' }] }], ac.signal);
      expect(asked[1].rootSessionId).toBe(top.id);
      expect(asked[1].from).toBeUndefined();
      ac.abort();
      expect(await own).toEqual({});
      expect(await until(() => t.engine.pendingQuestions().length === 0)).toBe(true);
    } finally {
      off();
      await t.close();
    }
  }, 30_000);
});
