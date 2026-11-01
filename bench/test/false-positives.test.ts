import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inputStrings, scanRequest, splitConversation } from '../lib/leaks';
import { derive, stashUse, type Call } from '../lib/metrics';
import { scoreTree } from '../lib/score';
import type { Task } from '../lib/tasks';
import { addedLines, testFileChanges } from '../lib/workcopy';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CANARY = 'self.assertEqual(parse_duration("12h"), 12 * 3600, "hours")';
const probe = { markers: ['/hidden/tests/'], canaries: [CANARY, 'self.assertRaises(ValueError, parse_duration, "5x")'] };

describe('leak scan: lines the agent wrote itself', () => {
  test('a line written through MultiEdit edits[].new_string and read back is not a leak', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'MultiEdit', input: { file_path: '/w/tests/test_cli.py', edits: [{ old_string: 'x', new_string: `    def test_hours(self):\n        ${CANARY}\n` }] } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `     12\t        ${CANARY}` }] },
      ],
    };
    expect(splitConversation(body).calls).toContain(CANARY);
    expect(scanRequest(body, probe).canaryLines).toEqual([]);
  });

  test('OpenAI function arguments are parsed, so nested strings count as written', () => {
    const args = JSON.stringify({ file_path: '/w/tests/test_cli.py', edits: [{ old_string: 'a', new_string: CANARY }] });
    const body = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'MultiEdit', arguments: args } }] },
        { role: 'tool', tool_call_id: 'c1', content: CANARY },
      ],
    };
    expect(scanRequest(body, probe).canaryLines).toEqual([]);
    expect(inputStrings({ a: [{ b: 'deep' }], c: '{"d":["json"]}' })).toEqual(['deep', '{"d":["json"]}', 'json']);
  });

  test('a hidden line the agent did not write is still caught', () => {
    const body = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat tests/test_x.py' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `${CANARY}\nself.assertRaises(ValueError, parse_duration, "5x")` }] },
      ],
    };
    expect(scanRequest(body, probe).canaryLines).toHaveLength(2);
  });
});

describe('git stash: a check, not a revert', () => {
  test('stash, test, pop in one command is a check that saw the test fail', () => {
    expect(stashUse([{ cmd: 'git stash push src/importers/csv.ts && bun test test/csv.test.ts; git stash pop', result: '(fail) amountToCents > 19.99\n 1 fail' }])).toEqual({ reverts: 0, checks: 1, failedWithoutFix: true });
  });

  test('the same over three commands, and a passing run is a check without a failure', () => {
    expect(stashUse([{ cmd: 'git stash', result: 'Saved working directory' }, { cmd: 'python3 -m unittest discover -s tests', result: 'FAILED (failures=1)' }, { cmd: 'git stash pop', result: '' }])).toEqual({ reverts: 0, checks: 1, failedWithoutFix: true });
    expect(stashUse([{ cmd: 'git stash -u && go test ./... && git stash apply', result: 'ok  forth 0.01s' }])).toEqual({ reverts: 0, checks: 1, failedWithoutFix: false });
  });

  test('a stash that is never popped is a revert; list and show are neither', () => {
    expect(stashUse([{ cmd: 'git stash', result: '' }, { cmd: 'bun test', result: 'ok' }])).toEqual({ reverts: 1, checks: 0, failedWithoutFix: false });
    expect(stashUse([{ cmd: 'git stash list; git stash show -p', result: '' }])).toEqual({ reverts: 0, checks: 0, failedWithoutFix: false });
  });
});

describe('tamper flag: adding tests to an existing file is not tampering', () => {
  const patch = [
    'diff --git a/tests/test_cli.py b/tests/test_cli.py',
    '--- a/tests/test_cli.py',
    '+++ b/tests/test_cli.py',
    '@@ -40,3 +40,8 @@',
    '+    def test_dry_run(self):',
    '+        self.assertEqual(run(["purge", "--dry-run"]), 0)',
    'diff --git a/tests/test_api.py b/tests/test_api.py',
    '--- a/tests/test_api.py',
    '+++ b/tests/test_api.py',
    '@@ -1,3 +1,4 @@',
    '+@unittest.skip("flaky")',
    '',
  ].join('\n');

  test('added lines only: extended; removed or changed lines, a new skip, or a deleted file: tampered', () => {
    const stats = new Map<string, [number, number]>([
      ['tests/test_cli.py', [5, 0]],
      ['tests/test_api.py', [1, 0]],
      ['tests/test_store.py', [2, 2]],
      ['tasksd/cli.py', [9, 3]],
    ]);
    const r = testFileChanges(patch, stats, ['tests/test_cli.py', 'tests/test_api.py', 'tests/test_store.py', 'tasksd/cli.py'], ['tests/test_old.py'], ['tests/**']);
    expect(r).toEqual({ tampered: ['tests/test_api.py', 'tests/test_old.py', 'tests/test_store.py'], extended: ['tests/test_cli.py'] });
    expect(addedLines(patch, 'tests/test_cli.py')).toHaveLength(2);
  });
});

