/** Hidden test scoring (PROTOCOL 8.2), the four output parsers, and the agent's own tests (PROTOCOL 9). */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Format } from './catalog';
import type { Task } from './tasks';
import { BENCH_DIR, copyTree, exec, fileEquals, globToRegExp, listFiles, matchesAny, writeText } from './util';
// the same reading of a test run as Conclave's regression gate and workflows use
import { testOutcome, type TestOutcome } from '../../packages/core/src/util/test-run';

export interface Parsed {
  passed: number;
  failed: number;
  errored: number;
  build_error: boolean;
  failing: string[];
}

export function parseUnittestJson(out: string): Parsed {
  const lines = out.trim().split('\n').reverse();
  for (const l of lines) {
    if (!l.startsWith('{"unittest_json"')) continue;
    const s = JSON.parse(l).unittest_json;
    return { passed: s.passed, failed: s.failed, errored: s.errored, build_error: s.total === 0 && s.load_errors > 0, failing: s.failing ?? [] };
  }
  return { passed: 0, failed: 0, errored: 0, build_error: true, failing: [] };
}

export function parseBun(out: string): Parsed {
  // the summary is the last block; the code under test may print look-alike lines on stdout before it
  const last = (re: RegExp) => [...out.matchAll(re)].at(-1) ?? null;
  const pass = last(/^\s*(\d+) pass\b/gm);
  const fail = last(/^\s*(\d+) fail\b/gm);
  const err = last(/^\s*(\d+) errors?\b/gm);
  const failing = [...out.matchAll(/^\(fail\) (.+?)(?: \[\d+(?:\.\d+)?m?s\])?$/gm)].map((m) => m[1]);
  if (!pass && !fail) return { passed: 0, failed: 0, errored: 0, build_error: true, failing };
  const passed = pass ? Number(pass[1]) : 0;
  const failed = fail ? Number(fail[1]) : 0;
  const errored = err ? Number(err[1]) : 0;
  return { passed, failed, errored, build_error: passed + failed === 0 && errored > 0, failing };
}

export function parseGoJson(out: string): Parsed {
  const final = new Map<string, string>();
  let buildFailed = false;
  for (const line of out.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) {
      if (/\[build failed\]|\[setup failed\]|^# /.test(l)) buildFailed = true;
      continue;
    }
    let ev: { Action?: string; Test?: string; Package?: string; Output?: string };
    try {
      ev = JSON.parse(l);
    } catch {
      continue;
    }
    if (ev.Action === 'build-fail' || (ev.Output && /\[build failed\]|\[setup failed\]/.test(ev.Output))) buildFailed = true;
    if (!ev.Test) continue;
    if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') final.set(`${ev.Package}::${ev.Test}`, ev.Action);
  }
  const names = [...final.keys()];
  const leaves = names.filter((n) => !names.some((m) => m !== n && m.startsWith(n + '/')));
  let passed = 0;
  let failed = 0;
  const failing: string[] = [];
  for (const n of leaves) {
    const a = final.get(n);
    if (a === 'pass') passed++;
    else if (a === 'fail') {
      failed++;
      failing.push(n.split('::')[1]);
    }
  }
  return { passed, failed, errored: 0, build_error: buildFailed && leaves.length === 0, failing };
}

export function parseCargo(out: string): Parsed {
  let passed = 0;
  let failed = 0;
  const failing: string[] = [];
  for (const m of out.matchAll(/^test (.+?) \.\.\. (ok|FAILED|ignored)$/gm)) {
    if (m[2] === 'ok') passed++;
    else if (m[2] === 'FAILED') {
      failed++;
      failing.push(m[1]);
    }
  }
  const buildError = passed + failed === 0 && /error(\[E\d+\])?:|could not compile/.test(out);
  return { passed, failed, errored: 0, build_error: buildError || (passed + failed === 0 && !/test result:/.test(out)), failing };
}

export function parse(format: Format, out: string): Parsed {
  switch (format) {
    case 'unittest-json':
      return parseUnittestJson(out);
    case 'bun':
      return parseBun(out);
    case 'go-json':
      return parseGoJson(out);
    case 'cargo':
      return parseCargo(out);
  }
}

