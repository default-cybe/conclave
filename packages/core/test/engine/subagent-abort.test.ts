import { describe, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, until } from './harness';

const childOf = (body: { messages?: unknown[] }) => /CHILD-(\w+)/.exec(firstUserText(body))?.[1];

describe('a background subagent', () => {
  test('stops when its session is stopped, and when its parent is deleted', async () => {
    let childCalls = 0;
    const t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'busy job', prompt: 'CHILD-A: keep looking', subagent_type: 'general-purpose', run_in_background: true } }], [{ text: 'started' }], [{ tool: 'Task', input: { description: 'busy job', prompt: 'CHILD-B: keep looking', subagent_type: 'general-purpose', run_in_background: true } }], [{ text: 'started' }]],
      // the child never finishes on its own: every reply is another search
      route: (body) => (childOf(body) ? { blocks: [{ tool: 'Glob', input: { pattern: `*.none${++childCalls}` } }], delayMs: 50 } : undefined),
    });
    try {
      const s = await t.engine.createSession({ title: 'parent', cwd: t.cwd, agent: 'general-purpose' });
      await t.run(s.id, 'start a job');
      const child = () => t.engine.listSessions({ parentId: s.id }).find((c) => c.status === 'running');
      expect(await until(() => !!child())).toBe(true);
      t.engine.abort(child()!.id);
      expect(await until(() => !child())).toBe(true);
      const after = childCalls;
      await Bun.sleep(300);
      expect(childCalls).toBe(after);

      await t.run(s.id, 'start another');
      expect(await until(() => !!child())).toBe(true);
      const id = child()!.id;
      await t.engine.deleteSession(s.id);
      expect(await until(() => t.engine.getSession(id)?.status !== 'running')).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);
});
