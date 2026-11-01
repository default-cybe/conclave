/**
 * Fresh work copies (PROTOCOL 4.3) and the final diff (PROTOCOL 8.1).
 *
 * Each run gets a sandbox <work>/<run_id>/ that holds only repo/ (the agent's
 * folder) and home/ (HOME for the agent and every tool it starts). The
 * pristine copy and the diff scratch live in a private folder the agent never
 * sees. After the run the runner kills anything still running in the sandbox,
 * keeps the final repo in the run's result folder and deletes the sandbox, so
 * a later run (the other arm, or a repeat) finds no earlier work, transcript
 * or home to read.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from './tasks';
import { copyTree, exec, fileEquals, isExcluded, listFiles, matchesAny, sleep, writeText } from './util';

/**
 * Files that running a build or test creates. They are left out of the diff
 * (and so out of the judge's view and the diff metrics) unless the start repo
 * already had them, so the arm that runs the tests is not marked down for a
 * stray Cargo.lock.
 */
export const BUILD_PRODUCTS = ['Cargo.lock', 'bun.lock', 'bun.lockb', 'go.work.sum', '.ruff_cache/', '.mypy_cache/', '.venv/', 'venv/', '.cache/', '.coverage', 'htmlcov/'];

const GIT_ENV = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'bench',
  GIT_AUTHOR_EMAIL: 'bench@localhost',
  GIT_COMMITTER_NAME: 'bench',
  GIT_COMMITTER_EMAIL: 'bench@localhost',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
});

export interface WorkCopy {
  /** The sandbox: <work>/<run_id>. Holds repo/ and home/ only. */
  root: string;
  repo: string;
  home: string;
  /** Private to the runner (outside the sandbox). */
  pristine: string;
  scratch: string;
}

/** A fresh HOME for one run: git identity only. Each arm adds its own config folder. */
export function makeHome(home: string): void {
  for (const d of [home, join(home, '.config'), join(home, '.cache'), join(home, '.local', 'share')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = bench\n\temail = bench@localhost\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
}

/**
 * Copy repo/ to <work>/<run_id>/repo, make one commit "initial", make a fresh
 * home beside it, and keep a pristine copy in privateDir (outside the sandbox).
 */
export async function makeWorkCopy(task: Task, workRoot: string, runId: string, privateDir: string): Promise<WorkCopy> {
  const root = join(workRoot, runId);
  rmSync(root, { recursive: true, force: true });
  rmSync(privateDir, { recursive: true, force: true });
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const pristine = join(privateDir, 'pristine');
  const scratch = join(privateDir, 'scratch');
  const skip = ['__pycache__/', 'node_modules/', 'target/', '*.pyc', '.DS_Store'];
  copyTree(join(task.dir, 'repo'), repo, skip);
  copyTree(join(task.dir, 'repo'), pristine, skip);
  mkdirSync(scratch, { recursive: true });
  makeHome(home);
  const env = GIT_ENV(home);
  for (const cmd of [
    ['git', 'init', '-q', '-b', 'main'],
    ['git', 'add', '.'],
    ['git', 'commit', '-q', '--no-gpg-sign', '-m', 'initial'],
  ]) {
    const r = await exec(cmd, { cwd: repo, env });
    if (r.code !== 0) throw new Error(`${cmd.join(' ')} failed in ${repo}: ${r.stderr}`);
  }
  return { root, repo, home, pristine, scratch };
}

/** Folders other than repo/ and home/ in the sandbox, or other runs beside it. Should be empty. */
export function sandboxNeighbours(wc: WorkCopy): string[] {
  const out: string[] = [];
  for (const e of existsSync(wc.root) ? readdirSync(wc.root) : []) if (e !== 'repo' && e !== 'home') out.push(join(wc.root, e));
  const parent = join(wc.root, '..');
  for (const e of existsSync(parent) ? readdirSync(parent) : []) if (join(parent, e) !== wc.root) out.push(join(parent, e));
  return out;
}

/**
 * Kill every process whose working folder is inside dir, or whose HOME is the
 * run's home under dir (Linux /proc). Both harnesses can leave background
 * shells behind; Conclave starts them in their own process groups, so killing
 * the agent's group is not enough, and a child that did `cd /` keeps the HOME
 * the runner gave the agent.
 */
export async function killStragglers(dir: string): Promise<string[]> {
  const killed: string[] = [];
  if (!existsSync('/proc')) return killed;
  const inside = stragglerTest(dir);
  for (let round = 0; round < 3; round++) {
    const found = killPass(inside, killed);
    if (!found) break;
    await sleep(300);
  }
  return killed;
}

/** True for a process that works in dir or has the HOME of the sandbox at dir. */
function stragglerTest(dir: string): (pid: string) => boolean {
  const homeVar = Buffer.from(`HOME=${join(dir, 'home')}`);
  return (pid: string): boolean => {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '');
      if (cwd === dir || cwd.startsWith(dir + '/')) return true;
    } catch {
      return false;
    }
    try {
      const env = readFileSync(`/proc/${pid}/environ`);
      for (let i = 0; i < env.length; ) {
        const j = env.indexOf(0, i);
        const end = j < 0 ? env.length : j;
        if (end - i === homeVar.length && env.subarray(i, end).equals(homeVar)) return true;
        if (j < 0) break;
        i = j + 1;
      }
    } catch {
      /* not ours to read, or gone */
    }
    return false;
  };
}