export interface TestScore {
  passed: number;
  failed: number;
  errored: number;
  expected_total: number | null;
  partial: number | null;
  pass: boolean;
  build_error: boolean;
  exit_codes: Array<number | null>;
  timed_out: boolean;
  failing: string[];
  ms: number;
  moved_aside: string[];
  restored: string[];
  /** Links in the final tree that led outside it, or sat on a path the scorer writes; removed before scoring. */
  links_removed: string[];
  /** Hidden test files the test command did not run (the agent pointed the target elsewhere). */
  not_run: string[];
  /** Agent files that sat at a hidden test's path, moved to .bench-moved/ instead of being overwritten. */
  shadowed: string[];
}

/**
 * Remove every symlink in root that resolves outside root. The scorer writes,
 * restores and deletes paths in this copy, so a link left by the agent
 * (tests -> /somewhere) would make it write hidden tests outside, or delete
 * outside folders.
 */
export function dropOutsideLinks(root: string): string[] {
  const top = realpathSync(root);
  const within = (p: string) => p === top || p.startsWith(top + sep);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          real = resolve(realpathSync(d), readlinkSync(abs)); // dangling: judge by where it points
        }
        if (!within(real)) {
          unlinkSync(abs);
          out.push(relative(root, abs).split(sep).join('/'));
        }
      } else if (ent.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out;
}

/** Make every folder on the way to rel a real folder (a link inside the copy is replaced), and the leaf not a link. */
function realPath(root: string, rel: string, removed: string[]): void {
  const parts = rel.replace(/\/+$/, '').split('/');
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    const abs = join(root, sub);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return; // the rest does not exist yet
    }
    if (st.isSymbolicLink()) {
      unlinkSync(abs);
      removed.push(sub);
      return;
    }
  }
}

/** Hidden test files the output shows were not run: cargo names each test file it runs, bun prints each file it loads. */
export function notRun(format: Format, out: string, targets: string[]): string[] {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // only when the tests ran at all; a build error is reported as one
  if (format === 'cargo' && /^\s*Running /m.test(out)) return targets.filter((t) => /^tests\/[^/]+\.rs$/.test(t) && !new RegExp(`^\\s*Running ${esc(t)} \\(`, 'm').test(out));
  if (format === 'bun' && /^\s*\d+ (pass|fail)\b/m.test(out)) return targets.filter((t) => /\.(test|spec)\.[jt]sx?$/.test(t) && !new RegExp(`^${esc(t)}:$`, 'm').test(out));
  return [];
}

/**
 * Tool config in the repo that changes how the hidden tests run: a cargo test
 * runner or rustflags, a Go workspace, a Bun preload. Restored from pristine
 * (or deleted) before every scoring run, for every task, like hidden.restore.
 */
export const TOOL_CONFIG = ['.cargo/config.toml', '.cargo/config', 'go.work', 'bunfig.toml', '.bunfig.toml'];

export function expand(cmd: string): string {
  return cmd.replaceAll('{bench}', BENCH_DIR);
}

/**
 * Score a final tree: copy it to <scoreDir>, restore config, move stray files
 * aside, copy the hidden tests in and run them.
 */
