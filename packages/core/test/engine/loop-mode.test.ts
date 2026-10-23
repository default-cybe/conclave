import { describe, expect, test } from 'bun:test';
import { startTestEngine } from './harness';

describe('loop mode', () => {
  test('each user turn gets the full number of iterations', async () => {
    const t = await startTestEngine({ script: [[{ text: 'DONE' }], [{ text: 'not yet' }], [{ text: 'not yet' }], [{ text: 'not yet' }], [{ text: 'not yet' }]] });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, mode: 'loop', modeConfig: { loop: { untilText: 'DONE', maxIterations: 3 } } });
      await t.run(s.id, 'first task');
      expect(t.requests.length).toBe(1);
      // the first turn's count must not eat into the second turn's budget
      await t.run(s.id, 'second task');
      expect(t.requests.length).toBe(4);
    } finally {
      await t.close();
    }
  }, 30_000);
});