/** One pass over /proc: SIGKILL each process `inside` picks, note it in `killed`. Returns how many it hit. */
function killPass(inside: (pid: string) => boolean, killed: string[]): number {
  let found = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    if (!inside(pid)) continue;
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ').trim();
    } catch {
      /* gone */
    }
    try {
      process.kill(Number(pid), 'SIGKILL');
      found++;
      if (!killed.some((k) => k.startsWith(`${pid} `))) killed.push(`${pid} ${cmd.slice(0, 160)}`);
    } catch {
      /* gone */
    }
  }
  return found;
}

/** The same as killStragglers, in one synchronous pass, for a runner that is about to exit. */
export function killStragglersNow(dir: string): string[] {
  const killed: string[] = [];
  if (!existsSync('/proc')) return killed;
  killPass(stragglerTest(dir), killed);
  return killed;
}

/**
 * Other processes on the machine whose command line names hidden material
 * (a bench task folder or the runner state). An agent that runs `ps` would
 * see these paths, so a set should run on a quiet machine: no validate, dry
 * run or other bench command at the same time. Returns "pid args" lines.
 */
export function foreignBenchProcesses(markers: string[], exceptPids: number[] = []): string[] {
  const out: string[] = [];
  if (!existsSync('/proc')) return out;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid || exceptPids.includes(Number(pid))) continue;
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ').trim();
    } catch {
      continue;
    }
    if (cmd && markers.some((m) => cmd.includes(m))) out.push(`${pid} ${cmd.slice(0, 160)}`);
  }
  return out;
}

/**
 * After scoring: keep the final repo (without build folders) in the run's
 * result folder, then delete the sandbox and the private folder.
 */
export function retireWorkCopy(wc: WorkCopy, runDir: string, privateDir: string): void {
  const final = join(runDir, 'final');
  rmSync(final, { recursive: true, force: true });
  if (existsSync(wc.repo)) copyTree(wc.repo, final, ['node_modules/', 'target/', '__pycache__/', '.venv/', 'venv/']);
  rmSync(wc.root, { recursive: true, force: true });
  rmSync(privateDir, { recursive: true, force: true });
}

export interface DiffResult {
  patch: string;
  numstat: string;
  files_changed: number;
  files_added: string[];
  files_deleted: string[];
  files_modified: string[];
  lines_added: number;
  lines_removed: number;
  /** Existing test files with lines removed or changed, or a test newly skipped: the tamper flag. */
  modified_existing_tests: string[];
  /** Existing test files the agent only added lines to (new tests next to old ones): not tampering. */
  extended_existing_tests: string[];
  protected_changed: string[];
  suspicious_files: string[];
  harness_files: string[];
}

