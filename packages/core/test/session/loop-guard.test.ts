import { describe, expect, test } from 'bun:test';
import { callSignature, FREQUENCY_WARN, LoopGuard, resultHash, type Verdict } from '../../src/session/loop-guard';
import type { ToolResultBlock } from '../../src/types';
import type { WorkflowStatusAgent, WorkflowStatusView } from '../../src/client/workflows';
import { BashTool } from '../../src/tools/bash';
import { BashOutputTool } from '../../src/tools/bash-output';
import { shellRegistry } from '../../src/tools/shells';
import { statusText } from '../../src/tools/workflow-status';
import { makeCtx, tempDir } from '../tools/helpers';

type Ev = [tool: string, input: Record<string, unknown>, out: string, opts?: { error?: boolean; denied?: boolean }];

const result = (out: string, opts: { error?: boolean; denied?: boolean } = {}): ToolResultBlock => ({
  type: 'tool_result',
  toolUseId: 't',
  content: out,
  isError: opts.error || opts.denied,
  meta: opts.denied ? { denied: 'user' } : undefined,
});

function run(events: Ev[], guard = new LoopGuard({ unattended: true })): Verdict[] {
  return events.map(([tool, input, out, opts]) => guard.after(tool, input, result(out, opts)));
}

const levels = (vs: Verdict[]) => vs.map((v) => v.level);
const read = (path: string, out = `contents of ${path}`): Ev => ['Read', { file_path: path }, out];

