import { describe, expect, test } from 'bun:test';
import { shellRegistry } from '../../src/tools/shells';
import { startTestEngine, until } from './harness';

describe('deleting a session', () => {
  test('stops the background shells it started', async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'Bash', input: { command: 'sleep 60', run_in_background: true, description: 'Wait a minute' } }], [{ text: 'started' }]],
      approve: 'allow',
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd });
      await t.run(s.id, 'start a server');
      const [shell] = shellRegistry.list(s.id);
      expect(shell?.status).toBe('running');
      await t.engine.deleteSession(s.id);
      expect(await until(() => shellRegistry.list(s.id).length === 0)).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);
});
