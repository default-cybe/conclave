import { describe, expect, test } from 'bun:test';
import { createEngine } from '../../src/engine';
import { TaskResultTool } from '../../src/tools/background-tasks';
import { firstUserText, startTestEngine, toolResults, until, type Block } from './harness';
import { makeCtx, fakeHost } from '../tools/helpers';

/** HARNESS-REVIEW item 21: background task tools over the children Task started. */

const task = (tag: string): Block => ({ tool: 'Task', input: { description: `job ${tag}`, prompt: `CHILD-${tag}: do the job`, subagent_type: 'general-purpose', run_in_background: true } });
const childOf = (body: { messages?: unknown[] }) => /CHILD-(\w+)/.exec(firstUserText(body))?.[1];

describe('background task tools', () => {
  test('the tools appear after the first background Task; TaskWait returns the first to finish; TaskResult and TaskContinue work', async () => {
    let continued = false;
    const t = await startTestEngine({
      script: [[task('A'), task('B')], [{ tool: 'TaskWait', input: { timeoutSec: 10 } }], [{ text: 'one done' }], [{ text: 'noted' }], [{ text: 'noted again' }]],
      route: (body, text) => {
        const c = childOf(body);
        if (c === 'A') return continued && text.includes('one more check') ? [{ text: 'REPORT A2' }] : { blocks: [{ text: 'REPORT A' }], delayMs: 150 };
        if (c === 'B') return { blocks: [{ text: 'REPORT B' }], delayMs: 1_200 };
        return undefined;
      },
    });
    try {
      const s = await t.engine.createSession({ title: 'parent', cwd: t.cwd, agent: 'general-purpose' });
      t.engine.runnerFor(s.id).noteDelayMs = 30;
      await t.run(s.id, 'start two jobs');
      const parent = t.requests.filter((r) => !childOf(JSON.parse(r)));
      const names = (r: string) => (JSON.parse(r).tools as Array<{ name: string }>).map((x) => x.name);
      expect(names(parent[0])).not.toContain('TaskList');
      expect(names(parent[1]).slice(-4)).toEqual(['TaskList', 'TaskWait', 'TaskResult', 'TaskContinue']);

      const [a, b] = t.engine.backgroundTasks.list(s.id);
      expect(a.description).toBe('job A');
      const wait = toolResults(t.engine, s.id).find((r) => r.name === 'TaskWait')!;
      expect(wait.content).toContain(`Finished while waiting: ${a.id}.`);
      expect(wait.content).toContain(`- ${b.id} running (general-purpose: job B)`);

      expect(await until(() => t.engine.backgroundTasks.get(s.id, b.id)?.state === 'completed', 10_000)).toBe(true);
      const ctx = makeCtx({ cwd: t.cwd, host: { ...fakeHost(), tasks: t.engine.backgroundTasks }, sessionId: s.id });
      const res = await TaskResultTool.run({ id: b.id }, ctx);
      expect(String(res.content)).toContain('REPORT B');

      continued = true;
      const next = t.engine.backgroundTasks.continue(s.id, a.id, 'one more check');
      expect(typeof next === 'object' && next.state).toBe('running');
      expect(t.engine.backgroundTasks.continue(s.id, a.id, 'again')).toContain('still running');
      expect(await until(() => t.engine.backgroundTasks.get(s.id, a.id)?.state === 'completed', 10_000)).toBe(true);
      expect(t.engine.backgroundTasks.result(s.id, a.id)?.text).toBe('REPORT A2');
      await until(() => !t.engine.runnerFor(s.id).busy && t.engine.runnerFor(s.id).pendingNoteCount === 0, 5_000);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a routine that ends with a task still running hears it once', async () => {
    const t = await startTestEngine({
      script: [[task('C')], [{ text: 'started it' }], [{ text: 'finishing anyway' }]],
      route: (body) => (childOf(body) === 'C' ? { blocks: [{ text: 'REPORT C' }], delayMs: 1_500 } : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 'routine', cwd: t.cwd, agent: 'general-purpose', tags: ['routine'] });
      await t.run(s.id, 'nightly job');
      const parent = t.requests.filter((r) => !childOf(JSON.parse(r)));
      expect(parent).toHaveLength(3);
      expect(parent[2]).toContain('Background tasks still running:');
      expect(parent[2]).toContain('This run ends with your reply.');
      expect(parent[1]).not.toContain('Background tasks still running');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('at boot a child that was running is lost, and its parent hears so on its next turn', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const parent = await t.engine.createSession({ title: 'parent', cwd: t.cwd });
      const child = await t.engine.createSession({ title: 'long job', cwd: t.cwd, parentId: parent.id });
      t.engine.patchMeta(child.id, { subagent: true, background: { parentId: parent.id, state: 'running', startedAt: Date.now() } });
      t.engine.setStatus(child.id, 'running');

      const e2 = await createEngine({ home: t.home, noBackground: true, version: 'test', overrides: { memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 } } as never });
      try {
        expect(e2.backgroundTasks.get(parent.id, child.id)?.state).toBe('lost');
        expect(e2.getSession(child.id)!.status).toBe('idle');
        expect(e2.runnerFor(parent.id).pendingNoteCount).toBe(1);
        expect(e2.getMessages(parent.id).some((m) => m.kind === 'notice' && JSON.stringify(m.content).includes('Background task lost in a hub restart: long job'))).toBe(true);
      } finally {
        await e2.shutdown();
      }
    } finally {
      await t.close();
    }
  }, 30_000);
});
