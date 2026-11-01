import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectKind, reduceOutput, retrieve, type OutputKind } from '../../src/tools/compress';
import { ReadToolOutputTool } from '../../src/tools/read-tool-output';
import { BashTool } from '../../src/tools/bash';
import { fakeHost, makeCtx, tempDir } from './helpers';

/**
 * HARNESS-REVIEW item 16: content-aware reducers. Fixtures are real outputs
 * of bun test, cargo test, go test -v, tsc and an npm build, plus pytest -v,
 * a JSON API list, a git diff and grep -rn output in their usual formats.
 */

const DIR = join(import.meta.dir, 'fixtures', 'compress');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const golden = (f: string) => join(DIR, f.replace(/\.\w+$/, '.reduced.txt'));

const CASES: Array<[file: string, kind: OutputKind]> = [
  ['bun-test.txt', 'tests'],
  ['cargo-test.txt', 'tests'],
  ['go-test.txt', 'tests'],
  ['pytest.txt', 'tests'],
  ['npm-build.txt', 'log'],
  ['tsc.txt', 'text'],
  ['check-runs.json', 'json'],
  ['git-diff.txt', 'diff'],
  ['grep.txt', 'search'],
];

/** Lines no reducer may drop: failures, errors, warnings and the counts. */
const MUST_KEEP = /\b(FAIL|FAILED|ERROR|WARN|panicked|panic:|Error|error TS\d+|AssertionError|KeyError)\b|\d+ (passed|failed|pass|fail)\b|^test result:/;

describe('reducers on real outputs', () => {
  for (const [file, kind] of CASES) {
    test(`${file}: kind ${kind}, golden text, idempotent, every failure line kept`, () => {
      const text = read(file);
      expect(detectKind(text)).toBe(kind);
      const r = reduceOutput(text, 20_000);
      const again = reduceOutput(r.text, 20_000);
      expect(again.text).toBe(r.text);
      if (existsSync(golden(file))) {
        expect(r.reduced).toBe(true);
        expect(r.text).toBe(read(golden(file).split('/').pop()!));
        expect(r.text.length).toBeLessThan(text.length);
      } else {
        expect(r.text).toBe(text);
      }
      if (kind !== 'diff' && kind !== 'search') {
        for (const line of text.split('\n')) if (MUST_KEEP.test(line)) expect(r.text).toContain(line);
      }
    });
  }

  test('sizes (chars before and after)', () => {
    const rows = CASES.map(([f]) => {
      const t = read(f);
      return `${f} ${t.length} -> ${reduceOutput(t, 20_000).text.length}`;
    });
    console.log(rows.join('\n'));
    expect(reduceOutput(read('pytest.txt')).text.length).toBeLessThan(read('pytest.txt').length / 10);
    expect(reduceOutput(read('npm-build.txt')).text.length).toBeLessThan(read('npm-build.txt').length / 10);
  });

  test('a diff past the budget names the files it leaves out', () => {
    const r = reduceOutput(read('git-diff.txt'), 8_000);
    expect(r.text).toMatch(/\[\.\.\. \d+ more changed files? not shown: [^\]]*transcript\.ts/);
  });

  test('short outputs and plain text come back as they are', () => {
    expect(reduceOutput('ERROR x\n'.repeat(10)).reduced).toBe(false);
    const prose = 'word '.repeat(2_000);
    expect(reduceOutput(prose).text).toBe(prose);
    // a list of numbers is not a log, and neither is code that throws errors
    expect(detectKind(Array.from({ length: 500 }, (_, i) => String(i)).join('\n'))).toBe('text');
    const code = Array.from({ length: 200 }, (_, i) => (i % 10 ? `  const x${i} = f(${i});` : `  throw new Error('bad ${i}');`)).join('\n');
    expect(detectKind(code)).toBe('text');
  });
});

describe('query retrieval', () => {
  test('BM25 blocks in source order; the failure is found by its words', () => {
    const lines = read('npm-build.txt').split('\n');
    const hits = retrieve(lines, 'Cannot find module charts Line');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((b) => b.lines.join('\n')).join('\n')).toContain("Error: Cannot find module './charts/Line'");
    for (let i = 1; i < hits.length; i++) expect(hits[i].start).toBeGreaterThan(hits[i - 1].start);
    expect(retrieve(lines, 'zzzunmatched')).toEqual([]);
  });

  test('ReadToolOutput query returns matching blocks with markers between them, and the start when nothing matches', async () => {
    const host = fakeHost();
    host.outputs.set('out_1', read('pytest.txt'));
    const ctx = makeCtx({ host, cwd: '/' });
    const res = await ReadToolOutputTool.run({ id: 'out_1', query: 'KeyError store roundtrip' }, ctx);
    const text = String(res.content);
    expect(text).toContain('match "KeyError store roundtrip", in file order');
    expect(text).toContain('E       KeyError: 1');
    expect(text).toContain('[... non-adjacent ...]');
    const none = String((await ReadToolOutputTool.run({ id: 'out_1', query: 'zzzunmatched' }, ctx)).content);
    expect(none).toContain('No block of output out_1 matches "zzzunmatched". Its first lines:');
    expect(none).toContain('test session starts');
  });
});

describe('Bash output', () => {
  test('a long test report keeps its failure and counts, and the note names the id and the query mode', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const host = fakeHost();
      const ctx = makeCtx({ host, cwd: dir });
      const cmd = 'for i in $(seq 1 3000); do echo "tests/t.py::test_case_$i PASSED [ 50%]"; done; echo "FAILED tests/t.py::test_total - assert 81 == 90"; echo "========== 1 failed, 3000 passed in 2.10s =========="';
      const res = await BashTool.run({ command: cmd }, ctx);
      const text = String(res.content);
      expect(text).toContain('FAILED tests/t.py::test_total - assert 81 == 90');
      expect(text).toContain('1 failed, 3000 passed in 2.10s');
      expect(text).toContain('[... 3000 lines left out: passing tests ...]');
      expect(text).toMatch(/reduced as a test report \(kept: the counts and every failure\)\. Full output: ReadToolOutput with id "[^"]+"; pass query or grep to search it\./);
      expect(text.length).toBeLessThan(1_000);
      expect([...host.outputs.values()][0].split('\n')).toHaveLength(3002);
    } finally {
      cleanup();
    }
  });
});
