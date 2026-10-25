import { describe, expect, test } from 'bun:test';
import type { Block } from './harness';
import { firstUserText, startTestEngine, until } from './harness';

/**
 * A background Task child the owner paused: TaskWait returns with state
 * paused instead of waiting for it, and Resume lets it finish and report.
 */

const BRIEF = 'CHILD-BRIEF: slow job';
const task: Block = { tool: 'Task', input: { description: 'slow job', prompt: BRIEF, subagent_type: 'general-purpose', run_in_background: true } };
const isChild = (body: { messages?: unknown[] }) => firstUserText(body).includes('CHILD-BRIEF');
const afterTool = (text: string) => text.includes('"tool_result"') && text.includes('CHILD-SLEPT');

describe('pause a background task', () => {
  test('TaskWait returns paused; Resume continues the child and its report reaches the parent', async () => {
    const t = await startTestEngine({
      script: [[task], [{ text: 'started it' }], [{ text: 'got the report' }]],
      route: (body, text) => (isChild(body) ? (afterTool(text) ? [{ text: 'REPORT: done' }] : [{ tool: 'Bash', input: { command: 'sleep 0.6; echo CHILD-SLEPT', description: 'wait' } }]) : undefined),
      approve: 'allow',
    });
    try {
      const s = await t.engine.createSession({ title: 'parent', cwd: t.cwd });
      t.engine.runnerFor(s.id).noteDelayMs = 50;
      await t.run(s.id, 'start');
      const child = () => t.engine.listSessions({ parentId: s.id })[0];
      expect(await until(() => !!child() && t.engine.getMessages(child()!.id).some((m) => m.content.some((b) => b.type === 'tool_use')), 10_000)).toBe(true);
      const id = child()!.id;
      t.engine.pauseSession(id);
      expect(await until(() => t.engine.getSession(id)?.status === 'paused', 10_000)).toBe(true);
      const childRequests = () => t.requests.filter((r) => isChild(JSON.parse(r)));
      expect(childRequests().length).toBe(1);

      // TaskWait does not wait for a paused task
      const at = Date.now();
      const r = await t.engine.backgroundTasks.wait(s.id, undefined, 30);
      expect(Date.now() - at).toBeLessThan(5_000);
      expect(r.tasks.map((x) => x.state)).toEqual(['paused']);
      expect(t.engine.backgroundTasks.list(s.id)[0]?.state).toBe('paused');

      await t.engine.resumeSession(id);
      expect(await until(() => (t.engine.getSession(id)?.meta?.background as { state?: string })?.state === 'completed', 10_000)).toBe(true);
      expect(childRequests().length).toBe(2);
      // the child's turn went on from its tool result, with no new user message
      expect(t.engine.getMessages(id).filter((m) => m.role === 'user' && m.kind === 'normal' && m.content.some((b) => b.type === 'text' && b.text.includes('CHILD-BRIEF'))).length).toBe(1);
      expect(await until(() => t.requests.some((x) => !isChild(JSON.parse(x)) && x.includes('REPORT: done')), 10_000)).toBe(true);
    } finally {
      await t.close();
    }
  });
});
