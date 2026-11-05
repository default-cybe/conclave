import { describe, expect, test } from 'bun:test';
import { shellRegistry } from '../../src/tools/shells';
import { startTestEngine } from './harness';

describe('the hub stopping', () => {
  test('ends the background shells it started: they are its children, not left orphaned', async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'Bash', input: { command: 'sleep 60', run_in_background: true, description: 'Wait a minute' } }], [{ text: 'started' }]],
      approve: 'allow',
    });
    let pid: number | undefined;
    try {
      const s = await t.engine.createSession({ cwd: t.cwd });
      await t.run(s.id, 'start it');
      const [shell] = shellRegistry.list(s.id);
      expect(shell?.status).toBe('running');
      pid = shell?.pid;
      await t.engine.shutdown();
      expect(shellRegistry.list(s.id)).toEqual([]);
    } finally {
      await t.close();
    }
    // the process is gone too
    expect(pid).toBeNumber();
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 30_000);
});