describe('LoopGuard', () => {
  test('the same read with the same result warns at 3 and halts at 5', () => {
    const vs = run(Array.from({ length: 5 }, () => read('a.ts')));
    expect(levels(vs)).toEqual(['ok', 'ok', 'warn', 'warn', 'halt']);
    expect(vs[2].code).toBe('repeat');
    expect(vs[4].code).toBe('repeat');
    expect(vs[4].message).toContain('5 times in a row');
  });

  test('reads of different files never fire', () => {
    const vs = run([read('a.ts'), read('b.ts'), read('c.ts'), read('a.ts'), read('b.ts'), read('c.ts')]);
    // a.ts, b.ts, c.ts twice is a cycle of 3 with only 2 laps: still fine
    expect(levels(vs).every((l) => l === 'ok')).toBe(true);
  });

  test('the same call with a changing result is not a repeat (a poll that makes progress)', () => {
    const vs = run(Array.from({ length: 8 }, (_, i): Ev => ['Bash', { command: 'gh run view 1' }, `in progress ${i}`]));
    expect(levels(vs).every((l) => l === 'ok')).toBe(true);
  });

  test('input key order does not change the signature', () => {
    expect(callSignature('Grep', { pattern: 'x', path: 'src' })).toBe(callSignature('Grep', { path: 'src', pattern: 'x' }));
    expect(callSignature('Grep', { pattern: 'x' })).not.toBe(callSignature('Grep', { pattern: 'y' }));
  });

  test('stored output ids do not make equal outputs look different', () => {
    const a = resultHash({ content: 'big output [Full output id: out_0mvc71ydvr5xxh43dhq]' });
    const b = resultHash({ content: 'big output [Full output id: out_0mvc8zzzzzzzzzzzzzz]' });
    expect(a).toBe(b);
    expect(resultHash({ content: 'x', isError: true })).not.toBe(resultHash({ content: 'x' }));
  });

  test('the same failure three times halts, even with reads in between', () => {
    const fail: Ev = ['Bash', { command: 'npm test' }, '1 failing: expected 2', { error: true }];
    const vs = run([fail, read('a.ts'), fail, read('b.ts'), fail]);
    expect(levels(vs)).toEqual(['ok', 'ok', 'ok', 'ok', 'halt']);
    expect(vs[4].code).toBe('same_error');
  });

  test('failing test, Edit, same failing test never fires: an edit is progress', () => {
    const fail: Ev = ['Bash', { command: 'npm test' }, '1 failing: expected 2', { error: true }];
    const edit = (n: number): Ev => ['Edit', { file_path: 'a.ts', old_string: `v${n}`, new_string: `v${n + 1}` }, 'ok'];
    const vs = run([fail, edit(1), fail, edit(2), fail, edit(3), fail]);
    expect(levels(vs).every((l) => l === 'ok')).toBe(true);
  });

  test('a cycle A-B-A-B-A-B with the same results warns, and halts at 5 laps', () => {
    const a = read('a.ts');
    const b: Ev = ['Grep', { pattern: 'foo' }, 'a.ts:1: foo'];
    const vs = run([a, b, a, b, a, b, a, b, a, b]);
    expect(vs.slice(0, 5).every((v) => v.level === 'ok')).toBe(true);
    expect(vs[5]).toMatchObject({ level: 'warn', code: 'cycle' });
    expect(vs[9]).toMatchObject({ level: 'halt', code: 'cycle' });
  });

  test('three denials in a row halt; a call that runs in between resets the count', () => {
    const denied = (cmd: string): Ev => ['Bash', { command: cmd }, 'The user denied this action.', { denied: true }];
    expect(levels(run([denied('rm a'), denied('rm -f a'), denied('unlink a')]))).toEqual(['ok', 'ok', 'halt']);
    expect(run([denied('rm a'), denied('rm -f a'), denied('unlink a')])[2].code).toBe('denied');
    expect(levels(run([denied('rm a'), denied('rm -f a'), read('a.ts'), denied('unlink a')]))).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  test('right after a compaction, three identical calls halt', () => {
    const plain = new LoopGuard({ unattended: true });
    expect(levels(run([read('x.ts'), read('x.ts'), read('x.ts')], plain))).toEqual(['ok', 'ok', 'warn']);

    const g = new LoopGuard({ unattended: true });
    run([read('a.ts')], g);
    g.armAfterCompaction();
    const vs = run([read('x.ts'), read('x.ts'), read('x.ts')], g);
    expect(vs[2]).toMatchObject({ level: 'halt', code: 'after_compaction' });
    // the window closes after three calls
    expect(run([read('y.ts'), read('z.ts'), read('w.ts')], g).every((v) => v.level === 'ok')).toBe(true);
  });

  test('BashOutput is a poller: no repeat rules, only the poll budget at 10, despite its <timestamp>', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const ctx = makeCtx({ cwd: dir, sessionId: 'sess_poll' });
      const id = String((await BashTool.run({ command: 'sleep 30', run_in_background: true }, ctx)).meta?.shellId);
      const g = new LoopGuard({ unattended: true });
      const vs: Verdict[] = [];
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(2);
        vs.push(g.after('BashOutput', { bash_id: id }, await BashOutputTool.run({ bash_id: id }, ctx)));
      }
      expect(vs.slice(0, 9).every((v) => v.level === 'ok')).toBe(true);
      expect(vs[9]).toMatchObject({ level: 'warn', code: 'poll' });
    } finally {
      await shellRegistry.disposeAll();
      cleanup();
    }
  });

  test('WorkflowStatus polls count although the elapsed times grow', () => {
    const agent = (elapsedMs: number): WorkflowStatusAgent => ({ seq: 1, label: 'review', state: 'running', elapsedMs, lastTool: 'Read' });
    const view = (elapsedMs: number): WorkflowStatusView => ({
      runId: 'wfr_1',
      name: 'review',
      status: 'running',
      live: true,
      background: true,
      phaseIndex: 0,
      phases: [{ title: 'Review', state: 'current', agents: [agent(elapsedMs - 1_000)] }],
      counts: { agents: 1, queued: 0, running: 1, done: 0, cached: 0, failed: 0, skipped: 0, parked: 0 },
      tokens: { input: 100, output: 10 },
      costUsd: 0.01,
      errors: [],
      errorCount: 0,
      logs: [{ n: 1, ts: 2_000, text: 'phase Review' }],
      createdAt: 0,
      startedAt: 0,
      elapsedMs,
    });
    const g = new LoopGuard({ unattended: true });
    const vs = Array.from({ length: 15 }, (_, i) => g.after('WorkflowStatus', {}, { content: statusText(view(5_000 + i * 61_500)), isError: false }));
    expect(statusText(view(5_000))).not.toBe(statusText(view(66_500)));
    expect(levels(vs)).toEqual([...Array(9).fill('ok'), ...Array(5).fill('warn'), 'halt']);
    expect(vs[14].code).toBe('poll');
  });

  test('one tool used very often warns once', () => {
    const vs = run(Array.from({ length: FREQUENCY_WARN + 5 }, (_, i) => read(`f${i}.ts`)));
    const warns = vs.filter((v) => v.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].code).toBe('frequency');
  });

  test('before() refuses a call that was stopped this turn', () => {
    const g = new LoopGuard({ unattended: false });
    expect(g.before('Read', { file_path: 'a.ts' }).level).toBe('ok');
    g.stop('Read', { file_path: 'a.ts' });
    const v = g.before('Read', { file_path: 'a.ts' });
    expect(v.level).toBe('halt');
    expect(v.message).toContain('Not run');
    expect(g.before('Read', { file_path: 'b.ts' }).level).toBe('ok');
  });

  test('ToolSearch misses with different queries warn at 3 and halt from 4; a hit does not count', () => {
    const g = new LoopGuard({ unattended: true });
    const miss = (q: string) => g.after('ToolSearch', { query: q }, { content: `none for ${q}`, meta: { toolSearchMiss: true } });
    const hit = g.after('ToolSearch', { query: 'x' }, result('loaded'));
    const vs = [hit, miss('delegate'), miss('task'), miss('all tools'), miss('subagent')];
    expect(levels(vs)).toEqual(['ok', 'ok', 'ok', 'warn', 'halt']);
    expect(vs[3].code).toBe('search_miss');
    expect(vs[4].code).toBe('search_miss');
  });
});
