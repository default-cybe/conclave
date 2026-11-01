/** `bench validate` (PROTOCOL 5.4): every task must be sound before any arm runs it. */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { baseEnv, STATE_DIR } from './env';
import { scoreTree, type TestScore } from './score';
import { applyOverlay, refreshFixtureTasks, setExpectedTotal, type Task } from './tasks';
import { copyTree, exec, listFiles, log, readJson, which, writeJson } from './util';

export interface ValidateResult {
  id: string;
  ok: boolean;
  problems: string[];
  skipped_reason?: string;
  visible: 'pass' | 'fail' | 'n/a';
  /** Visible tests on the reference tree: a correct fix must not have to edit them. */
  visible_reference: 'pass' | 'fail' | 'n/a';
  /** Visible tests on the naive tree. "fail" means the visible suite already catches the trap (information only). */
  visible_naive: 'pass' | 'fail' | 'n/a';
  pristine: { passed: number; failed: number; build_error: boolean } | null;
  reference: { passed: number; failed: number; ms: number } | null;
  naive: { passed: number; failed: number } | 'n/a' | null;
  /** Other correct fixes (hidden/alt/<name>/). Each must pass every hidden test. */
  alternatives: Record<string, { passed: number; failed: number; pass: boolean }>;
  /** How many times each tree was scored (--repeat). */
  repeats: number;
  expected_total: number | null;
}