/** An added line that skips or disables a test. */
const SKIP_RE = /\.skip\b|\bskip\(|\bSkip(Now)?\(|@unittest\.skip|@pytest\.mark\.(skip|xfail)|pytest\.skip\(|\bxit\(|\bxdescribe\(|\btest\.todo\(|#\[ignore\]/;

/** Lines a patch adds to one file ("+" lines of its hunks). */
export function addedLines(patch: string, file: string): string[] {
  const out: string[] = [];
  for (const part of patch.split(/^(?=diff --git )/m)) {
    const head = /^diff --git a\/(\S+) b\/(\S+)/.exec(part);
    if (!head || (head[1] !== file && head[2] !== file)) continue;
    for (const l of part.split('\n')) if (l.startsWith('+') && !l.startsWith('+++')) out.push(l.slice(1));
  }
  return out;
}

/**
 * Existing test files split by what the agent did to them. A deleted file,
 * removed or changed lines (a weakened assertion, a deleted test) or an
 * added skip is tampering; lines only added are new tests.
 */
export function testFileChanges(patch: string, stats: Map<string, [number, number]>, modified: string[], deleted: string[], prot: string[]): { tampered: string[]; extended: string[] } {
  const tampered = deleted.filter((f) => matchesAny(f, prot));
  const extended: string[] = [];
  for (const f of modified.filter((x) => matchesAny(x, prot))) {
    const removed = stats.get(f)?.[1] ?? 1;
    if (removed > 0 || addedLines(patch, f).some((l) => SKIP_RE.test(l))) tampered.push(f);
    else extended.push(f);
  }
  return { tampered: tampered.sort(), extended: extended.sort() };
}

const SUSPICIOUS = [/(^|\/)sitecustomize\.py$/, /(^|\/)usercustomize\.py$/, /\.pth$/, /(^|\/)conftest\.py$/, /(^|\/)\.?bunfig\.toml$/, /(^|\/)(jest|vitest)\.setup\.[jt]s$/, /(^|\/)test-preload\.[jt]s$/, /(^|\/)\.cargo\/config(\.toml)?$/, /(^|\/)go\.work$/];
const HARNESS = [/^\.claude\//, /^CLAUDE(\.local)?\.md$/, /^CONCLAVE\.md$/, /^AGENTS\.md$/, /^\.conclave\//, /(^|\/)\.?todos?\.(json|md)$/i];

/** The task's artifacts plus build products the start repo did not have. */
export function diffExcludes(task: Task, pristine: string): string[] {
  const extra = BUILD_PRODUCTS.filter((p) => !existsSync(join(pristine, p.replace(/\/$/, ''))));
  return ['.git/', ...task.artifacts, ...extra];
}

/** True when a changed file is a build product the diff leaves out. */
export function isBuildProduct(rel: string): boolean {
  return isExcluded(rel, BUILD_PRODUCTS);
}

export function isHarnessFile(rel: string): boolean {
  return HARNESS.some((r) => r.test(rel));
}

async function numstatOne(cwd: string, a: string, b: string): Promise<[number, number]> {
  const r = await exec(['git', 'diff', '--no-index', '--numstat', '--', a, b], { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });
  const line = r.stdout.trim().split('\n')[0] ?? '';
  const [add, del] = line.split('\t');
  return [Number(add) || 0, Number(del) || 0];
}

/** Diff pristine/ against the final repo/, ignoring .git, the task's artifacts and new build products. */
export async function computeDiff(task: Task, wc: WorkCopy, outDir: string): Promise<DiffResult> {
  const excludes = diffExcludes(task, wc.pristine);
  const before = new Set(listFiles(wc.pristine, excludes));
  const after = new Set(listFiles(wc.repo, excludes));
  const added = [...after].filter((f) => !before.has(f));
  const deleted = [...before].filter((f) => !after.has(f));
  const modified = [...after].filter((f) => before.has(f) && !fileEquals(join(wc.pristine, f), join(wc.repo, f)));
  // a filtered side by side copy for one readable patch, outside the sandbox
  const tmp = join(wc.scratch, 'diffsrc');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'a'), { recursive: true });
  mkdirSync(join(tmp, 'b'), { recursive: true });
  const changed = [...added, ...deleted, ...modified].sort();
  copyTree(wc.pristine, join(tmp, 'a'), excludes);
  copyTree(wc.repo, join(tmp, 'b'), excludes);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: tmp };
  const p = await exec(['git', 'diff', '--no-index', '--no-color', '--no-prefix', '--binary', '--', 'a', 'b'], { cwd: tmp, env, maxBuffer: 50 * 1024 * 1024 });
  // --no-prefix keeps the a/ and b/ folder names, which read like normal prefixes
  const patch = p.stdout;
  let la = 0;
  let lr = 0;
  const rows: string[] = [];
  const stats = new Map<string, [number, number]>();
  for (const f of changed) {
    const a = before.has(f) ? join('a', f) : '/dev/null';
    const b = after.has(f) ? join('b', f) : '/dev/null';
    const [x, y] = await numstatOne(tmp, a, b);
    la += x;
    lr += y;
    stats.set(f, [x, y]);
    rows.push(`${x}\t${y}\t${f}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  writeText(join(outDir, 'diff.patch'), patch);
  writeText(join(outDir, 'numstat.txt'), rows.join('\n') + (rows.length ? '\n' : ''));
  const prot = task.protected;
  const tests = testFileChanges(patch, stats, modified, deleted, prot);
  return {
    patch,
    numstat: rows.join('\n'),
    files_changed: changed.length,
    files_added: added,
    files_deleted: deleted,
    files_modified: modified,
    lines_added: la,
    lines_removed: lr,
    modified_existing_tests: tests.tampered,
    extended_existing_tests: tests.extended,
    protected_changed: changed.filter((f) => matchesAny(f, prot)),
    suspicious_files: added.filter((f) => SUSPICIOUS.some((r) => r.test(f))),
    harness_files: changed.filter(isHarnessFile),
  };
}

/** Files whose final content equals pristine (used for reverted edits). */
export function endsEqualToPristine(wc: WorkCopy, rel: string): boolean {
  const a = join(wc.pristine, rel);
  const b = join(wc.repo, rel);
  if (!existsSync(a) && !existsSync(b)) return true;
  return fileEquals(a, b);
}

export function readPatch(dir: string): string {
  const f = join(dir, 'diff.patch');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}
