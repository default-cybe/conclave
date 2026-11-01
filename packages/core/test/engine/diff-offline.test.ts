import { describe, expect, spyOn, test } from 'bun:test';
import { OWNER_ID } from '../../src/people/context';
import { FakeMachine } from '../machine/fake-machine';
import { startTestEngine, type TestEngine } from './harness';

/**
 * The diff endpoint's offline fallback (optimisation review 2026-11-01, fix 4):
 * a session on a device that is offline gets an empty diff with offline: true
 * (200), not a 409, so the session page still loads and can say why.
 */
describe('session diff on an offline device', () => {
  test('returns an empty diff with offline: true', async () => {
    const t: TestEngine = await startTestEngine({ script: [[{ text: 'hi' }]] });
    try {
      t.engine.repos.devices.insert({ id: 'dev-gone', name: 'Gone', tokenHash: 'x' });
      const s = await t.engine.createSession({ agent: 'coder', device: 'dev-gone', title: 'off' }, OWNER_ID);
      expect(t.engine.requireSession(s.id).device).toBe('dev-gone');
      expect(await t.engine.diff(s.id)).toEqual({ diff: '', files: [], offline: true });
    } finally {
      await t.close();
    }
  }, 30_000);

  test('keeps online diffs and non-offline errors unchanged', async () => {
    const t = await startTestEngine({ script: [[{ text: 'hi' }]] });
    const machine = new FakeMachine('dev-online');
    const exec = spyOn(machine, 'exec');
    try {
      t.engine.repos.devices.insert({ id: machine.id, name: machine.name, tokenHash: 'test' });
      t.engine.devices.attach({ ...t.engine.repos.devices.get(machine.id)!, online: true }, machine);
      const s = await t.engine.createSession({ device: machine.id, cwd: '/home/me' });
      const diff = '+++ b/file.ts\n+new line\n';
      exec.mockResolvedValue({ stdout: diff, stderr: '', exitCode: 0, timedOut: false, aborted: false, durationMs: 0 });
      expect(await t.engine.diff(s.id)).toEqual({ diff, files: ['file.ts'] });
      const error = Object.assign(new Error('not an offline conflict'), { status: 409 });
      exec.mockRejectedValue(error);
      await expect(t.engine.diff(s.id)).rejects.toBe(error);
      await expect(t.engine.diff('ses_missing')).rejects.toMatchObject({ status: 404 });
    } finally {
      exec.mockRestore();
      await t.close();
    }
  }, 30_000);
});