export async function scoreTree(task: Task, finalTree: string, pristine: string, scoreDir: string, env: Record<string, string>, outFile?: string, expectedOverride?: number | null): Promise<TestScore> {
  rmSync(scoreDir, { recursive: true, force: true });
  copyTree(finalTree, scoreDir, ['.git/', ...task.artifacts]);
  const h = task.hidden;
  // no write or delete below may follow a link the agent left
  const links = dropOutsideLinks(scoreDir);
  const restore = [...h.restore, ...TOOL_CONFIG.filter((x) => !h.restore.includes(x))];
  for (const rel of [...restore, ...(h.clear ?? []), ...Object.values(h.files)]) realPath(scoreDir, rel, links);
  const restored: string[] = [];
  for (const rel of restore) {
    const src = join(pristine, rel);
    const dst = join(scoreDir, rel);
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst);
      restored.push(rel);
    } else if (existsSync(dst)) {
      rmSync(dst, { force: true });
      restored.push(`${rel} (deleted)`);
    }
  }
  const targets = new Set(Object.values(h.files));
  const pristineFiles = new Set(listFiles(pristine));
  const moved: string[] = [];
  if (h.move_aside.length) {
    for (const rel of listFiles(scoreDir)) {
      if (pristineFiles.has(rel) || targets.has(rel)) continue;
      const name = rel.split('/').pop()!;
      if (!h.move_aside.some((g) => globToRegExp(g).test(rel) || globToRegExp(g).test(name))) continue;
      const to = join(scoreDir, '.bench-moved', rel);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(join(scoreDir, rel), to);
      moved.push(rel);
    }
  }
  // an agent file at a hidden test's path (its own forth_test.go) is kept aside, not overwritten unseen
  const shadowed: string[] = [];
  for (const to of Object.values(h.files)) {
    const dst = join(scoreDir, to);
    if (!existsSync(dst) || lstatSync(dst).isDirectory()) continue;
    const orig = join(pristine, to);
    if (existsSync(orig) && fileEquals(orig, dst)) continue;
    const aside = join(scoreDir, '.bench-moved', to);
    mkdirSync(dirname(aside), { recursive: true });
    rmSync(aside, { recursive: true, force: true });
    renameSync(dst, aside);
    shadowed.push(to);
  }
  for (const d of h.clear ?? []) rmSync(join(scoreDir, d), { recursive: true, force: true });
  for (const [from, to] of Object.entries(h.files)) {
    const dst = join(scoreDir, to);
    mkdirSync(dirname(dst), { recursive: true });
    rmSync(dst, { recursive: true, force: true });
    cpSync(join(task.dir, from), dst);
  }
  const notRunAll: string[] = [];
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let buildError = false;
  let timedOut = false;
  const failing: string[] = [];
  const codes: Array<number | null> = [];
  let log = '';
  const started = Date.now();
  for (const run of h.runs) {
    const cmd = expand(run.cmd);
    const r = await exec(['bash', '-c', cmd], { cwd: scoreDir, env: { ...env, ...run.env }, timeoutMs: h.timeout_s * 1000 });
    const out = r.stdout + '\n' + r.stderr;
    log += `$ ${Object.entries(run.env).map(([k, v]) => `${k}=${v} `).join('')}${cmd}\n# exit ${r.code}${r.timedOut ? ' (timed out)' : ''} in ${r.ms} ms\n${out}\n`;
    const p = parse(run.format, run.format === 'unittest-json' ? r.stdout + '\n' + r.stderr : out);
    const missing = r.timedOut ? [] : notRun(run.format, out, Object.values(h.files));
    if (missing.length) {
      notRunAll.push(...missing);
      p.build_error = true; // counts as 0 passed, like a build error
      log += `# hidden test files that did not run: ${missing.join(', ')}\n`;
    }
    passed += p.passed;
    failed += p.failed;
    errored += p.errored;
    buildError ||= p.build_error;
    timedOut ||= r.timedOut;
    failing.push(...p.failing.map((f) => (h.runs.length > 1 ? `${Object.values(run.env).join(',')}: ${f}` : f)));
    codes.push(r.code);
  }
  if (moved.length) log += `# moved aside before the run: ${moved.join(', ')}\n`;
  if (restored.length) log += `# restored from pristine: ${restored.join(', ')}\n`;
  if (links.length) log += `# links removed before the run: ${links.join(', ')}\n`;
  if (outFile) writeText(outFile, log);
  const expected = expectedOverride !== undefined ? expectedOverride : h.expected_total;
  const scoredPassed = buildError ? 0 : passed;
  const allOk = codes.every((c) => c === 0) && !timedOut;
  const pass = !buildError && allOk && failed === 0 && errored === 0 && expected !== null && scoredPassed === expected;
  return {
    passed: scoredPassed,
    failed,
    errored,
    expected_total: expected,
    partial: expected ? Math.min(1, scoredPassed / expected) : null,
    pass,
    build_error: buildError,
    exit_codes: codes,
    timed_out: timedOut,
    failing: failing.slice(0, 100),
    ms: Date.now() - started,
    moved_aside: moved,
    shadowed,
    restored,
    links_removed: links,
    not_run: [...new Set(notRunAll)],
  };
}

/** One run of the visible test command for the own-test metric. */
export interface OwnTestRun {
  /** failed, passed, or not_run (the run says nothing), by the shared rules (packages/core/src/util/test-run.ts). */
  outcome: TestOutcome;
  why: string;
  exit_code: number | null;
  timed_out: boolean;
  ms: number;
}

