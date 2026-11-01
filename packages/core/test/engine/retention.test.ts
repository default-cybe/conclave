import { describe, expect, test } from 'bun:test';
import { OUTPUTS_PRUNE_JOB, OUTPUT_RETENTION_MS } from '../../src/engine/engine';
import { startTestEngine } from './harness';

/** HARNESS-REVIEW item 16: stored tool outputs have a retention policy. */
describe('tool output retention', () => {
  test('old outputs go except in pinned sessions; outputs of deleted sessions go at once; the job plans its next run', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const e = t.engine;
      const plain = await e.createSession({ title: 'plain', cwd: t.cwd });
      const pinned = await e.createSession({ title: 'pinned', cwd: t.cwd });
      e.updateSession(pinned.id, { pinned: true });
      const gone = await e.createSession({ title: 'gone', cwd: t.cwd });
      const oldPlain = e.repos.outputs.save(plain.id, 'Bash', 'old plain');
      const oldPinned = e.repos.outputs.save(pinned.id, 'Bash', 'old pinned');
      const newPlain = e.repos.outputs.save(plain.id, 'Bash', 'new plain');
      const ofGone = e.repos.outputs.save(gone.id, 'Bash', 'of a deleted session');
      const longAgo = Date.now() - OUTPUT_RETENTION_MS - 60_000;
      e.repos.db.query('UPDATE tool_outputs SET created_at = ? WHERE id IN (?, ?)').run(longAgo, oldPlain, oldPinned);
      await e.deleteSession(gone.id);

      expect(e.repos.jobs.pending(OUTPUTS_PRUNE_JOB)).toHaveLength(1);
      expect(e.pruneOutputs()).toBe(2);
      expect(e.repos.outputs.get(oldPlain)).toBeUndefined();
      expect(e.repos.outputs.get(ofGone)).toBeUndefined();
      expect(e.repos.outputs.get(oldPinned)?.content).toBe('old pinned');
      expect(e.repos.outputs.get(newPlain)?.content).toBe('new plain');
      const next = e.repos.jobs.pending(OUTPUTS_PRUNE_JOB);
      expect(next).toHaveLength(1);
      expect(next[0].runAt).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    } finally {
      await t.close();
    }
  });
});
