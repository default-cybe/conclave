import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { takeCheckpoint } from '../../src/session/checkpoints';
import { startTestEngine } from './harness';

describe('checkpoints', () => {
  test('a home folder, or one above it, is not copied; a project folder is', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const home = join(t.cwd, 'home', 'me');
      mkdirSync(join(home, 'project'), { recursive: true });
      // the machine's home for this test: a folder the test owns
      t.engine.machineHome = async () => home;
      const machine = t.engine.localMachine;
      for (const cwd of [home, join(t.cwd, 'home'), join(home, 'project')]) {
        const s = await t.engine.createSession({ cwd });
        await takeCheckpoint(t.engine, t.engine.getSession(s.id)!, machine);
        expect(t.engine.checkpoints(s.id).length).toBe(cwd.endsWith('project') ? 1 : 0);
      }
    } finally {
      await t.close();
    }
  }, 30_000);
});