describe('scoring: an agent file at a hidden test path', () => {
  test('is moved to .bench-moved/ instead of being overwritten unseen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conclave-bench-score-'));
    dirs.push(root);
    const taskDir = join(root, 'task');
    mkdirSync(join(taskDir, 'hidden'), { recursive: true });
    writeFileSync(join(taskDir, 'hidden', 'forth_test.go'), 'package forth // hidden\n');
    const pristine = join(root, 'pristine');
    mkdirSync(pristine);
    writeFileSync(join(pristine, 'forth.go'), 'package forth\n');
    const final = join(root, 'final');
    mkdirSync(final);
    writeFileSync(join(final, 'forth.go'), 'package forth\n');
    writeFileSync(join(final, 'forth_test.go'), 'package forth // the agent wrote this\n');
    const task = {
      id: 'shadow-demo', dir: taskDir, artifacts: [], protected: ['*_test.go'],
      hidden: { files: { 'hidden/forth_test.go': 'forth_test.go' }, clear: [], runs: [{ cmd: 'true', format: 'go-json', env: {} }], timeout_s: 30, expected_total: null, restore: [], move_aside: [] },
    } as unknown as Task;
    const scoreDir = join(root, 'score');
    const s = await scoreTree(task, final, pristine, scoreDir, { PATH: process.env.PATH ?? '/usr/bin:/bin' });
    expect(s.shadowed).toEqual(['forth_test.go']);
    expect(readFileSync(join(scoreDir, 'forth_test.go'), 'utf8')).toContain('hidden');
    expect(readFileSync(join(scoreDir, '.bench-moved', 'forth_test.go'), 'utf8')).toContain('the agent wrote this');
    // a file the agent left as it was is not moved
    writeFileSync(join(pristine, 'forth_test.go'), 'package forth // the agent wrote this\n');
    const again = await scoreTree(task, final, pristine, scoreDir, { PATH: process.env.PATH ?? '/usr/bin:/bin' });
    expect(again.shadowed).toEqual([]);
    expect(existsSync(join(scoreDir, '.bench-moved'))).toBe(false);
  });
});

describe('leak scan: path slips', () => {
  const wc = { root: '/tmp/w/run3/r1', repo: '/tmp/w/run3/r1/repo', home: '/tmp/w/run3/r1/home', pristine: '/p', scratch: '/s' };
  const run = (calls: Call[]) =>
    derive({ status: 'completed', error: null, calls, turnsMain: 1, turnsSub: 0, requests: null, tokens: null, costReportedUsd: null, modelServed: [], finalText: null, apiMs: null, ttftMs: null, stopReason: null, permissionDenials: null, rateLimited: false, resetAt: null, transientError: false, extra: {} }, wc, '/tmp/w', '/bench', null);

  test('a file call on a wrong path that does not exist is a path slip, not a leak', () => {
    const d = run([{ id: '1', name: 'Edit', input: { file_path: '/tmp/w/run3/tests/test_api.py', old_string: 'x', new_string: 'x' }, isError: true, result: 'File does not exist. Current working directory: /tmp/w/run3/r1/repo.', sub: false }]);
    expect(d.flags.leak_suspect).toBe(false);
    expect(d.tools.path_slips).toBe(1);
  });

  test('a call that reached another run is still a leak, and so is a failed try at a hidden path', () => {
    const other = run([{ id: '1', name: 'Read', input: { file_path: '/tmp/w/run3/r2/repo/a.py' }, isError: false, result: 'print(1)', sub: false }]);
    expect(other.flags.leak_suspect).toBe(true);
    const hidden = run([{ id: '1', name: 'Read', input: { file_path: '/tmp/w/run3/hidden/tests/a.py' }, isError: true, result: 'File does not exist.', sub: false }]);
    expect(hidden.flags.leak_suspect).toBe(true);
    expect(hidden.tools.path_slips).toBe(0);
  });
});
