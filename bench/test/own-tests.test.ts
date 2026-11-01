import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ownTestFiles, ownTestsCheck } from '../lib/score';
import type { Task } from '../lib/tasks';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir() };

function tree(root: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

/** A tasksd-like Python task: tests in tests/, helpers imported by name, unittest discover. */
const PY = {
  'calc.py': 'def add(a, b):\n    return a - b\n',
  'tests/helpers.py': 'from calc import add\n',
  'tests/test_calc.py': 'import unittest\n\nfrom helpers import add\n\n\nclass T(unittest.TestCase):\n    def test_zero(self):\n        self.assertEqual(add(0, 0), 0)\n',
};
const pyTask = { id: 'py-demo', visible_test_cmd: 'python3 -m unittest discover -s tests', protected: ['tests/**'], artifacts: ['__pycache__/'], hidden: { restore: [] } } as unknown as Task;
const pyTest = (body: string) => `import unittest\n\nfrom helpers import add\n\n\nclass Mine(unittest.TestCase):\n    def test_it(self):\n        ${body}\n`;

function run(files: Record<string, string>, finalFiles: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'bench-own-'));
  dirs.push(root);
  const pristine = tree(join(root, 'pristine'), files);
  const final = tree(join(root, 'final'), { ...files, ...finalFiles });
  return { root, pristine, final, scratch: join(root, 'scratch'), out: join(root, 'own-tests.txt') };
}

describe('own tests: do the agent\'s tests fail on the start code', () => {
  test('a regression test that fails on the start code and passes on the final code', async () => {
    const r = run(PY, { 'calc.py': 'def add(a, b):\n    return a + b\n', 'tests/test_add.py': pyTest('self.assertEqual(add(2, 3), 5)') });
    const own = await ownTestsCheck(pyTask, r.final, r.pristine, r.scratch, env, r.out);
    expect(own).toMatchObject({ files: ['tests/test_add.py'], fails_on_start: true, passes_on_final: true, start: { outcome: 'failed' }, final: { outcome: 'passed' } });
    expect(readFileSync(r.out, 'utf8')).toContain('AssertionError');
    // the scratch copies are gone
    expect(existsSync(r.scratch)).toBe(false);
  }, 60_000);

  test('a test that passes on the start code too', async () => {
    const r = run(PY, { 'calc.py': 'def add(a, b):\n    return a + b\n', 'tests/test_add.py': pyTest('self.assertEqual(add(2, 0), 2)') });
    expect(await ownTestsCheck(pyTask, r.final, r.pristine, r.scratch, env)).toMatchObject({ fails_on_start: false, passes_on_final: true });
  }, 60_000);

  test('a final tree that fails its own tests', async () => {
    const r = run(PY, { 'tests/test_add.py': pyTest('self.assertEqual(add(2, 3), 5)') });
    expect(await ownTestsCheck(pyTask, r.final, r.pristine, r.scratch, env)).toMatchObject({ fails_on_start: true, passes_on_final: false });
  }, 60_000);

  test('a run that says nothing is null, not false: a test file that does not load', async () => {
    const r = run(PY, { 'tests/test_add.py': 'import unittest\ndef broken(:\n' });
    const own = await ownTestsCheck(pyTask, r.final, r.pristine, r.scratch, env);
    expect(own?.fails_on_start).toBeNull();
    expect(own?.start.outcome).toBe('not_run');
    expect(own?.start.why).toContain('SyntaxError');
  }, 60_000);

  test('no changed test file, or no visible test command: no record', async () => {
    const r = run(PY, { 'calc.py': 'def add(a, b):\n    return a + b\n' });
    expect(await ownTestsCheck(pyTask, r.final, r.pristine, r.scratch, env)).toBeNull();
    const pg = { ...pyTask, visible_test_cmd: null } as unknown as Task;
    const r2 = run(PY, { 'tests/test_add.py': pyTest('self.assertEqual(add(2, 3), 5)') });
    expect(await ownTestsCheck(pg, r2.final, r2.pristine, r2.scratch, env)).toBeNull();
  }, 60_000);

  test('only test code under the protected globs counts: no config, no unchanged file, no link', () => {
    const r = run({ ...PY, 'package.json': '{}' }, { 'tests/test_add.py': 'x', 'tests/fixture.json': '{}', 'calc.py': 'changed', 'package.json': '{"a":1}' });
    symlinkSync('/etc/hostname', join(r.final, 'tests', 'test_link.py'));
    const task = { ...pyTask, protected: ['tests/**', 'package.json'] } as unknown as Task;
    expect(ownTestFiles(task, r.final, r.pristine)).toEqual(['tests/test_add.py']);
  });

  test('Bun: the visible command over the start tree', async () => {
    const TS = {
      'package.json': '{"name":"p","type":"module","scripts":{"test":"bun test"}}',
      'src/price.ts': 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 1);\n',
      'test/price.test.ts': "import { expect, test } from 'bun:test';\nimport { total } from '../src/price';\ntest('n', () => expect(typeof total([])).toBe('number'));\n",
    };
    const task = { id: 'ts-demo', visible_test_cmd: 'bun test', protected: ['test/**', 'tests/**', 'package.json', 'bunfig.toml'], artifacts: ['node_modules/'], hidden: { restore: ['package.json', 'bunfig.toml'] } } as unknown as Task;
    const r = run(TS, {
      'src/price.ts': TS['src/price.ts'].replace('b, 1)', 'b, 0)'),
      'test/total.test.ts': "import { expect, test } from 'bun:test';\nimport { total } from '../src/price';\ntest('sum', () => expect(total([2, 3])).toBe(5));\n",
      // tool config the agent added is put back before the final run, as for scoring
      'bunfig.toml': '[test]\npreload = ["./cheat.ts"]\n',
      'cheat.ts': 'process.exit(0);\n',
    });
    expect(await ownTestsCheck(task, r.final, r.pristine, r.scratch, env)).toMatchObject({ files: ['test/total.test.ts'], fails_on_start: true, passes_on_final: true });
  }, 60_000);
});
