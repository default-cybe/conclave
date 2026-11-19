import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults, type Step } from './harness';

test("a followed shell folder that is gone resets to the session's folder", async () => {
  let plan: Step[] = [];
  const t = await startTestEngine({ script: [[{ text: 'ok' }]], route: () => plan.shift() });
  try {
    const sub = join(t.cwd, 'gone-soon');
    mkdirSync(sub);
    const s = await t.engine.createSession({ cwd: t.cwd });
    plan = [[{ tool: 'Bash', input: { command: 'cd gone-soon' } }], [{ text: 'in it' }]];
    await t.run(s.id, 'go in');
    rmSync(sub, { recursive: true });
    plan = [[{ tool: 'Bash', input: { command: 'echo one' } }], [{ tool: 'Bash', input: { command: 'pwd' } }], [{ text: 'done' }]];
    await t.run(s.id, 'run twice');
    const bash = toolResults(t.engine, s.id).filter((r) => r.name === 'Bash');
    const [failed, after] = bash.slice(-2);
    expect(failed.content).toContain('Working directory does not exist:');
    expect(failed.content).toContain("The shell's working directory is reset to");
    expect(after.isError).toBe(false);
    expect(after.content).toContain(t.cwd);
  } finally {
    await t.close();
  }
});
