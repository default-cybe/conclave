/** Task loading, building (fixtures and vendored exercises), overlays and the shared prompt. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CATALOG, POLYGLOT_COMMIT, SKILL_CATALOG, taskJson, type CatalogEntry, type HiddenRun } from './catalog';
import { BENCH_DIR, copyTree, listFiles, log, readJson, writeJson } from './util';

export interface Task {
  id: string;
  title: string;
  kind: 'polyglot' | 'bug' | 'feature' | 'skill';
  lang: string;
  difficulty: 'easy' | 'medium' | 'hard';
  time_limit_s: number;
  smoke: boolean;
  requires: string[];
  source: Record<string, unknown>;
  visible_test_cmd: string | null;
  hidden: {
    files: Record<string, string>;
    clear: string[];
    runs: HiddenRun[];
    timeout_s: number;
    expected_total: number | null;
    restore: string[];
    move_aside: string[];
  };
  protected: string[];
  artifacts: string[];
  reference: string;
  naive: string | null;
  license: unknown;
  /** Absolute task folder (not in task.json). */
  dir: string;
}

export const TASKS_DIR = join(BENCH_DIR, 'tasks');
export const FIXTURES_DIR = join(BENCH_DIR, 'fixtures');

export function loadTask(id: string): Task {
  const dir = join(TASKS_DIR, id);
  const t = readJson<Task>(join(dir, 'task.json'));
  return { ...t, dir };
}

export function allTaskIds(): string[] {
  return CATALOG.map((e) => e.id);
}

/** Tasks that need a hub skill; not in `all`, selected with `skills` or by id. */
export function skillTaskIds(): string[] {
  return SKILL_CATALOG.map((e) => e.id);
}

export function loadTasks(sel?: string): Task[] {
  const ids = allTaskIds();
  if (!sel || sel === 'all') return ids.map(loadTask);
  if (sel === 'smoke') return ids.map(loadTask).filter((t) => t.smoke);
  const known = [...ids, ...skillTaskIds()];
  const want: string[] = [];
  for (const w of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
    const add = w === 'smoke' ? ids.filter((id) => loadTask(id).smoke) : w === 'all' ? ids : w === 'skills' ? skillTaskIds() : [w];
    for (const id of add) {
      if (!known.includes(id)) throw new Error(`unknown task: ${id}`);
      if (!want.includes(id)) want.push(id);
    }
  }
  return want.map(loadTask);
}

/** The exact text both arms get (PROTOCOL section 6). */
export function wrapPrompt(taskText: string): string {
  return [
    'You are working in the repository in the current directory.',
    '',
    taskText.trim(),
    '',
    'Rules for this task:',
    '- Work only inside this directory. You do not need the network.',
    '- Hidden tests will check your work after you finish. They are not in this directory. You may write and run your own tests.',
    '- Nobody will answer questions. If something is unclear, make a reasonable choice and say what you chose.',
    '- End your reply with one line, exactly "RESULT: DONE" or "RESULT: NOT DONE", then one sentence on how you checked your work.',
  ].join('\n');
}

export function taskPrompt(t: Task): string {
  return wrapPrompt(readFileSync(join(t.dir, 'prompt.md'), 'utf8'));
}

