import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as runner from '../lib/runset';
import { compare, main, remainingUsd } from '../improve';

const row = (task_id: string, repeat: number, pass: boolean, passed = pass ? 7 : 4) => ({
  task_id, repeat, valid: true, tests: { pass, passed }, cost: { list_usd: 1 },
  own_tests: { fails_on_start: true, passes_on_final: true },
  regression_gate: { proven: 1, passes: 0, not_run: 0, skipped: 0, reminded: 0 },
});

describe('offline improvement decision', () => {
  test('baseline at the cap exits 3 without starting candidate preflight', async () => {
    const root = mkdtempSync(join(import.meta.dir, '.improve-'));
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    for (const src of [baseline, candidate]) {
      mkdirSync(join(src, 'packages/cli/src'), { recursive: true });
      writeFileSync(join(src, 'packages/cli/src/index.ts'), '');
    }
    const run = spyOn(runner, 'runSet').mockImplementation(async (o) => {
      const dir = join(o.out, o.set!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ skipped: [], plan: [{}] }));
      writeFileSync(join(dir, 'results.jsonl'), JSON.stringify({ ...row('one', 1, true), run_id: 'baseline' }) + '\n');
      return 0;
    });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['--baseline-src', baseline, '--candidate-src', candidate,
        '--set', 'cap', '--out', root, '--model', 'fixture-model', '--budget-usd', '1']);
      expect(code).toBe(3);
      expect(run).toHaveBeenCalledTimes(1);
      expect(existsSync(join(root, 'cap-candidate'))).toBe(false);
      expect(stderr.mock.calls.some(([text]) => String(text).includes('cost cap reached; candidate not run'))).toBe(true);
    } finally {
      run.mockRestore();
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('candidate wins only with complete paired improvement', () => {
    expect(compare([row('one', 1, false)], [row('one', 1, true)], 1).decision).toBe('candidate for human review');
  });
  test('tie keeps baseline; no automated promotion', () => {
    expect(compare([row('one', 1, true)], [row('one', 1, true)], 1).decision).toBe('keep baseline');
    expect(compare([row('one', 1, true)], [], 1).decision).toBe('incomplete');
  });
  test('any hidden-test regression blocks candidate, including a repeat', () => {
    const baseline = [row('one', 1, true), row('one', 2, false, 5)];
    const candidate = [row('one', 1, false), row('one', 2, false, 4)];
    const result = compare(baseline, candidate, 2);
    expect(result.decision).toBe('regression: stop');
    expect(result.regressions).toEqual(['one#1', 'one#2']);
  });
  test('cost cap subtracts actual list-price spend and fails closed on missing cost', () => {
    expect(remainingUsd(10, [row('one', 1, true), row('one', 2, true)])).toBe(8);
    expect(remainingUsd(1, [row('one', 1, true)])).toBe(0);
    expect(remainingUsd(0.5, [row('one', 1, true)])).toBe(0);
    expect(() => remainingUsd(10, [{ ...row('one', 1, true), cost: { list_usd: null } }])).toThrow('unknown');
  });
});
