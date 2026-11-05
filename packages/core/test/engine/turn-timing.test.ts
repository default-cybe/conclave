/**
 * The turn line carries each model call's time to first token and whole
 * stream time (hub stall review 2026-11-04: neither was logged).
 */
import { expect, test } from 'bun:test';
import { startTestEngine } from './harness';
import { setLogTap } from '../../src/util/log';

test('the turn line has ttftMs and streamMs for each model call', async () => {
  const t = await startTestEngine({ script: [{ blocks: [{ tool: 'Read', input: { file_path: '/nonexistent-x' } }], delayMs: 30 }, [{ text: 'done' }]] });
  const turns: Record<string, unknown>[] = [];
  const prev = setLogTap((_level, scope, msg, extra) => {
    if (scope === 'session' && msg === 'turn') turns.push(extra as Record<string, unknown>);
  });
  try {
    const s = await t.engine.createSession({ agent: 'assistant', cwd: t.cwd });
    await t.run(s.id, 'go');
    expect(turns).toHaveLength(1);
    const { ttftMs, streamMs } = turns[0] as { ttftMs: number[]; streamMs: number[] };
    // two agent calls, plus the session's title chore: one entry per call the line counts
    expect(ttftMs.length).toBeGreaterThanOrEqual(2);
    expect(ttftMs).toHaveLength(turns[0].calls as number);
    expect(streamMs).toHaveLength(ttftMs.length);
    // the scripted tool reply waited 30 ms before its first event (call order varies with the title chore)
    expect(Math.max(...ttftMs)).toBeGreaterThanOrEqual(25);
    ttftMs.forEach((v, i) => expect(streamMs[i]).toBeGreaterThanOrEqual(v));
  } finally {
    setLogTap(prev);
    await t.close();
  }
});