/** Copy an overlay folder's files over a target folder. */
export function applyOverlay(overlayDir: string, target: string): string[] {
  const files = listFiles(overlayDir);
  for (const rel of files) {
    const to = join(target, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(overlayDir, rel), to);
  }
  return files;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function existingExpected(id: string): number | null {
  const f = join(TASKS_DIR, id, 'task.json');
  if (!existsSync(f)) return null;
  try {
    return readJson(f).hidden?.expected_total ?? null;
  } catch {
    return null;
  }
}

function buildFixtureTask(e: CatalogEntry): void {
  const dir = join(TASKS_DIR, e.id);
  const repo = join(dir, 'repo');
  rmSync(repo, { recursive: true, force: true });
  copyTree(join(FIXTURES_DIR, e.base!), repo, ['node_modules/', '__pycache__/', '*.pyc', 'tasksd.db']);
  if (e.overlay) applyOverlay(join(dir, 'overlay'), repo);
}

interface ExerciseConfig {
  files: { solution: string[]; test: string[]; example: string[]; editor?: string[]; invalidator?: string[] };
}

/** The section `build` adds to a polyglot prompt for facts the hidden tests need (CatalogEntry.notes). */
export function notesBlock(notes: string): string {
  return `## Notes for this task\n\n${notes.trim()}`;
}

const PG_LINE = (files: string[]) =>
  `Use the instructions above to change these files: ${files.join(', ')}. Keep the names of existing functions, classes and types, because the tests use them. Use only the standard library. Do not install packages.`;

function vendorExercise(e: CatalogEntry, polyglotDir: string): void {
  const [track, name] = e.exercise!.split('/');
  const src = join(polyglotDir, track, 'exercises', 'practice', name);
  if (!existsSync(src)) throw new Error(`exercise not found: ${src}`);
  const cfg = readJson<ExerciseConfig>(join(src, '.meta', 'config.json'));
  const dir = join(TASKS_DIR, e.id);
  const repo = join(dir, 'repo');
  rmSync(repo, { recursive: true, force: true });
  rmSync(join(dir, 'hidden'), { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const copy = (rel: string, toRoot: string, toRel = rel) => {
    const to = join(toRoot, toRel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(src, rel), to);
  };
  for (const f of cfg.files.solution) copy(f, repo);
  for (const f of cfg.files.editor ?? []) copy(f, repo);
  for (const f of cfg.files.invalidator ?? []) if (existsSync(join(src, f))) copy(f, repo);
  if (track === 'javascript') {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'bun test' } }, null, 2) + '\n');
    if (existsSync(join(src, 'LICENSE'))) copy('LICENSE', repo);
  }
  // hidden tests (JS: xtest -> test so every test runs)
  for (const f of cfg.files.test) {
    const to = join(dir, 'hidden', 'tests', f.split('/').pop()!);
    mkdirSync(dirname(to), { recursive: true });
    let text = readFileSync(join(src, f), 'utf8');
    if (track === 'javascript') text = text.replace(/\bxtest\(/g, 'test(').replace(/\bxit\(/g, 'it(').replace(/\bxdescribe\(/g, 'describe(');
    writeFileSync(to, text);
  }
  // reference: the example solution at the solution path
  const solutionCode = cfg.files.solution.find((f) => !/Cargo\.toml$|package\.json$/.test(f))!;
  copy(cfg.files.example[0], join(dir, 'hidden', 'reference'), solutionCode);
  // prompt
  let text = readFileSync(join(src, '.docs', 'instructions.md'), 'utf8').trim();
  const append = join(src, '.docs', 'instructions.append.md');
  if (existsSync(append)) text += '\n\n' + readFileSync(append, 'utf8').trim();
  if (e.notes) text += '\n\n' + notesBlock(e.notes);
  text += '\n\n' + PG_LINE(cfg.files.solution);
  writeFileSync(join(dir, 'prompt.md'), text + '\n');
  writeFileSync(
    join(dir, 'NOTICE'),
    [
      `This task is the Exercism exercise "${name}" from the ${track} track,`,
      `as collected in the Aider polyglot benchmark (https://github.com/Aider-AI/polyglot-benchmark),`,
      `commit ${POLYGLOT_COMMIT}, folder ${track}/exercises/practice/${name}.`,
      '',
      'Exercise content is copyright (c) Exercism and is used under the MIT license.',
      'See bench/third_party/EXERCISM-LICENSE.md for the license text.',
      '',
      'Changes for this benchmark: the test files moved to hidden/tests, the example',
      'solution moved to hidden/reference, the prompt is built from .docs, and for',
      'JavaScript the package.json is replaced and xtest is changed to test.',
      '',
    ].join('\n'),
  );
}

export function buildTasks(opts: { polyglot?: string; only?: string[] } = {}): void {
  for (const e of [...CATALOG, ...SKILL_CATALOG]) {
    if (opts.only && !opts.only.includes(e.id)) continue;
    const dir = join(TASKS_DIR, e.id);
    mkdirSync(dir, { recursive: true });
    if (e.kind === 'skill') {
      if (!existsSync(join(dir, 'repo'))) throw new Error(`${e.id}: repo/ is missing; skill tasks keep a hand-written repo/.`);
    } else if (e.kind === 'polyglot') {
      if (opts.polyglot) {
        vendorExercise(e, opts.polyglot);
        log(`vendored ${e.id} from ${opts.polyglot}`);
      } else if (!existsSync(join(dir, 'repo'))) {
        throw new Error(`${e.id}: repo/ is missing. Run \`bench build --polyglot <clone of polyglot-benchmark>\` once.`);
      }
    } else {
      buildFixtureTask(e);
    }
    writeJson(join(dir, 'task.json'), taskJson(e, existingExpected(e.id)));
  }
}

/** Seeded tasks are rebuilt from their fixture before use so repo/ never drifts. */
export function refreshFixtureTasks(tasks: Task[]): void {
  for (const t of tasks) {
    const e = CATALOG.find((c) => c.id === t.id);
    if (e && e.kind !== 'polyglot' && e.kind !== 'skill') buildFixtureTask(e);
  }
}

export function setExpectedTotal(id: string, n: number): void {
  const f = join(TASKS_DIR, id, 'task.json');
  const t = readJson(f);
  t.hidden.expected_total = n;
  writeJson(f, t);
}
