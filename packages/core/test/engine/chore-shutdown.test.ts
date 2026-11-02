/**
 * A chore call (title, memory extraction) that is still retrying when the hub
 * stops ends with it, instead of sleeping through its retries and logging into
 * whatever runs next (found as a CI flake: a retry warning from an earlier
 * test's memory extraction landed in another test's captured logs).
 */
import { expect, test } from 'bun:test';
import { startTestEngine, until } from './harness';
import { completeText } from '../../src/session/stream';
import { warmUp } from '../../src/meeting/answer';
import { setLogTap } from '../../src/util/log';

test('shutdown ends a chore that is waiting to retry', async () => {
  // every chore answers 503, so the call sleeps between retries (1 s, 2 s, 4 s, 8 s)
  const t = await startTestEngine({ script: [[{ text: 'ok' }]], chore: () => 503 });
  const call = completeText(t.engine, { prompt: 'title this', purpose: 'memory' }).catch((e) => e);
  expect(await until(() => t.chores.length >= 1)).toBe(true);
  const started = Date.now();
  await t.close();
  const err = await call;
  // the retry sleep rejects as a plain abort (util/text.ts sleep), as it does for Stop
  expect((err as Error).message).toBe('aborted');
  expect(Date.now() - started).toBeLessThan(1000);
  expect(t.chores).toHaveLength(1);
});

test('a meeting warm-up after shutdown ends quietly', async () => {
  const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  await t.close();
  const lines: string[] = [];
  const previous = setLogTap((_level, _scope, message) => lines.push(message));
  try {
    await warmUp(t.engine, 'mock/claude-sonnet-5-5', { id: 'mtg_x', sessionId: 'ses_x', accountId: 'owner' } as never, 'pack');
  } finally {
    setLogTap(previous);
  }
  expect(lines.filter((l) => l.includes('warm-up failed'))).toEqual([]);
});
