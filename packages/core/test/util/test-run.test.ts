import { describe, expect, test } from 'bun:test';
import { failingTest, NOT_RUN, testOutcome } from '../../src/util/test-run';

describe('failingTest (lib.failingTest in workflows)', () => {
  test('a clean failure proves; passes, timeouts, kills and missing commands do not', () => {
    expect(failingTest({ ok: false, exitCode: 1, tail: 'FAILED (failures=1)\nRan 3 tests' })).toEqual({ proven: true, why: 'the test fails on the current code' });
    expect(failingTest(null).why).toBe('the check did not run');
    expect(failingTest({ ok: true, exitCode: 0 }).why).toBe('the test passed on the current code');
    expect(failingTest({ ok: false, timedOut: true, exitCode: null }).why).toBe('the test timed out');
    expect(failingTest({ ok: false, exitCode: null }).why).toBe('the test was killed before it finished');
    expect(failingTest({ ok: false, exitCode: 127 }).why).toBe('the test command did not start (exit 127)');
  });

  test('output that shows the tests did not run is not a proof', () => {
    for (const tail of ['bash: pytest: command not found', 'error: Cannot find module "./x"', 'SyntaxError: Unexpected token', 'Ran 0 tests in 0.000s\n\nNO TESTS RAN', 'collected 0 items', 'error: unknown option --foo']) {
      expect({ tail, proven: failingTest({ ok: false, exitCode: 1, tail }).proven }).toEqual({ tail, proven: false });
    }
    expect(NOT_RUN.test('Ran 10 tests')).toBe(false);
  });

  test('with a diff, the test file must be on the branch', () => {
    const diff = '--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@\n+x\n';
    const failed = { ok: false, exitCode: 1, tail: 'FAILED' };
    expect(failingTest(failed, { testFile: './tests/test_x.py', diff }).proven).toBe(true);
    expect(failingTest(failed, { testFile: 'tests/test_y.py', diff }).why).toBe('the test file is not on the branch');
  });
});

describe('testOutcome', () => {
  test('failed, passed and not_run', () => {
    expect(testOutcome({ ok: false, exitCode: 1, tail: 'AssertionError: 1 != 2\nFAILED (failures=1)' }).outcome).toBe('failed');
    expect(testOutcome({ ok: true, exitCode: 0, tail: 'Ran 4 tests\n\nOK' }).outcome).toBe('passed');
    expect(testOutcome({ ok: false, timedOut: true, exitCode: null }).outcome).toBe('not_run');
    expect(testOutcome({ ok: false, exitCode: 1, tail: 'error: Cannot find module' }).outcome).toBe('not_run');
  });

  test('an exit 0 that ran no test is not a pass', () => {
    const r = testOutcome({ ok: true, exitCode: 0, tail: 'Ran 0 tests in 0.000s\n\nOK' });
    expect(r.outcome).toBe('not_run');
    expect(r.why).toContain('0 tests');
  });
});
