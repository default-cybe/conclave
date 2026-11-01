/**
 * What one test run says about the code it ran on. Shared by the workflow
 * `lib.failingTest` helper (workflows/prelude.ts calls it through the host),
 * the regression gate (session/regression-gate.ts) and the benchmark's
 * own-test metric (bench/lib/score.ts), so all three read a run the same way.
 *
 * Pure and free of imports: the bench loads it from outside the engine.
 */

/**
 * Output that shows the tests did not run, so a failure says nothing about
 * the code: a command that is missing, a test file that does not load, a run
 * with no tests, or a test runner that did not take its arguments.
 */
export const NOT_RUN =
  /command not found|No such file or directory|file or directory not found|Cannot find module|Module not found|SyntaxError|ReferenceError: \S+ is not defined|No tests? (?:found|ran|were found)|no test files|collected 0 items|\b0 tests?\b|did not match any (?:test|file)|error: unknown (?:option|command)/i;

/** A finished test command, as the workflow runtime and the gates report it. */
export interface TestCheck {
  ok?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  /** The last lines of its output. */
  tail?: string;
}

export interface TestProof {
  proven: boolean;
  why: string;
}

/**
 * A failing test proves a finding only when the test ran: a command that is
 * missing, a test file that does not load, a run with no tests, a timeout or
 * a test file that is not on the branch says nothing about the code. With
 * `testFile` and `diff`, the test file must be one the diff changes.
 */
export function failingTest(check: unknown, o: { testFile?: unknown; diff?: unknown } = {}): TestProof {
  if (!check || typeof check !== 'object') return { proven: false, why: 'the check did not run' };
  const c = check as TestCheck;
  if (c.ok) return { proven: false, why: 'the test passed on the current code' };
  if (c.timedOut) return { proven: false, why: 'the test timed out' };
  if (typeof c.exitCode !== 'number') return { proven: false, why: 'the test was killed before it finished' };
  if (c.exitCode === 126 || c.exitCode === 127) return { proven: false, why: `the test command did not start (exit ${c.exitCode})` };
  const m = NOT_RUN.exec(String(c.tail ?? ''));
  if (m) return { proven: false, why: `the test did not run cleanly (${m[0]})` };
  if (o.testFile && typeof o.diff === 'string') {
    const want = String(o.testFile).replace(/^\.\//, '');
    const changed = (o.diff.match(/^\+\+\+ b\/(.+)$/gm) ?? []).map((l) => l.slice(6));
    if (!changed.some((p) => p === want || want.endsWith(`/${p}`) || p.endsWith(`/${want}`))) return { proven: false, why: 'the test file is not on the branch' };
  }
  return { proven: true, why: 'the test fails on the current code' };
}

export type TestOutcome = 'failed' | 'passed' | 'not_run';

/**
 * The three things a run can say: the tests failed (they ran, and failed),
 * passed (they ran, and passed), or not_run (it says nothing either way).
 * A run that exits 0 but shows that no test ran is not a pass.
 */
export function testOutcome(check: TestCheck): { outcome: TestOutcome; why: string } {
  const proof = failingTest(check);
  if (proof.proven) return { outcome: 'failed', why: 'the tests failed' };
  if (!check.ok) return { outcome: 'not_run', why: proof.why };
  const m = NOT_RUN.exec(String(check.tail ?? ''));
  if (m) return { outcome: 'not_run', why: `the tests did not run cleanly (${m[0]})` };
  return { outcome: 'passed', why: 'the tests passed' };
}