const FORBIDDEN = [/^CLAUDE\.md$/i, /^AGENTS\.md$/i, /^CONCLAVE\.md$/i, /^\.claude\//, /^\.meta\//, /(^|\/)\.meta\//];

/** The parts of a score that must not change between repeats. */
function fingerprint(s: TestScore): string {
  return JSON.stringify([s.passed, s.failed, s.errored, s.build_error, s.exit_codes, s.timed_out, [...s.failing].sort()]);
}

export function alternativeNames(t: Task): string[] {
  const d = join(t.dir, 'hidden', 'alt');
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export async function validateTasks(tasks: Task[], opts: { workRoot: string; update: boolean; repeat?: number }): Promise<ValidateResult[]> {
  refreshFixtureTasks(tasks);
  const env = await baseEnv();
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const results: ValidateResult[] = [];
  const root = join(opts.workRoot, '_validate');
  for (const t of tasks) {
    const r: ValidateResult = {
      id: t.id,
      ok: true,
      problems: [],
      visible: 'n/a',
      visible_reference: 'n/a',
      visible_naive: 'n/a',
      pristine: null,
      reference: null,
      naive: null,
      alternatives: {},
      repeats: repeat,
      expected_total: t.hidden.expected_total,
    };
    results.push(r);
    const missing = [];
    for (const tool of t.requires) if (!(await which(tool))) missing.push(tool);
    if (missing.length) {
      r.ok = false;
      r.skipped_reason = `missing toolchain: ${missing.join(', ')}`;
      r.problems.push(r.skipped_reason);
      continue;
    }
    const repo = join(t.dir, 'repo');
    const files = listFiles(repo);
    for (const f of files) if (FORBIDDEN.some((re) => re.test(f))) r.problems.push(`repo holds ${f}`);
    for (const target of Object.values(t.hidden.files)) if (files.includes(target)) r.problems.push(`repo holds hidden target ${target}`);

    const dir = join(root, t.id);
    rmSync(dir, { recursive: true, force: true });
    const pristine = join(dir, 'pristine');
    copyTree(repo, pristine);

    /** Run the visible suite in a fresh copy of `tree`. */
    const visible = async (tree: string, name: string): Promise<{ ok: boolean; tail: string }> => {
      const work = join(dir, `visible-${name}`);
      copyTree(tree, work);
      const v = await exec(['bash', '-c', t.visible_test_cmd!], { cwd: work, env, timeoutMs: 300_000 });
      return { ok: v.code === 0, tail: (v.stdout + v.stderr).split('\n').slice(-25).join('\n') };
    };
    /** Copy repo/ and lay an overlay over it. */
    const overlaid = (overlay: string, name: string): string => {
      const tree = join(dir, name);
      copyTree(repo, tree);
      applyOverlay(join(t.dir, overlay), tree);
      return tree;
    };
    /** Score a tree `repeat` times; report a problem if the result moves. */
    const scoreN = async (name: string, tree: string, expected?: number | null): Promise<TestScore> => {
      const first = await scoreTree(t, tree, pristine, join(dir, `score-${name}`), env, join(dir, `${name}-output.txt`), expected);
      const seen = [fingerprint(first)];
      for (let i = 2; i <= repeat; i++) {
        const again = await scoreTree(t, tree, pristine, join(dir, `score-${name}`), env, join(dir, `${name}-output-${i}.txt`), expected);
        seen.push(fingerprint(again));
      }
      if (new Set(seen).size > 1) r.problems.push(`flaky: the ${name} tree gave different results over ${repeat} runs: ${[...new Set(seen)].join(' | ')}`);
      return first;
    };

    if (t.visible_test_cmd) {
      const v = await visible(repo, 'pristine');
      r.visible = v.ok ? 'pass' : 'fail';
      if (!v.ok) r.problems.push(`visible tests fail on pristine repo:\n${v.tail}`);
    }

    const p = await scoreN('pristine', pristine, null);
    r.pristine = { passed: p.passed, failed: p.failed + p.errored, build_error: p.build_error };
    const pristineFails = p.build_error || p.failed + p.errored > 0 || p.exit_codes.some((c) => c !== 0);
    if (!pristineFails) r.problems.push('hidden tests pass on the untouched repo');

    const refTree = overlaid(t.reference, 'reference');
    const ref = await scoreN('reference', refTree);
    r.reference = { passed: ref.passed, failed: ref.failed + ref.errored, ms: ref.ms };
    const refOk = !ref.build_error && ref.failed + ref.errored === 0 && ref.exit_codes.every((c) => c === 0) && ref.passed > 0;
    if (!refOk) r.problems.push(`reference does not pass: ${ref.passed} passed, ${ref.failed} failed, ${ref.errored} errors, build error ${ref.build_error}; see ${join(dir, 'reference-output.txt')}`);
    if (refOk) {
      if (t.hidden.expected_total === null || opts.update) {
        if (t.hidden.expected_total !== ref.passed) {
          setExpectedTotal(t.id, ref.passed);
          log(`${t.id}: expected_total set to ${ref.passed}`);
        }
        r.expected_total = ref.passed;
      } else if (t.hidden.expected_total !== ref.passed) {
        r.problems.push(`expected_total is ${t.hidden.expected_total} but the reference passes ${ref.passed} (run validate --update if the tests changed)`);
      }
    }
    if (ref.ms > (t.hidden.timeout_s * 1000) / 4) r.problems.push(`hidden tests took ${ref.ms} ms, more than a quarter of timeout_s`);
    if (ref.passed > 0 && p.passed >= ref.passed && !p.build_error) r.problems.push('pristine passes as many tests as the reference');
    if (t.visible_test_cmd) {
      const v = await visible(refTree, 'reference');
      r.visible_reference = v.ok ? 'pass' : 'fail';
      if (!v.ok) r.problems.push(`visible tests fail with the reference, so a correct fix would have to edit them:\n${v.tail}`);
    }

    if (t.naive) {
      const naiveTree = overlaid(t.naive, 'naive');
      const n = await scoreN('naive', naiveTree, r.expected_total);
      r.naive = { passed: n.passed, failed: n.failed + n.errored };
      if (n.pass) r.problems.push('the naive fix passes every hidden test');
      if (!n.build_error && n.failed + n.errored === 0 && n.passed === r.expected_total) r.problems.push('the naive fix fails no hidden test');
      if (t.visible_test_cmd) r.visible_naive = (await visible(naiveTree, 'naive')).ok ? 'pass' : 'fail';
    } else r.naive = 'n/a';

    for (const alt of alternativeNames(t)) {
      const altTree = overlaid(join('hidden', 'alt', alt), `alt-${alt}`);
      const a = await scoreN(`alt-${alt}`, altTree, r.expected_total);
      r.alternatives[alt] = { passed: a.passed, failed: a.failed + a.errored, pass: a.pass };
      if (!a.pass) r.problems.push(`the alternative fix hidden/alt/${alt} is correct but fails hidden tests (${a.passed} passed, ${a.failed + a.errored} failed: ${a.failing.slice(0, 5).join('; ')}); the tests ask for more than the prompt says`);
      if (t.visible_test_cmd) {
        const v = await visible(altTree, `alt-${alt}`);
        if (!v.ok) r.problems.push(`visible tests fail with hidden/alt/${alt}:\n${v.tail}`);
      }
    }

    r.ok = r.problems.length === 0;
    const alts = Object.entries(r.alternatives).map(([k, v]) => `${k} ${v.pass ? 'pass' : 'FAIL'}`);
    log(
      `${t.id}: ${r.ok ? 'ok' : 'PROBLEMS'} (visible ${r.visible}/${r.visible_reference}, pristine ${r.pristine.passed}/${r.pristine.passed + r.pristine.failed}${r.pristine.build_error ? ' build error' : ''}, reference ${r.reference.passed}, naive ${typeof r.naive === 'object' && r.naive ? `${r.naive.passed} passed ${r.naive.failed} failed${r.visible_naive === 'fail' ? ', caught by visible tests' : ''}` : 'n/a'}${alts.length ? `, alt ${alts.join(', ')}` : ''}${repeat > 1 ? `, x${repeat}` : ''})`,
    );
    for (const pr of r.problems) log(`  - ${pr}`);
    if (r.ok) rmSync(dir, { recursive: true, force: true });
  }
  const merged = lastValidation();
  for (const r of results) merged.set(r.id, r);
  writeJson(join(STATE_DIR, 'validate.json'), { at: new Date().toISOString(), results: [...merged.values()] });
  return results;
}

export function lastValidation(): Map<string, ValidateResult> {
  const f = join(STATE_DIR, 'validate.json');
  const out = new Map<string, ValidateResult>();
  if (!existsSync(f)) return out;
  try {
    for (const r of readJson<{ results: ValidateResult[] }>(f).results) out.set(r.id, r);
  } catch {
    /* ignore */
  }
  return out;
}