/** The agent's own tests (PROTOCOL 9 own_tests). */
export interface OwnTests {
  /** Test code the agent added or changed under the task's protected globs. */
  files: string[];
  /** Its tests fail on the start code; null when that run said nothing. */
  fails_on_start: boolean | null;
  /** The visible tests pass on the final code; null when that run said nothing. */
  passes_on_final: boolean | null;
  start: OwnTestRun;
  final: OwnTestRun;
}

/** Test code: the protected globs also hold config (package.json, bunfig.toml) that is not a test. */
const OWN_TEST_CODE = /\.(py|[cm]?[jt]sx?)$/;
const OWN_TEST_TIMEOUT_MS = 60_000;

/** The test files the agent added or changed under the task's protected globs (links left out). */
export function ownTestFiles(task: Task, finalTree: string, pristine: string): string[] {
  return listFiles(finalTree, ['.git/', '.bench-moved/', ...task.artifacts]).filter((rel) => {
    if (!matchesAny(rel, task.protected) || !OWN_TEST_CODE.test(rel)) return false;
    if (lstatSync(join(finalTree, rel)).isSymbolicLink()) return false;
    return !fileEquals(join(pristine, rel), join(finalTree, rel));
  });
}

async function runVisible(task: Task, dir: string, env: Record<string, string>): Promise<{ run: OwnTestRun; log: string }> {
  const cmd = expand(task.visible_test_cmd!);
  const r = await exec(['bash', '-c', cmd], { cwd: dir, env, timeoutMs: OWN_TEST_TIMEOUT_MS });
  const out = `${r.stdout}\n${r.stderr}`;
  const tail = out.replace(/\s+$/, '').split('\n').slice(-60).join('\n');
  const o = testOutcome({ ok: r.code === 0 && !r.timedOut, exitCode: r.code, timedOut: r.timedOut, tail });
  return { run: { outcome: o.outcome, why: o.why, exit_code: r.code, timed_out: r.timedOut, ms: r.ms }, log: `$ ${cmd}\n# exit ${r.code}${r.timedOut ? ' (timed out)' : ''} in ${r.ms} ms: ${o.outcome} (${o.why})\n${out}\n` };
}

/**
 * Whether the agent's own tests show its change (PROTOCOL 9 own_tests): its
 * changed test files under the task's protected globs go over the pristine
 * start tree and the task's visible test command runs there; then the same
 * command runs on the final tree. The visible suite passes on the start tree
 * (validate checks it), so a failure there comes from the agent's tests. A
 * test file the command does not run cannot fail. Null when the task has no
 * visible test command or the agent changed no test file.
 */
export async function ownTestsCheck(task: Task, finalTree: string, pristine: string, scratch: string, env: Record<string, string>, outFile?: string): Promise<OwnTests | null> {
  if (!task.visible_test_cmd || !existsSync(finalTree)) return null;
  const files = ownTestFiles(task, finalTree, pristine);
  if (!files.length) return null;
  const startDir = join(scratch, 'own-start');
  const finalDir = join(scratch, 'own-final');
  rmSync(scratch, { recursive: true, force: true });
  copyTree(pristine, startDir, ['.git/']);
  for (const rel of files) {
    mkdirSync(dirname(join(startDir, rel)), { recursive: true });
    cpSync(join(finalTree, rel), join(startDir, rel));
  }
  // the final tree with the scorer's guards: no links out, tool config back from pristine
  copyTree(finalTree, finalDir, ['.git/', '.bench-moved/', ...task.artifacts]);
  const links = dropOutsideLinks(finalDir);
  for (const rel of [...task.hidden.restore, ...TOOL_CONFIG.filter((x) => !task.hidden.restore.includes(x))]) {
    realPath(finalDir, rel, links);
    const dst = join(finalDir, rel);
    rmSync(dst, { recursive: true, force: true });
    if (existsSync(join(pristine, rel))) cpSync(join(pristine, rel), dst);
  }
  try {
    const start = await runVisible(task, startDir, env);
    const final = await runVisible(task, finalDir, env);
    if (outFile) writeText(outFile, `# the agent's test files over the start tree: ${files.join(', ')}\n${start.log}\n# the final tree\n${final.log}`);
    const tri = (o: TestOutcome, yes: TestOutcome) => (o === 'not_run' ? null : o === yes);
    return { files, fails_on_start: tri(start.run.outcome, 'failed'), passes_on_final: tri(final.run.outcome, 'passed'), start: start.run, final: final.run };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
