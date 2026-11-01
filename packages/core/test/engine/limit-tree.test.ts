import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainFor, checkChain, limitText, subtreeUse, type LimitNode } from '../../src/session/limit-tree';
import { setWorkflows } from '../../src/workflows/attached';
import type { Message, TextBlock } from '../../src/types';
import { firstUserText, startTestEngine, type Block } from './harness';

/** HARNESS-REVIEW item 24: spend and work limits per session and subagent tree. */

const node = (key: string, limits: LimitNode['limits'], used: Partial<ReturnType<LimitNode['used']>>): LimitNode => ({
  key,
  label: key,
  limits,
  used: () => ({ tokens: 0, costUsd: 0, turns: 0, minutes: 0, ...used }),
});
const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);

describe('limit tree checks', () => {
  test('outermost node first; a hard hit wins over a soft one; soft at 80 percent', () => {
    const root = node('session:root', { costUsd: 1 }, { costUsd: 0.85 });
    const child = node('session:child', { tokens: 100 }, { tokens: 120 });
    expect(checkChain([root, child])).toMatchObject({ level: 'hard', kind: 'tokens', node: child });
    expect(checkChain([root])).toMatchObject({ level: 'soft', kind: 'costUsd', node: root });
    const outer = node('session:outer', { turns: 10 }, { turns: 10 });
    expect(checkChain([outer, child])).toMatchObject({ level: 'hard', node: outer });
    expect(checkChain([node('session:x', { minutes: 60 }, { minutes: 10 })])).toBeUndefined();
    expect(limitText({ level: 'hard', node: node('workflow:wfr_1', { tokens: 5 }, {}), kind: 'tokens', used: 6, limit: 5 })).toBe('The workflow budget is spent; this step stops here.');
  });
});

describe('limits in the engine', () => {
  const readInput = { file_path: '' };
  const read: Block = { tool: 'Read', input: readInput };

  test('the hard cap stops before the next model call, from the usage of the calls so far', async () => {
    const t = await startTestEngine({ script: [[read], [read], [read], [{ text: 'done' }]] });
    try {
      readInput.file_path = join(t.cwd, 'a.txt');
      writeFileSync(readInput.file_path, 'hi');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      // each scripted reply reports 5 output tokens
      t.engine.patchMeta(s.id, { limits: { tokens: 10 } });
      await t.run(s.id, 'read');
      expect(t.requests).toHaveLength(2);
      expect(notices(t.engine.getMessages(s.id))).toContain('Stopped: this session reached its limit of 10 output tokens (10 used).');
      expect(t.engine.listAudit({ sessionId: s.id }).some((a) => a.action === 'limit')).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('past 80 percent an interactive session is asked once; a denial stops the turn', async () => {
    const t = await startTestEngine({ script: [[read], [read], [read], [{ text: 'done' }]] });
    try {
      readInput.file_path = join(t.cwd, 'a.txt');
      writeFileSync(readInput.file_path, 'hi');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      t.engine.patchMeta(s.id, { limits: { tokens: 12 } });
      await t.run(s.id, 'read');
      expect(t.approvals.some((a) => a.includes('This session used 10 of its limit of 12 output tokens. Keep going?'))).toBe(true);
      expect(t.requests).toHaveLength(2);
      expect(notices(t.engine.getMessages(s.id)).some((n) => n.startsWith("Stopped at the owner's request"))).toBe(true);
      expect(t.engine.getSession(s.id)!.meta?.limitAnswers).toEqual({ [`session:${s.id}:tokens`]: 'deny' });
    } finally {
      await t.close();
    }
  }, 30_000);

  test("a subagent stops on its parent's limit (the outer node), counted over the whole tree", async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'child', prompt: 'CHILD: read', subagent_type: 'general-purpose' } }], [{ text: 'parent done' }]],
      route: (body) => (firstUserText(body).includes('CHILD') ? [read] : undefined),
    });
    try {
      readInput.file_path = join(t.cwd, 'a.txt');
      writeFileSync(readInput.file_path, 'hi');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      t.engine.patchMeta(s.id, { limits: { costUsd: 0.0002 } });
      await t.run(s.id, 'delegate');
      const child = t.engine.listSessions({ parentId: s.id })[0]!;
      const childCalls = t.requests.filter((r) => firstUserText(JSON.parse(r)).includes('CHILD')).length;
      // parent call + child calls until the tree's cost passes the parent's limit
      expect(childCalls).toBeGreaterThan(0);
      expect(childCalls).toBeLessThan(10);
      expect(notices(t.engine.getMessages(child.id)).some((n) => n.startsWith(`Stopped: session ${s.id} reached its limit of $0.00`))).toBe(true);
      expect(subtreeUse(t.engine, s.id).costUsd).toBeGreaterThanOrEqual(0.0002);
      expect(subtreeUse(t.engine, s.id).turns).toBe(1 + childCalls);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a model with no price asks once per tree when a cost limit applies', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'one' }], [{ text: 'two' }]],
      approve: 'allow',
      modelOverrides: { 'claude-sonnet-5-5': { inputPrice: 0, outputPrice: 0, cacheReadPrice: 0, cacheWritePrice: 0 } },
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      t.engine.patchMeta(s.id, { limits: { costUsd: 1 } });
      await t.run(s.id, 'one');
      await t.run(s.id, 'two');
      expect(t.approvals.filter((a) => a.includes('has no price'))).toHaveLength(1);
      expect(t.requests).toHaveLength(2);
    } finally {
      await t.close();
    }
  }, 30_000);

  test("a workflow run's budget is a node between the session and the run's agents", async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const root = await t.engine.createSession({ title: 'root', cwd: t.cwd });
      t.engine.patchMeta(root.id, { limits: { costUsd: 50 } });
      const agent = await t.engine.createSession({ title: 'step', cwd: t.cwd, parentId: root.id });
      t.engine.patchMeta(agent.id, { workflow: { runId: 'wfr_test' } });
      setWorkflows(t.engine, { shutdown: async () => undefined, budgetNode: (id: string) => (id === 'wfr_test' ? { limits: { tokens: 100 }, used: () => ({ tokens: 150, costUsd: 0, turns: 0, minutes: 0 }) } : undefined) } as never);
      const chain = chainFor(t.engine, t.engine.getSession(agent.id)!);
      expect(chain.map((n) => n.key)).toEqual([`session:${root.id}`, 'workflow:wfr_test']);
      const hit = checkChain(chain)!;
      expect(hit).toMatchObject({ level: 'hard', kind: 'tokens' });
      expect(limitText(hit)).toBe('The workflow budget is spent; this step stops here.');
    } finally {
      await t.close();
    }
  });

  test('working time counts running only, not waiting for an approval', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      t.engine.setStatus(s.id, 'running');
      await Bun.sleep(120);
      t.engine.setStatus(s.id, 'waiting_approval');
      await Bun.sleep(200);
      t.engine.setStatus(s.id, 'running');
      await Bun.sleep(60);
      t.engine.setStatus(s.id, 'idle');
      const ms = t.engine.getSession(s.id)!.meta?.workMs as number;
      expect(ms).toBeGreaterThanOrEqual(170);
      expect(ms).toBeLessThan(300);
    } finally {
      await t.close();
    }
  });
});
